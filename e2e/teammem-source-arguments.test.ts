import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const RUN = path.join(import.meta.dirname, "run.mjs");
const MISSING = "MEETING_E2E_TEAMMEM_REPOSITORY must be set to the TeamMem meeting-storage checkout";

// An empty artifacts directory makes any run that gets past the TeamMem check
// fail at `verifyPins` with a different error, before the build.
function runWithout(args: readonly string[], teammem?: string) {
  const root = mkdtempSync(path.join(tmpdir(), "teammem-source-"));
  try {
    const artifacts = path.join(root, "artifacts"), temp = path.join(root, "tmp"), out = path.join(root, "out");
    for (const directory of [artifacts, temp]) mkdirSync(directory);
    const env: Record<string, string | undefined> = { ...process.env, MEETING_E2E_ARTIFACTS_DIR: artifacts, TMPDIR: temp };
    delete env.MEETING_E2E_TEAMMEM_REPOSITORY;
    if (teammem !== undefined) env.MEETING_E2E_TEAMMEM_REPOSITORY = teammem;
    const result = spawnSync(process.execPath, [RUN, ...args, "--out", out], {
      cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 10000, env,
    });
    return { status: result.status, stderr: result.stderr, stdout: result.stdout, outCreated: existsSync(out), tempEntries: readdirSync(temp) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const args of [
  [],
  ["--keep"],
  ["--interactive"],
  ["--r2-baseline"],
  ["--media-timing", "invalid2ns"],
  ["--interactive", "--l4-case", "sent-named"],
  ["--interactive", "--d2-cut", "durable"],
] as const) {
  test(`TeamMem source is required before pins, build or staging: ${args.join(" ") || "full"}`, () => {
    const result = runWithout(args);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(MISSING), result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.outCreated, false);
    assert.deepEqual(result.tempEntries, []);
  });
}

test("a relative TeamMem source is refused before pins, build or staging", () => {
  const result = runWithout([], "relative/teammem");
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("MEETING_E2E_TEAMMEM_REPOSITORY must be an absolute path"), result.stderr);
  assert.equal(result.outCreated, false);
  assert.deepEqual(result.tempEntries, []);
});

test("the L6 receipt gate refuses a missing TeamMem source before creating output", () => {
  const result = runWithout(["--r2-baseline", "--l6-receipt-gate"]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "l6_run_prerequisite_failed\n");
  assert.equal(result.outCreated, false);
  assert.deepEqual(result.tempEntries, []);
});

test("--only-refusals needs no TeamMem source and proceeds to pin verification", async () => {
  const { parseArguments, requireTeamMemSource } = await import(RUN);
  const saved = process.env.MEETING_E2E_TEAMMEM_REPOSITORY;
  delete process.env.MEETING_E2E_TEAMMEM_REPOSITORY;
  try {
    assert.doesNotThrow(() => requireTeamMemSource(parseArguments(["--only-refusals", "--out", "/tmp/unused-refusals"])));
    assert.throws(() => requireTeamMemSource(parseArguments(["--out", "/tmp/unused-full"])), { message: MISSING });
  } finally {
    if (saved !== undefined) process.env.MEETING_E2E_TEAMMEM_REPOSITORY = saved;
  }
  const result = runWithout(["--only-refusals"]);
  assert.equal(result.status, 1);
  assert.ok(!result.stderr.includes("MEETING_E2E_TEAMMEM_REPOSITORY"), result.stderr);
  assert.ok(result.stderr.includes("ENOENT"), result.stderr);
  assert.equal(result.outCreated, true);
  assert.deepEqual(result.tempEntries, []);
});
