import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
// @ts-expect-error Private harness has no declaration.
import * as run from "./run.mjs";
// @ts-expect-error Private harness has no declaration.
import * as stage from "./stage.mjs";
import { timingFixture, longOmissionFixture } from "./durable-oracles.test.ts";

test("long actual route assembles99 through closed CLI, stage, child and drive selections", () => {
  const selected = run.parseArguments(["--out", "/private/tmp/unused", "--media-timing", "omit-final-pair-long"]);
  assert.deepEqual(stage.scriptedCaptureConfiguration(selected), { mediaTiming: "omit-final-pair-long", captureFrameLimit: 99 });
  assert.equal(run.driveCaptureConfiguration(selected).captureFrames, 99);
  assert.equal(run.captureRecorded({ framesSent: 98 }, selected), false); assert.equal(run.captureRecorded({ framesSent: 99 }, selected), true);
  assert.equal(run.mediaTimingFailureName(selected.mediaTiming), "media_timing_omit_final_pair_long");
  assert.deepEqual(run.mediaTimingArguments(selected), ["--media-timing", "omit-final-pair-long"]); assert.equal(run.publicationRequired(selected), false);
  for (const extra of [["--interactive"], ["--interactive", "--l4-case", "sent-named"], ["--r2-baseline"], ["--only-refusals"], ["--package-refusals"], ["--d2-cut", "durable"], ["--media-timing", "omit-final-pair-long"]])
    assert.throws(() => run.parseArguments(["--out", "/private/tmp/unused", "--media-timing", "omit-final-pair-long", ...extra]));
});
test("long readiness and postclose use separate strict actual selected-page validator", async () => {
  // @ts-expect-error Private harness has no declaration.
  const entry = await import("./entry.mjs"), f = longOmissionFixture(63); let reads = 0;
  const result = await entry.waitForMediaTimingAlignment({ read: () => f.snapshot, child: () => f.child, mode: "omit-final-pair-long", budgetMs: 1000 });
  assert.equal(result.mappedFrames, 63);
  const input = { closed: true, read: () => { reads++; return f.snapshot; }, child: f.child, mode: "omit-final-pair-long" };
  assert.throws(() => run.verifyMediaTimingAfterClose({ ...input, closed: false }), /closure/); assert.equal(reads, 0);
  assert.equal(run.verifyMediaTimingAfterClose(input).metadata.frames, 99); assert.equal(reads, 1);
  f.child.framesSent = 98; assert.throws(() => run.verifyMediaTimingAfterClose(input), /position/); assert.equal(reads, 2);
});
test("selected long public close awaits actual handle and always settles controller on missing or failed close", async () => {
  // @ts-expect-error Private harness has no declaration.
  const entry = await import("./entry.mjs");
  for (const fault of ["none", "missing", "reject"]) {
    const controller = new AbortController(); let closed = false;
    const app = fault === "missing" ? null : { async close() { await Promise.resolve(); closed = true; if (fault === "reject") throw new Error("PRIVATE_BODY"); } };
    const result = entry.closeLongTailComposition({ getApplication: () => app, controller });
    if (fault === "none") await result; else await assert.rejects(result, /long_tail_public_close/);
    assert.equal(controller.signal.aborted, true); assert.equal(closed, fault !== "missing");
  }
});
test("selected failed drive still uses actual public close and settles controller without emitting arbitrary cause", async () => {
  // @ts-expect-error Private harness has no declaration.
  const entry = await import("./entry.mjs");
  const controller = new AbortController(), calls: string[] = [];
  const result = await entry.settleLongTailDrive({ drive: Promise.reject(new Error("PRIVATE_DIAGNOSTIC")), controller,
    getApplication: () => ({ async close() { calls.push("closed"); } }) });
  assert.equal(result, "long_tail_drive_prerequisite_failed"); assert.deepEqual(calls, ["closed"]); assert.equal(controller.signal.aborted, true);
  let reads = 0;
  await assert.rejects(entry.waitForMediaTimingAlignment({ read: () => { reads++; throw new Error("unused"); }, child: () => null,
    mode: "omit-final-pair-long", budgetMs: 1000, signal: controller.signal }), /long_tail_drive_cancelled/); assert.equal(reads, 0);
});
test("long finite report requires observed selected checks and refuses external serialization hooks before effects", async () => {
  // @ts-expect-error Private oracle has no declaration.
  const m = await import("./durable-oracles.mjs"), f = longOmissionFixture(), metadata = m.longTailOmissionMetadata(f.snapshot, f.child);
  const names = ["media_timing_omit_final_pair_long", "media_timing_alignment_ready", "long_tail_public_close", "shutdown_clean", "no_key_or_plaintext_audio", "no_orphan_process", "no_closed_store_callback", "single_occurrence_identity"];
  const input = { metadata, cleanupConfirmed: true, checks: names.map(name => ({ name, status: "pass" })) };
  assert.equal(m.longTailReport(input).disposition, "observed-mapped-prefix-tail");
  for (const name of names) for (const status of ["absent", "fail", "blocked", "skipped"]) {
    const checks = input.checks.flatMap(c => c.name !== name ? [c] : status === "absent" ? [] : [{ ...c, status }]);
    assert.equal(m.longTailReport({ ...input, checks }).disposition, "prerequisite-failed-or-unknown");
  }
  assert.equal(m.longTailReport({ ...input, metadata: null }).facts, null);
  assert.equal(m.longTailReport({ ...input, cleanupConfirmed: false }).disposition, "prerequisite-failed-or-unknown");
  for (const change of [{ frames: 98 }, { mappedFrames: "47" }, { pageCount: "5" }, { sha256: "PRIVATE_SENTINEL" }, { occurrence: metadata.occurrence + "@PRIVATE_SENTINEL" }, { finalPairRecorded: true }, { wall: {} },
    { captureDrain: { ...metadata.captureDrain, credential: "PRIVATE" } }, { missingSamples: { start: "1", end: "47520" } }, { warnings: [] }])
    assert.throws(() => m.longTailReport({ ...input, metadata: { ...metadata, ...change } }), /long_tail_output_refused/);
  let executed = 0;
  const occurrence = metadata.occurrence + "@PRIVATE_SENTINEL", generationId = Buffer.from(occurrence).toString("hex") + ":" + Buffer.from(metadata.bridgeSessionId).toString("hex");
  assert.throws(() => m.longTailReport({ ...input, metadata: { ...metadata, occurrence, generationId } }), /long_tail_output_refused/);
  const getter = Object.defineProperty({ ...metadata }, "mappedFrames", { enumerable: true, get() { executed++; return 47; } });
  const arrays = [Object.assign([...metadata.warnings], { toJSON() { executed++; return []; } }),
    Object.setPrototypeOf([...metadata.warnings], Object.assign(Object.create(Array.prototype), { toJSON() { executed++; return []; } }))];
  assert.throws(() => m.longTailReport({ ...input, metadata: getter }), /long_tail_output_refused/);
  for (const warnings of arrays) assert.throws(() => m.longTailReport({ ...input, metadata: { ...metadata, warnings } }), /long_tail_output_refused/);
  assert.throws(() => m.longTailReport({ ...input, checks: [{ name: "failure", status: { raw: "PRIVATE" } }] }), /long_tail_output_refused/);
  assert.equal(executed, 0);
});
test("actual long bundle writer emits finite prerequisite-unknown before scan and refuses unsafe metadata before writing", async () => {
  // @ts-expect-error Private oracle has no declaration.
  const m = await import("./durable-oracles.mjs"), f = longOmissionFixture(), dir = mkdtempSync(path.join(os.tmpdir(), "meeting-long-tail-report-"));
  const metadata = m.longTailOmissionMetadata(f.snapshot, f.child), live = { mediaTiming: metadata, proofs: { processCleanup: { cleanupConfirmed: true } } };
  try {
    run.writeBundle(dir, { options: { mediaTiming: "omit-final-pair-long" }, live });
    const bytes = readFileSync(path.join(dir, "bundle.json"), "utf8"), result = JSON.parse(bytes);
    assert.equal(result.disposition, "prerequisite-failed-or-unknown"); assert.equal(result.facts.mappedFrames, 47);
    live.mediaTiming = { ...metadata, rawPages: ["PRIVATE"] };
    assert.throws(() => run.writeBundle(dir, { options: { mediaTiming: "omit-final-pair-long" }, live }), /long_tail_output_refused/);
    assert.equal(readFileSync(path.join(dir, "bundle.json"), "utf8"), bytes);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("media timing CLI refuses aliases, duplicates and incompatible modes before effects", () => {
  const argv = ["--out", "/private/tmp/unused-component-out"];
  assert.equal(run.parseArguments([...argv, "--media-timing", "invalid2ns"]).mediaTiming, "invalid2ns");
  assert.equal(run.parseArguments(argv).mediaTiming, undefined);
  for (const flags of [["--media-timing"], ["--media-timing", "normal"], ["--media-timing", "tail"],
    ["--media-timing", "invalid2ns", "--media-timing", "invalid2ns"],
    ...[["--interactive"], ["--interactive", "--d2-cut", "durable"], ["--r2-baseline"], ["--only-refusals"], ["--package-refusals"]].map(mode => ["--media-timing", "invalid2ns", ...mode])]) {
    assert.throws(() => run.parseArguments([...argv, ...flags]));
  }
});
test("actual shared stage and drive selection fixes private 51-frame mode and bypasses publication", () => {
  assert.equal(typeof stage.mediaTimingConfiguration, "function"); assert.equal(typeof run.publicationRequired, "function");
  const selected = run.parseArguments(["--out", "/private/tmp/unused", "--media-timing", "invalid2ns"]);
  assert.deepEqual(stage.mediaTimingConfiguration(selected), { mediaTiming: "invalid2ns", captureFrameLimit: 51 });
  assert.deepEqual(stage.mediaTimingConfiguration({}), {});
  assert.equal(run.publicationRequired(selected), false); assert.equal(run.publicationRequired({}), true);
  assert.deepEqual(run.mediaTimingArguments(selected), ["--media-timing", "invalid2ns"]);
  for (const mediaTiming of [null, {}, "normal", "bad"]) assert.throws(() => stage.mediaTimingConfiguration({ mediaTiming }));
});
test("readiness waits for absent rows, refuses invalid COMPLETE pages and has a hard deadline", async () => {
  // @ts-expect-error Private harness has no declaration.
  const entry = await import("./entry.mjs");
  const f = timingFixture(), empty = { ...f.snapshot, recordings: [], bindings: [], selected: [], attempts: [], pages: [] };
  let reads = 0;
  const summary = await entry.waitForMediaTimingAlignment({ read: () => ++reads === 1 ? empty : f.snapshot,
    child: () => f.child, mode: "invalid2ns", budgetMs: 1000 });
  assert.equal(summary.target.overlapNs, "2"); assert.equal(reads, 2);
  const bad = timingFixture(); bad.snapshot.attempts[0]!.state = "staging";
  await assert.rejects(entry.waitForMediaTimingAlignment({ read: () => bad.snapshot, child: () => bad.child, mode: "invalid2ns", budgetMs: 1000 }), /not COMPLETE/);
  bad.snapshot.attempts[0]!.state = "complete"; bad.recording.sha256 = "d".repeat(64);
  await assert.rejects(entry.waitForMediaTimingAlignment({ read: () => bad.snapshot, child: () => bad.child, mode: "invalid2ns", budgetMs: 1000 }), /identity mismatch/);
  await assert.rejects(entry.waitForMediaTimingAlignment({ read: () => { throw new Error("no such table"); }, child: () => f.child, mode: "invalid2ns", budgetMs: 1000 }), /no such table/);
  await assert.rejects(entry.waitForMediaTimingAlignment({ read: () => empty, child: () => f.child, mode: "invalid2ns", budgetMs: 1 }), /timeout/);
});
test("after-close check requires a fresh reopened strict oracle rather than readiness alone", () => {
  assert.equal(typeof run.verifyMediaTimingAfterClose, "function");
  const f = timingFixture(); let reads = 0;
  const input = { closed: true, read: () => { reads++; return f.snapshot; }, child: f.child, mode: "invalid2ns" };
  assert.throws(() => run.verifyMediaTimingAfterClose({ ...input, closed: false }), /closure/); assert.equal(reads, 0);
  assert.equal(run.verifyMediaTimingAfterClose(input).metadata.frames, 51); assert.equal(reads, 1);
  f.child.captureDrain.drain = "unconfirmed";
  assert.throws(() => run.verifyMediaTimingAfterClose(input), /finish/); assert.equal(reads, 2);
});

// Real assemblies are called by stage and liveRun; losing either selected count fails here.
test("omission route assembles fixed49 child capture, parent wait and reporting while other modes retain counts", () => {
  for (const [mode, count] of [[undefined, 51], ["invalid2ns", 51], ["omit-final-pair", 49]] as const) {
    const options = mode === undefined ? {} : run.parseArguments(["--out", "/private/tmp/unused", "--media-timing", mode]);
    assert.equal(stage.scriptedCaptureConfiguration(options).captureFrameLimit, count);
    assert.equal(run.driveCaptureConfiguration(options).captureFrames, count);
    assert.equal(run.captureRecorded({ framesSent: count }, options), true);
    assert.equal(run.captureRecorded({ framesSent: count - 1 }, options), false);
    assert.equal(run.mediaTimingFailureName(mode), mode === undefined ? "confirmed_capture_tail" : mode === "invalid2ns" ? "media_timing_invalid2ns" : "media_timing_omit_final_pair");
  }
  assert.equal(stage.scriptedCaptureConfiguration({ interactive: true }).captureFrameLimit, 3000);
  assert.equal(run.driveCaptureConfiguration({ interactive: true }).captureFrames, 51);
  assert.equal(run.publicationRequired({ mediaTiming: "omit-final-pair" }), false);
  assert.deepEqual(run.mediaTimingArguments({ mediaTiming: "omit-final-pair" }), ["--media-timing", "omit-final-pair"]);
  for (const extra of [["--interactive"], ["--r2-baseline"], ["--only-refusals"], ["--d2-cut", "durable"], ["--package-refusals"], ["--media-timing", "omit-final-pair"]])
    assert.throws(() => run.parseArguments(["--out", "/private/tmp/unused", "--media-timing", "omit-final-pair", ...extra]));
});
test("omission readiness and after-close dispatch strict selected oracle then fresh reopened evidence", async () => {
  // @ts-expect-error Private harness has no declaration.
  const entry = await import("./entry.mjs");
  const { omissionFixture } = await import("./durable-oracles.test.ts");
  const f = omissionFixture(), summary = await entry.waitForMediaTimingAlignment({ read: () => f.snapshot,
    child: () => f.child, mode: "omit-final-pair", budgetMs: 1000 });
  assert.equal(summary.lastFrame.sequence, "49"); let reads = 0;
  const input = { closed: true, read: () => { reads++; return f.snapshot; }, child: f.child, mode: "omit-final-pair" };
  assert.throws(() => run.verifyMediaTimingAfterClose({ ...input, closed: false }), /closure/); assert.equal(reads, 0);
  assert.equal(run.verifyMediaTimingAfterClose(input).metadata.frames, 49); assert.equal(reads, 1);
  f.child.captureFinish.requestedBoundary = { finalClockPairSequence: "1" };
  await assert.rejects(entry.waitForMediaTimingAlignment({ read: () => f.snapshot, child: () => f.child, mode: "omit-final-pair", budgetMs: 1000 }), /finish/);
  assert.throws(() => run.verifyMediaTimingAfterClose(input), /finish/); assert.equal(reads, 2);
});
