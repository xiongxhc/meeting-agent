import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// @ts-expect-error Test-only JavaScript staging module has no public declaration.
import { PYTHON } from "./stage.mjs";
// @ts-expect-error Test-only JavaScript TeamMem module has no public declaration.
import { stageTeamMem } from "./teammem.mjs";

async function helpers() {
  // @ts-expect-error Test-only JavaScript wheelhouse module has no public declaration.
  const module = await import("./python-wheelhouse.mjs").catch(() => null);
  assert.ok(module, "private wheelhouse helpers must exist");
  return module;
}

function fixture(t: { after: (cleanup: () => void) => void }) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "teammem-wheelhouse-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const body = path.join(root, "opaque.body");
  const make = (name = "Example-Package", version = "1.2.3", tag = "py3-none-any") => {
    const result = spawnSync(PYTHON, ["-c", `import sys, zipfile
name, version, tag = sys.argv[2:]
root = name.replace('-', '_') + '-' + version + '.dist-info/'
with zipfile.ZipFile(sys.argv[1], 'w') as wheel:
    wheel.writestr(root + 'METADATA', 'Metadata-Version: 2.1\\nName: ' + name + '\\nVersion: ' + version + '\\n')
    wheel.writestr(root + 'WHEEL', 'Wheel-Version: 1.0\\nTag: ' + tag + '\\n')
`, body, name, version, tag], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return body;
  };
  return { root, body, make, destination: path.join(root, "private wheels") };
}

test("opaque wheel bodies become sanitized private filenames with exact hashes", async (t) => {
  const f = fixture(t);
  f.make();
  const { createDependencyWheelhouse, validateDependencyWheelhouse } = await helpers();
  const result = await createDependencyWheelhouse({ wheelBodies: [f.body], destination: f.destination });
  const expectedName = "example_package-1.2.3-py3-none-any.whl";
  assert.equal(result.path, f.destination);
  assert.deepEqual(readdirSync(f.destination).sort(), [expectedName, "manifest.json"]);
  assert.deepEqual(readFileSync(path.join(f.destination, expectedName)), readFileSync(f.body));
  assert.equal(result.wheels[0].sha256, createHash("sha256").update(readFileSync(f.body)).digest("hex"));
  assert.deepEqual(await validateDependencyWheelhouse(f.destination), result);
});

test("vendored distribution metadata does not replace the wheel root identity", async (t) => {
  const f = fixture(t);
  f.make("setuptools", "80.9.0");
  const added = spawnSync(PYTHON, ["-c", `import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'a') as wheel:
    wheel.writestr('setuptools/_vendor/other-1.0.dist-info/METADATA', 'Name: other\\nVersion: 1.0\\n')
    wheel.writestr('setuptools/_vendor/other-1.0.dist-info/WHEEL', 'Tag: py3-none-any\\n')
`, f.body], { encoding: "utf8" });
  assert.equal(added.status, 0, added.stderr);
  const { createDependencyWheelhouse } = await helpers();
  const result = await createDependencyWheelhouse({ wheelBodies: [f.body], destination: f.destination });
  assert.equal(result.wheels[0].filename, "setuptools-80.9.0-py3-none-any.whl");
});

test("wheel root identity must match the embedded package metadata", async (t) => {
  const f = fixture(t);
  f.make();
  const changed = spawnSync(PYTHON, ["-c", `import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as original:
    entries = [(n, original.read(n)) for n in original.namelist()]
with zipfile.ZipFile(sys.argv[1], 'w') as wheel:
    for name, data in entries:
        if name.endswith('/METADATA'):
            data = data.replace(b'Name: Example-Package', b'Name: different')
        wheel.writestr(name, data)
`, f.body], { encoding: "utf8" });
  assert.equal(changed.status, 0, changed.stderr);
  const { createDependencyWheelhouse } = await helpers();
  await assert.rejects(createDependencyWheelhouse({ wheelBodies: [f.body], destination: f.destination }), /identity/);
});

