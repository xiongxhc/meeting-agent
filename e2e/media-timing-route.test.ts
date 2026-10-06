import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error Private harness has no declaration.
import * as run from "./run.mjs";
// @ts-expect-error Private harness has no declaration.
import * as stage from "./stage.mjs";
import { timingFixture } from "./durable-oracles.test.ts";

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
