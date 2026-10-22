import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { chmodSync, constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
// @ts-expect-error Test-only JavaScript profile has no public declaration.
import { EXPIRY_EVIDENCE_PROFILE, EXPIRY_EVIDENCE_PROVENANCE, RUNTIME_PIN, RUNTIME_PROFILES, resolveRuntimeProfile, sha256FileSync, validateExpiryEvidencePackage, verifyPins } from "./pins.mjs";
// @ts-expect-error Test-only JavaScript launcher helper has no public declaration.
import { preflightLauncher } from "./launcher-preflight.mjs";
// @ts-expect-error Test-only JavaScript stage has no public declaration.
import { renderRuntimeLauncher, stage } from "./stage.mjs";
// @ts-expect-error Test-only JavaScript collector has no public declaration.
import { createExpiryEvidenceReader } from "./expiry-evidence-collector.mjs";

function privateRoot() { return realpathSync(mkdtempSync(path.join(realpathSync(tmpdir()), "meeting-expiry-profile-test-"))); }
function writableDirectories(root: string) {
  chmodSync(root, 0o700);
  for (const name of readdirSync(root)) {
    const file = path.join(root, name);
    if (lstatSync(file).isDirectory()) writableDirectories(file);
  }
}
function remove(root: string) { writableDirectories(root); rmSync(root, { recursive: true, force: true }); }

test("explicit evidence selection preserves accepted default and refuses arbitrary profiles before effects", async () => {
  assert.equal(RUNTIME_PIN, RUNTIME_PROFILES["runtime-lease-67433a1-20261022"]);
  assert.equal(RUNTIME_PIN.gateway.sha256, "b48f903521ce4ef05b8cedeacf6f711c51d0695253144c096b2a25d5fa385696");
  assert.equal(RUNTIME_PIN.sdkTarball.sha256, "01824aa411ed98707a2abedf73161c83e3d7b824d093198ac94f352c302dce38");
  assert.equal(resolveRuntimeProfile(), RUNTIME_PIN);
  assert.equal(resolveRuntimeProfile(EXPIRY_EVIDENCE_PROFILE.name), EXPIRY_EVIDENCE_PROFILE);
  for (const runtimeProfile of ["unknown", "toString", { ...EXPIRY_EVIDENCE_PROFILE }]) {
    assert.throws(() => stage({ repository: "/absent", runtimeProfile }), /unknown runtime profile/);
    await assert.rejects(verifyPins(runtimeProfile), /unknown runtime profile/);
  }
  for (const flags of [{ interactive: true }, { r2Baseline: true }]) assert.throws(() => stage({ repository: "/absent", runtimeProfile: EXPIRY_EVIDENCE_PROFILE, ...flags }), /incompatible/);
  assert.equal(Object.hasOwn(EXPIRY_EVIDENCE_PROFILE, "scriptedGateway"), false);
  const ordinary = await verifyPins();
  assert.equal(ordinary.gateway.sha256, RUNTIME_PIN.gateway.sha256);
  assert.equal(Object.hasOwn(ordinary, "provenance"), false);
});

test("actual reviewed package bytes bind complete export and mandatory external failed-gate correction", async () => {
  assert.deepEqual(validateExpiryEvidencePackage(), EXPIRY_EVIDENCE_PROVENANCE);
  const verified = await verifyPins(EXPIRY_EVIDENCE_PROFILE);
  assert.deepEqual(verified.provenance, EXPIRY_EVIDENCE_PROVENANCE);
  assert.equal(verified.gateway.sha256, EXPIRY_EVIDENCE_PROVENANCE.gatewaySha256);
  assert.throws(() => validateExpiryEvidencePackage("/nonexistent-reviewed-package"));
  assert.throws(() => validateExpiryEvidencePackage(EXPIRY_EVIDENCE_PROFILE.root, { ...EXPIRY_EVIDENCE_PROFILE.packagePaths, erratum: "/absent-required-erratum" }));
});

test("private byte-for-byte copy of actual package refuses source/artifact/manifest substitution", async (t) => {
  // No manufactured accepted package: copy only the actual independently pinned
  // portable files, preserving their reviewed modes. Cache is expressly excluded.
  const root = privateRoot(), packageRoot = path.join(root, "package");
  cpSync(EXPIRY_EVIDENCE_PROFILE.root, packageRoot, { recursive: true, mode: constants.COPYFILE_FICLONE,
    filter: file => path.basename(file) !== ".build-target" });
  try {
    assert.deepEqual(validateExpiryEvidencePackage(packageRoot), EXPIRY_EVIDENCE_PROVENANCE);
    for (const relative of ["source/Cargo.lock", "bin/conversation-runtime-gateway-media-admission-evidence", "sdk/conversation-runtime-0.1.0.tgz", "runtime-media-evidence.patch", "build-metadata.json", "source-manifest.json", "artifact-manifest.json"]) {
      await t.test(`missing and tampered ${relative}`, () => {
        const file = path.join(packageRoot, relative), backup = path.join(root, "backup"), mode = lstatSync(file).mode & 0o7777;
        copyFileSync(file, backup, constants.COPYFILE_FICLONE); chmodSync(path.dirname(file), 0o700);
        try {
          rmSync(file); assert.throws(() => validateExpiryEvidencePackage(packageRoot));
          copyFileSync(backup, file); chmodSync(file, 0o600);
          const bytes = readFileSync(file); bytes[0] = bytes[0]! ^ 1; writeFileSync(file, bytes); chmodSync(file, mode); chmodSync(path.dirname(file), 0o555);
          assert.throws(() => validateExpiryEvidencePackage(packageRoot));
        } finally {
          chmodSync(path.dirname(file), 0o700); rmSync(file, { force: true }); copyFileSync(backup, file); chmodSync(file, mode); chmodSync(path.dirname(file), 0o555); rmSync(backup);
        }
      });
    }
    await t.test("extra source and symlink source refuse", () => {
      const sourceRoot = path.join(packageRoot, "source"), extra = path.join(sourceRoot, "unreviewed");
      chmodSync(sourceRoot, 0o700);
      try {
        writeFileSync(extra, "unreviewed", { mode: 0o444 }); chmodSync(sourceRoot, 0o555); assert.throws(() => validateExpiryEvidencePackage(packageRoot));
        chmodSync(sourceRoot, 0o700); rmSync(extra); symlinkSync("Cargo.lock", extra); chmodSync(sourceRoot, 0o555); assert.throws(() => validateExpiryEvidencePackage(packageRoot));
      } finally { chmodSync(sourceRoot, 0o700); rmSync(extra); chmodSync(sourceRoot, 0o555); }
    });
    for (const mutation of ["duplicate", "escape", "extra"] as const) await t.test(`untrusted ${mutation} manifest refuses independent identity`, () => {
      const file = path.join(packageRoot, "source-manifest.json"), bytes = readFileSync(file), manifest = JSON.parse(bytes.toString());
      if (mutation === "duplicate") manifest.sourceEntries.push(manifest.sourceEntries[0]);
      if (mutation === "escape") manifest.sourceEntries[0].path = "../outside";
      if (mutation === "extra") manifest.sourceEntries.push({ ...manifest.sourceEntries[0], path: "unreviewed" });
      try { chmodSync(file, 0o600); writeFileSync(file, JSON.stringify(manifest)); chmodSync(file, 0o444); assert.throws(() => validateExpiryEvidencePackage(packageRoot)); }
      finally { chmodSync(file, 0o600); writeFileSync(file, bytes); chmodSync(file, 0o444); }
    });
    await t.test("symlink ancestry refuses even byte-identical package", () => {
      const link = path.join(root, "linked-package"); symlinkSync(packageRoot, link); assert.throws(() => validateExpiryEvidencePackage(link)); unlinkSync(link);
    });
    await t.test("extra empty source directory refuses", () => {
      const sourceRoot = path.join(packageRoot, "source"), extra = path.join(sourceRoot, "empty-extra");
      try { chmodSync(sourceRoot, 0o700); mkdirSync(extra, { mode: 0o555 }); chmodSync(sourceRoot, 0o555); assert.throws(() => validateExpiryEvidencePackage(packageRoot)); }
      finally { chmodSync(sourceRoot, 0o700); rmSync(extra, { recursive: true }); chmodSync(sourceRoot, 0o555); }
    });
    await t.test("source logical-mode substitution and extra portable file refuse", () => {
      const lock = path.join(packageRoot, "source/Cargo.lock"), extra = path.join(packageRoot, "unreviewed-artifact");
      try {
        chmodSync(lock, 0o555); assert.throws(() => validateExpiryEvidencePackage(packageRoot)); chmodSync(lock, 0o444);
        chmodSync(packageRoot, 0o700); writeFileSync(extra, "extra", { mode: 0o444 }); chmodSync(packageRoot, 0o555); assert.throws(() => validateExpiryEvidencePackage(packageRoot));
      } finally { chmodSync(lock, 0o444); chmodSync(packageRoot, 0o700); rmSync(extra, { force: true }); chmodSync(packageRoot, 0o555); }
    });
    for (const key of ["erratum", "reconciledAudit"] as const) await t.test(`mandatory external ${key} tampering refuses`, () => {
      const copy = path.join(root, key); copyFileSync(EXPIRY_EVIDENCE_PROFILE.packagePaths[key], copy);
      const bytes = readFileSync(copy); bytes[0] = bytes[0]! ^ 1; chmodSync(copy, 0o600); writeFileSync(copy, bytes);
      assert.throws(() => validateExpiryEvidencePackage(packageRoot, { ...EXPIRY_EVIDENCE_PROFILE.packagePaths, [key]: copy })); rmSync(copy);
    });
    assert.deepEqual(validateExpiryEvidencePackage(packageRoot), EXPIRY_EVIDENCE_PROVENANCE);
  } finally { remove(root); }
});

test("actual stage copies and hashes explicit reviewed profile without precreating journal/receipt", () => {
  const repository = privateRoot(); let staged;
  try {
    // Tiny inert built-application fixtures: stage copies files; nothing runs.
    for (const name of ["dist", "migrations", "node_modules", "e2e"]) mkdirSync(path.join(repository, name));
    writeFileSync(path.join(repository, "package.json"), "{}");
    staged = stage({ repository, runtimeProfile: EXPIRY_EVIDENCE_PROFILE.name });
    const descriptor = JSON.parse(readFileSync(staged.expiryEvidenceDescriptorPath, "utf8"));
    assert.deepEqual(descriptor.expectedProvenance, EXPIRY_EVIDENCE_PROVENANCE);
    assert.equal(lstatSync(staged.expiryEvidenceDescriptorPath).mode & 0o7777, 0o600);
    assert.equal(lstatSync(descriptor.privateRoot).mode & 0o7777, 0o700);
    for (const key of ["journalPath", "receiptPath", "gatewayPath", "sdkPath"]) assert.equal(path.dirname(descriptor[key]), descriptor.privateRoot);
    assert.equal(existsSync(descriptor.journalPath), false); assert.equal(existsSync(descriptor.receiptPath), false);
    assert.equal(sha256FileSync(descriptor.gatewayPath), EXPIRY_EVIDENCE_PROVENANCE.gatewaySha256);
    assert.equal(sha256FileSync(descriptor.sdkPath), EXPIRY_EVIDENCE_PROVENANCE.sdkSha256);
    for (const [key, file] of Object.entries(descriptor.packagePaths)) assert.equal(sha256FileSync(file), EXPIRY_EVIDENCE_PROVENANCE[`${key}Sha256`]);
    assert.match(readFileSync(path.join(descriptor.privateRoot, "expiry-evidence-provenance.json"), "utf8"), /failed output; captured process exit and cleanup unknown/);
    // Actual C descriptor reaches actual B reader; no process is spawned.
    const reader = createExpiryEvidenceReader(staged.expiryEvidenceDescriptorPath);
    try { assert.equal(reader.readTail().status, "pending"); assert.throws(() => reader.readFinal()); }
    finally { reader.close(); }
    assert.equal(existsSync(descriptor.journalPath), false); assert.equal(existsSync(descriptor.receiptPath), false);
    const ordinary = stage({ repository });
    try {
      assert.equal(ordinary.runtimeProfile, RUNTIME_PIN); assert.equal(ordinary.expiryEvidenceDescriptorPath, undefined);
      assert.equal(sha256FileSync(ordinary.gatewayPath), RUNTIME_PIN.gateway.sha256);
      assert.doesNotMatch(readFileSync(ordinary.launcherPath, "utf8"), /expiry-evidence-descriptor/);
    } finally { remove(ordinary.root); }
  } finally { if (staged) remove(staged.root); remove(repository); }
});

test("same launcher template splits zero-argument preflight from configured collector activation (synthetic only)", () => {
  const root = privateRoot(), file = (name: string) => path.join(root, name);
  const gatewayPath = file("synthetic-gateway"), observerPath = file("synthetic-observer.cjs"), keyPath = file("key"), launcher = file("launcher");
  const journalPath = file("journal"), receiptPath = file("receipt"), activation = file("activation"), refusal = file("refusal");
  try {
    writeFileSync(keyPath, "synthetic-private-key\n", { mode: 0o600 });
    writeFileSync(gatewayPath, `#!${process.execPath}\nconst fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(refusal)}, JSON.stringify({argc:process.argv.length-2,journal:process.env.RUNTIME_MEDIA_ADMISSION_EVIDENCE_PATH??null})); process.exit(1);\n`, { mode: 0o700 });
    writeFileSync(observerPath, `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(activation)}, JSON.stringify({args:process.argv.slice(2),journal:process.env.RUNTIME_MEDIA_ADMISSION_EVIDENCE_PATH??null})); fs.writeFileSync(${JSON.stringify(journalPath)}, 'synthetic-exclusive', {flag:'wx'}); fs.writeFileSync(${JSON.stringify(receiptPath)}, 'synthetic-exclusive', {flag:'wx'});\n`);
    const descriptorPath = file("descriptor");
    writeFileSync(launcher, renderRuntimeLauncher({ launcherLog: file("stderr"), keyPath, gatewayPath,
      observerPath, eventsPath: file("events"), pidsPath: file("pids"), expiryEvidenceDescriptorPath: descriptorPath, journalPath, receiptPath }), { mode: 0o700 });
    const env = { ...process.env, RUNTIME_MEDIA_ADMISSION_EVIDENCE_PATH: file("ambient") };
    assert.equal(preflightLauncher(launcher, { env }).exit, 1);
    assert.deepEqual(JSON.parse(readFileSync(refusal, "utf8")), { argc: 0, journal: null });
    assert.equal(existsSync(activation), false); assert.equal(existsSync(journalPath), false); assert.equal(existsSync(receiptPath), false);
    const result = spawnSync(launcher, ["--config", file("config")], { env, encoding: "utf8" });
    assert.equal(result.status, 0); assert.equal(result.stdout, "");
    const observed = JSON.parse(readFileSync(activation, "utf8"));
    assert.equal(observed.journal, null);
    assert.deepEqual(observed.args, ["--expiry-evidence-descriptor", descriptorPath, "--", gatewayPath, keyPath, file("events"), file("pids"), "--config", file("config")]);
    const before = readFileSync(activation); assert.equal(spawnSync(launcher, ["--config", file("config")], { env }).status, 70);
    assert.deepEqual(readFileSync(activation), before); assert.deepEqual(readFileSync(journalPath), Buffer.from("synthetic-exclusive"));
    rmSync(journalPath); rmSync(receiptPath);
    assert.equal(spawnSync(launcher, ["--config", file("config")], { env }).status, 70);
    assert.deepEqual(readFileSync(activation), before);
  } finally { remove(root); }
});

for (const location of ["local-metadata", "external-correction", "local-open-race", "json-phase-replacement"] as const) {
  test(`bounded validator refuses synthetic FIFO ${location} without waiting for writer`, () => {
    const root = privateRoot(), fifo = path.join(root, location === "external-correction" ? "erratum" : "artifact-manifest.json");
    try {
      if (location === "json-phase-replacement") {
        // Only the actual four metadata files; this deliberately incomplete
        // fixture is never accepted. Replacement occurs after their hash reads.
        for (const key of ["artifactManifest", "sourceManifest", "patch", "buildMetadata"] as const) copyFileSync(EXPIRY_EVIDENCE_PROFILE.packagePaths[key], path.join(root, path.basename(EXPIRY_EVIDENCE_PROFILE.packagePaths[key])));
      } else if (location === "local-open-race") writeFileSync(fifo, "synthetic-regular-before-open", { mode: 0o444 });
      else assert.equal(spawnSync("/usr/bin/mkfifo", ["-m", "444", fifo]).status, 0);
      const script = `
        import fs from 'node:fs';
        import { spawnSync } from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        import { validateExpiryEvidencePackage, EXPIRY_EVIDENCE_PROFILE } from ${JSON.stringify(new URL("./pins.mjs", import.meta.url).href)};
        const file = ${JSON.stringify(fifo)};
        if (${JSON.stringify(location)} === 'local-open-race') {
          const original = fs.openSync;
          fs.openSync = (name, ...args) => {
            if (name === file) {
              fs.unlinkSync(file);
              if (spawnSync('/usr/bin/mkfifo', ['-m', '444', file]).status !== 0) process.exit(72);
            }
            return original(name, ...args);
          };
          syncBuiltinESMExports();
        }
        if (${JSON.stringify(location)} === 'json-phase-replacement') {
          const original = fs.closeSync; let count = 0;
          fs.closeSync = fd => {
            original(fd);
            if (++count === 4) {
              fs.unlinkSync(file);
              if (spawnSync('/usr/bin/mkfifo', ['-m', '444', file]).status !== 0) process.exit(72);
            }
          };
          syncBuiltinESMExports();
        }
        try {
          if (${JSON.stringify(location)} === 'external-correction') validateExpiryEvidencePackage(EXPIRY_EVIDENCE_PROFILE.root, { ...EXPIRY_EVIDENCE_PROFILE.packagePaths, erratum: file });
          else validateExpiryEvidencePackage(${JSON.stringify(root)});
          process.exit(71);
        } catch (error) {
          if (error.message !== 'expiry evidence package mismatch') process.exit(73);
          process.exit(0);
        }
      `;
      // Isolated owned Node child only. spawnSync kills and reaps any blocked
      // synchronous validator on timeout; no same-thread timer can mask the bug.
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { timeout: 1500, killSignal: "SIGKILL", encoding: "utf8" });
      assert.equal(result.error, undefined, "FIFO validator must refuse within fixture deadline");
      assert.equal(result.signal, null); assert.equal(result.status, 0); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
      assert.equal(lstatSync(fifo).isFIFO(), true);
      const expected = location === "json-phase-replacement" ? ["artifact-manifest.json", "source-manifest.json", "runtime-media-evidence.patch", "build-metadata.json"] : [path.basename(fifo)];
      assert.deepEqual(readdirSync(root).sort(), expected.sort());
      if (location === "json-phase-replacement") for (const key of ["sourceManifest", "patch", "buildMetadata"] as const) assert.equal(sha256FileSync(path.join(root, path.basename(EXPIRY_EVIDENCE_PROFILE.packagePaths[key]))), EXPIRY_EVIDENCE_PROVENANCE[`${key}Sha256`]);
    } finally { remove(root); }
  });
}