test("malformed ZIP, duplicate distribution, unsafe metadata and relative paths fail closed", async (t) => {
  const f = fixture(t);
  const { createDependencyWheelhouse, validateDependencyWheelhouse } = await helpers();
  await assert.rejects(validateDependencyWheelhouse("relative"), /absolute/);
  await assert.rejects(createDependencyWheelhouse({ wheelBodies: [f.body], destination: "relative" }), /absolute/);
  writeFileSync(f.body, "not a wheel");
  await assert.rejects(createDependencyWheelhouse({ wheelBodies: [f.body], destination: f.destination }), /wheel|ZIP/i);
  f.make();
  await assert.rejects(createDependencyWheelhouse({ wheelBodies: [f.body, f.body], destination: f.destination }), /duplicate/);
  f.make("../escape");
  await assert.rejects(createDependencyWheelhouse({ wheelBodies: [f.body], destination: f.destination }), /unsafe|invalid/i);
  assert.deepEqual(readdirSync(f.root), ["opaque.body"]);
});

test("modified wheel bytes and hash manifest tampering are rejected", async (t) => {
  const f = fixture(t);
  f.make();
  const { createDependencyWheelhouse, validateDependencyWheelhouse } = await helpers();
  const result = await createDependencyWheelhouse({ wheelBodies: [f.body], destination: f.destination });
  const wheelPath = path.join(f.destination, result.wheels[0].filename);
  writeFileSync(wheelPath, "tampered");
  await assert.rejects(validateDependencyWheelhouse(f.destination), /hash|bytes/);
  writeFileSync(wheelPath, readFileSync(f.body));
  const manifestPath = path.join(f.destination, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const originalHash = manifest.wheels[0].sha256;
  manifest.wheels[0].sha256 = "0".repeat(64);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await assert.rejects(validateDependencyWheelhouse(f.destination), /hash/);
  manifest.wheels[0].sha256 = originalHash;
  manifest.wheels[0].filename = "../opaque.body";
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await assert.rejects(validateDependencyWheelhouse(f.destination), /filename|manifest/);
});

test("unlisted files, duplicate manifest entries and symlink wheels are rejected", async (t) => {
  const f = fixture(t);
  f.make();
  const { createDependencyWheelhouse, validateDependencyWheelhouse } = await helpers();
  const result = await createDependencyWheelhouse({ wheelBodies: [f.body], destination: f.destination });
  const manifestPath = path.join(f.destination, "manifest.json");
  const original = readFileSync(manifestPath);
  writeFileSync(path.join(f.destination, "extra.whl"), "unlisted");
  await assert.rejects(validateDependencyWheelhouse(f.destination), /unlisted|contents/);
  rmSync(path.join(f.destination, "extra.whl"));
  const manifest = JSON.parse(original.toString());
  manifest.wheels.push(manifest.wheels[0]);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await assert.rejects(validateDependencyWheelhouse(f.destination), /duplicate/);
  writeFileSync(manifestPath, original);
  const wheelPath = path.join(f.destination, result.wheels[0].filename);
  rmSync(wheelPath);
  symlinkSync(f.body, wheelPath);
  await assert.rejects(validateDependencyWheelhouse(f.destination), /regular|symlink/);
});

test("offline pip contract uses only validated wheelhouse and disables ambient configuration", async (t) => {
  const f = fixture(t);
  f.make();
  const { createDependencyWheelhouse, teamMemDependencyOptions } = await helpers();
  await createDependencyWheelhouse({ wheelBodies: [f.body], destination: f.destination });
  const options = await teamMemDependencyOptions(f.destination);
  assert.deepEqual(options.argv, ["--no-index", "--find-links", f.destination, "--no-cache-dir", "--disable-pip-version-check"]);
  assert.deepEqual(options.options.env, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C.UTF-8", PIP_CONFIG_FILE: "/dev/null" });
  assert.deepEqual(await teamMemDependencyOptions(), { argv: [], options: {} });
});

test("TeamMem staging rejects invalid wheelhouse before source archive or venv side effects", async (t) => {
  const f = fixture(t);
  chmodSync(f.root, 0o700);
  await assert.rejects(stageTeamMem({ staged: { directories: { teammem: path.join(f.root, "stage") } }, source: {}, dependencyWheelhouse: "relative" }), /absolute/);
  assert.deepEqual(readdirSync(f.root), []);
});

test("caller wheelhouses with group or world writable access are refused", async (t) => {
  const f = fixture(t);
  f.make();
  const { createDependencyWheelhouse, validateDependencyWheelhouse } = await helpers();
  await createDependencyWheelhouse({ wheelBodies: [f.body], destination: f.destination });
  for (const mode of [0o770, 0o777]) {
    chmodSync(f.destination, mode);
    await assert.rejects(validateDependencyWheelhouse(f.destination), /0700|private/);
  }
});

test("pip uses an owned private snapshot immune to changes in the caller wheelhouse", async (t) => {
  const f = fixture(t);
  f.make();
  const { createDependencyWheelhouse, snapshotDependencyWheelhouse, teamMemDependencyOptions } = await helpers();
  assert.equal(typeof snapshotDependencyWheelhouse, "function", "private snapshot helper must exist");
  const original = await createDependencyWheelhouse({ wheelBodies: [f.body], destination: f.destination });
  const snapshot = await snapshotDependencyWheelhouse({ dependencyWheelhouse: f.destination, privateRoot: f.root });
  assert.equal(path.dirname(snapshot.path), f.root);
  assert.notEqual(snapshot.path, f.destination);
  assert.deepEqual(snapshot.wheels, original.wheels);
  writeFileSync(path.join(f.destination, original.wheels[0].filename), "modified after copy");
  writeFileSync(path.join(f.destination, "unlisted.whl"), "added after copy");
  const options = await teamMemDependencyOptions(snapshot.path);
  assert.equal(options.argv[2], snapshot.path);
  assert.deepEqual(readFileSync(path.join(snapshot.path, original.wheels[0].filename)), readFileSync(f.body));
  writeFileSync(path.join(snapshot.path, "unlisted.whl"), "injected between pip steps");
  await assert.rejects(teamMemDependencyOptions(snapshot.path), /unlisted|contents/);
  rmSync(path.join(snapshot.path, "unlisted.whl"));
  writeFileSync(path.join(snapshot.path, original.wheels[0].filename), "tampered between pip steps");
  await assert.rejects(teamMemDependencyOptions(snapshot.path), /hash|bytes/);
});

test("snapshot refuses a staging root beneath a writable non-sticky ancestor", async (t) => {
  const f = fixture(t);
  f.make();
  const { createDependencyWheelhouse, snapshotDependencyWheelhouse } = await helpers();
  assert.equal(typeof snapshotDependencyWheelhouse, "function", "private snapshot helper must exist");
  await createDependencyWheelhouse({ wheelBodies: [f.body], destination: f.destination });
  const privateRoot = path.join(f.root, "stage");
  mkdirSync(privateRoot, { mode: 0o700 });
  chmodSync(f.root, 0o777);
  await assert.rejects(snapshotDependencyWheelhouse({ dependencyWheelhouse: f.destination, privateRoot }), /ancestor/);
  assert.deepEqual(readdirSync(privateRoot), []);
});

test("source archive treats shell metacharacters in repository paths as literal bytes", async (t) => {
  const f = fixture(t);
  const marker = path.join(f.root, "injected-by-shell");
  const repository = path.join(f.root, `repository $(touch ${marker})`);
  const sourceDir = path.join(f.root, "extracted source");
  mkdirSync(repository, { recursive: true, mode: 0o700 });
  mkdirSync(sourceDir, { mode: 0o700 });
  const git = (args: string[], input?: string) => {
    const result = spawnSync("/usr/bin/git", ["-C", repository, ...args], {
      encoding: "utf8", input,
      env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TEMPLATE_DIR: "" },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "-q"]);
  const blob = git(["hash-object", "-w", "--stdin"], "archive payload\n");
  const tree = git(["mktree"], `100644 blob ${blob}\tpayload.txt\n`);
  // @ts-expect-error Test-only JavaScript TeamMem module has no public declaration.
  const { archiveTeamMemSource } = await import("./teammem.mjs");
  assert.equal(typeof archiveTeamMemSource, "function", "argv-only source archive helper must exist");
  const steps = archiveTeamMemSource({ repository, tree, sourceDir, archivePath: path.join(f.root, "source archive.tar") });
  assert.equal(steps.length, 2);
  for (const step of steps) assert.equal(step.exit, 0, step.stderr);
  assert.equal(readFileSync(path.join(sourceDir, "payload.txt"), "utf8"), "archive payload\n");
  assert.equal(readdirSync(f.root).includes("injected-by-shell"), false);
  assert.throws(() => archiveTeamMemSource({ repository, tree: "HEAD; touch bad", sourceDir, archivePath: path.join(f.root, "invalid.tar") }), /40.*hex|tree/);
});
