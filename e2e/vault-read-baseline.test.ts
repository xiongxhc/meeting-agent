import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { setTimeout as pause } from "node:timers/promises";
// @ts-expect-error Private harness has no declaration.
import { JOIN_TIMING_FILE, createJoinTimingRecorder, readJoinTimingRows } from "./join-latency-evidence.mjs";

// A build shaped like the shipped one: an opening namespace+HEAD read at
// session start, a closing one after `delayMs`, then the `vault_index_built`
// mark through the entry's own join-timing recorder and file.
function slowBuild(delayMs: number) {
  const root = mkdtempSync(path.join(os.tmpdir(), "vault-read-baseline-"));
  const filename = path.join(root, JOIN_TIMING_FILE);
  const recorder = createJoinTimingRecorder({ filename });
  let reads = 1;
  recorder.observe("runtime_connected"); recorder.observe("vault_index_started"); recorder.observe("join_settled");
  const built = pause(delayMs).then(() => { reads += 1; recorder.observe("vault_index_built"); });
  return { root, built, readJoinTiming: () => readJoinTimingRows(filename), revisionReads: () => reads };
}

test("the question read baseline waits for a slow vault index build, so its closing read is not counted as retrieval", async () => {
  // @ts-expect-error Private harness has no declaration.
  const entry = await import("./entry.mjs");
  const build = slowBuild(300);
  try {
    assert.equal(build.revisionReads(), 1, "build still running when the drive reaches the questions");
    const started = Date.now();
    const baseline = await entry.vaultReadBaseline({ readJoinTiming: build.readJoinTiming, revisionReads: build.revisionReads, budgetMs: 5_000 });
    assert.ok(Date.now() - started >= 250, "baseline taken only after the build settled");
    assert.equal(baseline, 2, "both build reads precede the baseline");
    // One retrieval read for the vault question is then exactly +1.
    assert.equal(build.revisionReads() + 1 - baseline, 1);
    await build.built;
  } finally { rmSync(build.root, { recursive: true, force: true }); }
});

test("the baseline fails clearly when the vault index never reports built", async () => {
  // @ts-expect-error Private harness has no declaration.
  const entry = await import("./entry.mjs");
  const root = mkdtempSync(path.join(os.tmpdir(), "vault-read-baseline-"));
  try {
    const filename = path.join(root, JOIN_TIMING_FILE);
    const recorder = createJoinTimingRecorder({ filename });
    recorder.observe("vault_index_started"); recorder.observe("join_settled");
    await assert.rejects(entry.vaultReadBaseline({ readJoinTiming: () => readJoinTimingRows(filename), revisionReads: () => 1, budgetMs: 200 }), /^Error: e2e_timeout:vault_index_built$/);
    await assert.rejects(entry.vaultReadBaseline({ readJoinTiming: () => readJoinTimingRows(path.join(root, "absent.ndjson")), revisionReads: () => 1, budgetMs: 200 }), /e2e_timeout:vault_index_built/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the baseline returns at once when the build settled before the join", async () => {
  // @ts-expect-error Private harness has no declaration.
  const entry = await import("./entry.mjs");
  const root = mkdtempSync(path.join(os.tmpdir(), "vault-read-baseline-"));
  try {
    const filename = path.join(root, JOIN_TIMING_FILE);
    const recorder = createJoinTimingRecorder({ filename });
    recorder.observe("vault_index_started"); recorder.observe("vault_index_built"); recorder.observe("join_settled");
    assert.equal(await entry.vaultReadBaseline({ readJoinTiming: () => readJoinTimingRows(filename), revisionReads: () => 2, budgetMs: 1_000 }), 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the interactive drive takes its first question read baseline through the build wait", () => {
  const source = readFileSync(new URL("./entry.mjs", import.meta.url), "utf8");
  const drive = source.slice(source.indexOf("async function driveInteractive("));
  const baseline = drive.indexOf("let before = await vaultReadBaseline({");
  assert.ok(baseline > 0, "first baseline goes through vaultReadBaseline");
  assert.ok(baseline < drive.indexOf('turn("current", '), "before the current question");
  assert.ok(drive.indexOf("revisionReads()") > baseline, "no earlier raw baseline");
});
