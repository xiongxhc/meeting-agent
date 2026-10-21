import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeAlignmentPage, encodeAlignmentPage, pageWarnings, ALIGNMENT_POLICY } from "../src/sessions/recording-alignment.ts";
import { encodeLiveEvidence } from "../src/sessions/live-evidence-codec.ts";
import { mergeTimedRecordingEvidence } from "../src/sessions/timed-evidence-merge.ts";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { createCoordinator } from "../src/sessions/coordinator.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
// Explicit synthetic component input, encoded through the production page codec.
export function longOmissionFixture(k = 47, suffix: "none" | "gap" | "reconnect" | "both" = "none", straddle = false) {
  const f = omissionFixture(), old = omissionEntries(f), template = old.find(e => e.kind === "frame");
  if (template?.kind !== "frame" || old[0]?.kind !== "epoch" || old[1]?.kind !== "clock_pair") throw new Error("fixture");
  const base = 1_000_000_000n, wallBase = 1_790_000_000_000_000_000n;
  const pair1 = { ...old[1].pair, hostBeforeNs: base - 1000n, hostAfterNs: base, localUnixNs: wallBase };
  const midpoint2 = base + BigInt(k) * 20_000_000n + (straddle ? 10_000_000n : 0n);
  const pair2 = { ...pair1, sequence: 2n, hostBeforeNs: midpoint2 - 500n, hostAfterNs: midpoint2 + 500n,
    localUnixNs: wallBase + midpoint2 - (base - 500n) };
  const frames = Array.from({ length: 99 }, (_, i) => {
    const start = BigInt(i) * 480n, host = base + BigInt(i) * 20_000_000n;
    return { ...template, mediaStartSample: start, mediaEndSample: start + 480n,
      provenance: { ...template.provenance!, sequence: BigInt(i + 1), outputStartSample: start,
        sourceStartNumerator: start * 24000n, sourceEndNumerator: (start + 480n) * 24000n,
        span: { ...template.provenance!.span!, hostStartNs: host, hostEndNs: host + 20_000_000n } },
      reasons: i < k ? [] : template.reasons,
      wall: i >= k ? null : { quality: "local_wall_estimate" as const, policyId: "local-wall-estimate/v1" as const,
        localStartNs: wallBase + host - (base - 500n), localEndNs: wallBase + host + 20_000_000n - (base - 500n),
        wallEpoch: 1n, wallRun: 1n, maximumBracketNs: 1000n, maximumResolutionNs: 1000n,
        modelAllowanceNs: 10_000_000n as const, interpolationRoundingNs: 2n, captureRoundingNs: 1000n,
        captureUncertaintyNs: null, externalUtcAccuracyNs: null, overallPhysicalAccuracyNs: null } };
  });
  const entries: ReturnType<typeof decodeAlignmentPage>["entries"][number][] = [old[0], { kind: "clock_pair", pair: pair1 },
    ...frames.slice(0, 50), { kind: "clock_pair", pair: pair2 }, ...frames.slice(50)];
  if (["reconnect", "both"].includes(suffix)) entries.push({ kind: "discontinuity", captureEpoch: 1n, reason: "reconnect" });
  if (["gap", "both"].includes(suffix)) entries.push({ kind: "audio_gap", startedAtMs: 1980n, endedAtMs: null, reason: "capture_discontinuity" });
  Object.assign(f.recording, { duration_ms: 1980 });
  const position = { captureEpoch: "1", sequence: "99", outputEndSample: "47520" };
  const generation = Buffer.from(f.snapshot.occurrence).toString("hex") + ":" + Buffer.from("bridge-fixture").toString("hex");
  f.snapshot.bindings[0]!.generation_id = generation; f.snapshot.selected[0]!.generation_id = generation;
  f.snapshot.attempts[0]!.generation_id = generation;
  f.snapshot.attempts[0]!.attempt_id = f.snapshot.selected[0]!.attempt_id = "12345678-1234-1234-1234-123456789abc";
  Object.assign(f.child, { mediaTiming: "omit-final-pair-long", framesSent: 99, capturePosition: { ...position } });
  f.child.captureFinish.capturePosition = { ...position }; replaceLongEntries(f, entries);
  if (["gap", "both"].includes(suffix)) f.snapshot.runtimeGaps.push({ started_at_ms: "1980", ended_at_ms: null, reason: "capture_discontinuity" });
  return f;
}
export function replaceLongEntries(f: ReturnType<typeof omissionFixture>, entries: ReturnType<typeof decodeAlignmentPage>["entries"]) {
  const page = decodeAlignmentPage(f.snapshot.pages[0]!.payload), chunks = [];
  for (let i = 0; i < entries.length; i += 25) chunks.push(entries.slice(i, i + 25));
  f.snapshot.pages = chunks.map((chunk, i) => ({ attempt_id: f.snapshot.selected[0]!.attempt_id, page_index: i, entry_count: chunk.length,
    payload: encodeAlignmentPage({ ...page, pageIndex: BigInt(i), entries: chunk }) }));
  Object.assign(f.snapshot.attempts[0]!, { page_count: chunks.length, entry_count: entries.length,
    stored_bytes: f.snapshot.pages.reduce((n, p) => n + Buffer.byteLength(p.payload), 0),
    warnings_json: JSON.stringify([...new Set(f.snapshot.pages.flatMap(p => pageWarnings(decodeAlignmentPage(p.payload))))].sort()) });
}
for (const k of [1, 47, 50, 63, 97]) for (const straddle of [false, true])
  test(`long selected codec pages derive K=${k} with ${straddle ? "straddling" : "equal-endpoint"} first missing frame`, async () => {
    // @ts-expect-error Private oracle has no declaration.
    const m = await import("./durable-oracles.mjs"), f = longOmissionFixture(k, "none", straddle);
    assert.equal(m.longTailOmissionOracles(f.snapshot, f.child)[0].status, "pass");
    const result = m.longTailOmissionMetadata(f.snapshot, f.child);
    assert.equal(result.mappedFrames, k); assert.deepEqual(result.mappedSamples, { start: "0", end: String(k * 480) });
    assert.deepEqual(result.missingSamples, { start: String(k * 480), end: "47520" });
    assert.equal(result.frames, 99); assert.equal(result.finalPairRecorded, false);
    for (const forbidden of ["localStartNs", "hostBeforeNs", "payload", "credential"]) assert.equal(JSON.stringify(result).includes(forbidden), false);
  });
for (const suffix of ["none", "gap", "reconnect", "both"] as const) test(`long selected terminal ${suffix} suffix remains source-bound`, async () => {
  // @ts-expect-error Private oracle has no declaration.
  const m = await import("./durable-oracles.mjs"), f = longOmissionFixture(63, suffix);
  assert.equal(m.longTailOmissionOracles(f.snapshot, f.child)[0].status, "pass");
  assert.equal(m.longTailOmissionMetadata(f.snapshot, f.child).terminalSuffix.length, suffix === "both" ? 2 : suffix === "none" ? 0 : 1);
});
const longFaults = ["all-mapped", "all-missing", "hole", "remap", "premature-map", "pair1-after-first", "pair2-covers-last", "pair-gap", "pair-residual", "pair-negative-wall", "pair-sequence", "pair-bracket", "pair-resolution", "extra-pair", "reorder-pair", "drop-last", "duplicate-last", "domain", "epoch", "rounding", "source-rate", "source-denominator", "quality", "wall-run", "wall-rounding", "closed-gap", "reverse-suffix"];
for (const fault of longFaults) test(`long coherent selected mutant refuses ${fault} at its intended predicate`, async () => {
  // @ts-expect-error Private oracle has no declaration.
  const m = await import("./durable-oracles.mjs"), f = longOmissionFixture(47), entries = [...omissionEntries(f)];
  const at = entries.findIndex(e => e.kind === "frame" && e.provenance?.sequence === 48n), frame = entries[at], mapped = entries[2];
  if (frame?.kind !== "frame" || mapped?.kind !== "frame" || entries[1]?.kind !== "clock_pair" || entries[52]?.kind !== "clock_pair") throw new Error("fixture");
  if (fault === "all-mapped" || fault === "all-missing") {
    for (let i = 0; i < entries.length; i++) { const e = entries[i]; if (e?.kind === "frame") entries[i] = {
      ...e, wall: fault === "all-mapped" ? mapped.wall : null, reasons: fault === "all-mapped" ? [] : frame.reasons }; }
  } else if (fault === "hole") entries[2] = { ...mapped, wall: null, reasons: frame.reasons };
  else if (fault === "remap") { const e = entries[at + 1]; if (e?.kind !== "frame") throw new Error("fixture"); entries[at + 1] = { ...e, wall: mapped.wall, reasons: [] }; }
  else if (fault === "premature-map") { const e = entries[52]; if (e?.kind !== "clock_pair") throw new Error("fixture"); entries[52] = {
    ...e, pair: { ...e.pair, hostBeforeNs: e.pair.hostBeforeNs - 20_000_000n, hostAfterNs: e.pair.hostAfterNs - 20_000_000n, localUnixNs: e.pair.localUnixNs - 20_000_000n } }; }
  else if (fault.startsWith("pair") || fault === "extra-pair" || fault === "reorder-pair") {
    const index = fault === "pair1-after-first" ? 1 : 52, e = entries[index]; if (e?.kind !== "clock_pair") throw new Error("fixture");
    const p = e.pair;
    entries[index] = { kind: "clock_pair", pair: { ...p,
      hostBeforeNs: fault === "pair1-after-first" ? 1_010_000_000n : fault === "pair2-covers-last" ? 3_000_000_000n : fault === "pair-gap" ? 3_100_000_000n : p.hostBeforeNs,
      hostAfterNs: fault === "pair1-after-first" ? 1_010_000_100n : fault === "pair2-covers-last" ? 3_000_000_100n : fault === "pair-gap" ? 3_100_000_100n : fault === "pair-bracket" ? p.hostBeforeNs + 5_000_001n : p.hostAfterNs,
      localUnixNs: fault === "pair-residual" ? p.localUnixNs + 10_000_001n : fault === "pair-negative-wall" ? -1n : p.localUnixNs,
      sequence: fault === "pair-sequence" ? 3n : p.sequence, wallResolutionNs: fault === "pair-resolution" ? 1001n : p.wallResolutionNs } };
    if (fault === "extra-pair") entries.push(entries[52]!);
    if (fault === "reorder-pair") { const pair = entries.splice(52, 1)[0]!; entries.splice(51, 0, pair); }
  } else if (fault === "drop-last") { entries.pop(); f.recording.duration_ms = 1960; }
  else if (fault === "duplicate-last") entries.push(entries.at(-1)!);
  else if (fault === "closed-gap") entries.push({ kind: "audio_gap", startedAtMs: 1980n, endedAtMs: 1981n, reason: "capture_discontinuity" });
  else if (fault === "reverse-suffix") entries.push({ kind: "audio_gap", startedAtMs: 1980n, endedAtMs: null, reason: "capture_discontinuity" }, { kind: "discontinuity", captureEpoch: 1n, reason: "reconnect" });
  else if (fault === "quality") { const e = entries[3]; if (e?.kind !== "frame") throw new Error("fixture"); entries[3] = {
    ...e, captureStatus: "capture_alignment_missing", provenance: { ...e.provenance!, quality: "unknown_clock", span: null }, wall: null }; }
  else entries[2] = { ...mapped, epoch: { ...mapped.epoch!, clockDomainId: fault === "domain" ? "foreign" : "e2e-clock", captureEpoch: fault === "epoch" ? 2n : 1n },
    sampleRateHz: fault === "source-denominator" ? 23999 : 24000, captureStatus: fault === "quality" ? "capture_alignment_missing" : "available",
    provenance: { ...mapped.provenance!, captureEpoch: fault === "epoch" ? 2n : 1n,
      sourceRateHz: fault === "source-rate" ? 48000 : 24000, sourceStartNumerator: 0n,
      sourceEndNumerator: fault === "source-rate" ? 480n * 48000n : 480n * 24000n,
      sourceDenominator: fault === "source-denominator" ? 23999 : 24000, quality: fault === "quality" ? "unknown_clock" : "nominal_frame_endpoint_interpolation",
      span: fault === "quality" ? null : { ...mapped.provenance!.span!, roundingEnvelopeNs: fault === "rounding" ? 1001n : 1000n } },
    wall: fault === "quality" ? null : { ...mapped.wall!, wallRun: fault === "wall-run" ? 2n : 1n, interpolationRoundingNs: fault === "wall-rounding" ? 1n : 2n } };
  replaceLongEntries(f, entries);
  const result = m.longTailOmissionOracles(f.snapshot, f.child)[0]; assert.equal(result.status, "fail", fault);
  const category = fault.startsWith("pair") ? "pair|shape" : fault.includes("pair") ? "order" : fault.includes("last") ? "count|order" :
    fault.startsWith("wall") ? "wall" : fault.includes("gap") || fault.includes("suffix") ? "suffix" : ["domain", "epoch", "rounding", "source-rate", "source-denominator", "quality"].includes(fault) ? "frame" : "partition";
  assert.match(result.detail, new RegExp("long tail (" + (fault === "source-denominator" ? "evidence unavailable" : category) + ")"), fault);
  if (fault === "source-denominator") assert.throws(() => m.longTailOmissionMetadata(f.snapshot, f.child), /invalid fixed-rate recording duration/);
  else assert.throws(() => m.longTailOmissionMetadata(f.snapshot, f.child));
});
test("actual production merge retains synthetic prefix, tail and crossing wording independently of nullable wall", async () => {
  const f = longOmissionFixture(47), entries = omissionEntries(f), source = decodeAlignmentPage(f.snapshot.pages[0]!.payload).source;
  const ranges = [[0n, 4800n], [22080n, 23040n], [23520n, 28320n]] as const;
  const segments = ranges.map(([start, end], i) => ({ segmentId: String(i + 1), startedAtMs: start / 24n, endedAtMs: end / 24n,
    text: ["synthetic prefix wording", "synthetic crossing wording", "synthetic tail wording"][i]!, speakerCluster: "synthetic-cluster",
    mediaSampleRange: { startSampleInclusive: start, endSampleExclusive: end, sampleRateHz: 24000, gapOffsetMs: 0n,
      quantizationPolicy: "provider_seconds_outward_samples/v1" as const } }));
  const result = await mergeTimedRecordingEvidence({ source, bridgeSessionId: "bridge-fixture", entries, ui: [], live: [],
    final: { source, segments, warnings: [] }, uiLossReason: null, wordingLossReason: null });
  assert.deepEqual(result.segments.map(s => s.text), segments.map(s => s.text));
  assert.deepEqual(result.segments.map(s => s.range), segments.map(s => s.mediaSampleRange));
  assert.equal(result.segments[0]!.wall !== null, true); assert.equal(result.segments[1]!.wall, null); assert.equal(result.segments[2]!.wall, null);
  assert.deepEqual(result.segments.map(s => s.speaker.kind), ["anonymous", "anonymous", "anonymous"]);
});
test("owned synthetic SQLite production store selects long partial codec pages and readonly oracle derives its partition", async () => {
  // @ts-expect-error Private oracle has no declaration.
  const m = await import("./durable-oracles.mjs"), input = longOmissionFixture(63), dir = mkdtempSync(path.join(os.tmpdir(), "meeting-long-tail-store-")), filename = path.join(dir, "owned.db");
  const store = openSessionStore({ filename });
  try {
    const identity = buildMeetingIdentity({ providerMeetingId: "9007199254740993", meetingNo: "000000000", occurrenceStartedAt: "2026-10-01T10:00:00Z", title: "Synthetic", organizer: null });
    const coordinator = createCoordinator({ store, clock: { now: () => 1000 }, bridgeLeaseTtlMs: 30000, maxConcurrentSessions: 1 });
    coordinator.discover(identity); coordinator.advance(identity.occurrenceId, "joining"); coordinator.advance(identity.occurrenceId, "listening");
    store.beginReconciliationGeneration(identity.occurrenceId, "bridge-fixture", 1000); store.setReconciliationRuntimeSession(identity.occurrenceId, "bridge-fixture", 42n);
    const source = decodeAlignmentPage(input.snapshot.pages[0]!.payload).source;
    coordinator.finalizeWithRecording(identity.occurrenceId, { kind: "advance", toState: "finalizing" }, { handle: source.recordingHandle,
      encryptedPath: path.join(dir, "synthetic-ciphertext-locator"), sha256: source.sha256, keyId: "c".repeat(16), format: "pcm_s16le/24000/1", durationMs: 1980,
      captureDrain: { drain: "unconfirmed", reason: "final_clock_pair_omitted", boundary: null }, gaps: [], runtimeGaps: [],
      recovery: { bridgeSessionId: "bridge-fixture", capability: { ...source, keyId: "c".repeat(16), authorization: "d".repeat(64) } } }, "bridge-fixture");
    const recovery = store.getRecordingRecovery(identity.occurrenceId, "bridge-fixture", source.recordingHandle)!;
    const claim = store.beginRecordingAlignment(recovery.generationId, "synthetic-component");
    if (claim.kind !== "claimed") throw new Error("component claim");
    for (const row of input.snapshot.pages) store.appendRecordingAlignment(claim.attempt, decodeAlignmentPage(row.payload));
    store.completeRecordingAlignment(claim.attempt, { type: "recording_alignment_complete", source, pageCount: BigInt(input.snapshot.pages.length),
      coverageStatus: "partial", warnings: ["local_wall_timestamp_estimate", "missing_clock_pair", "wall_alignment_missing"], traversalSucceeded: true });
    const projection = m.readDurableEvidence(filename, identity.occurrenceId);
    assert.equal(m.longTailOmissionOracles(projection, input.child)[0].status, "pass");
    assert.equal(m.longTailOmissionMetadata(projection, input.child).mappedFrames, 63);
    assert.equal(projection.pages.length, 5); assert.equal(projection.recordings[0].capture_drain_final_pair_sequence, null);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
for (const fault of ["requested", "acknowledged", "confirmed", "legacy", "reason", "persisted-boundary", "position", "auth", "session", "bridge", "source", "hash", "key", "generation", "tentative", "unselected", "gap-disagreement"])
  test(`long selected source refuses stale or unbound ${fault}`, async () => {
    // @ts-expect-error Private oracle has no declaration.
    const m = await import("./durable-oracles.mjs"), f = longOmissionFixture(47, fault === "gap-disagreement" ? "gap" : "none");
    const stale = { captureEpoch: "1", lastFrameSequence: "99", outputEndSample: "47520", finalClockPairSequence: "2" };
    if (fault === "requested") f.child.captureFinish.requestedBoundary = stale;
    if (fault === "acknowledged") f.child.captureFinish.acknowledgedBoundary = stale;
    if (fault === "confirmed") { f.child.captureDrain.drain = "confirmed"; f.recording.capture_drain = "confirmed"; }
    if (fault === "legacy") f.recording.capture_drain = null;
    if (fault === "reason") f.child.captureDrain.reason = "capture_finish_timeout";
    if (fault === "persisted-boundary") f.recording.capture_drain_final_pair_sequence = "2";
    if (fault === "position") f.child.capturePosition.outputEndSample = "47519";
    if (fault === "auth") f.child.captureFinish.authenticated = false;
    if (fault === "session") f.child.captureFinish.sessionId = "43";
    if (fault === "bridge") f.child.captureFinish.bridgeSessionId = "foreign";
    if (fault === "source") f.snapshot.bindings[0]!.source_session_id = "43";
    if (fault === "hash") f.recording.sha256 = "d".repeat(64);
    if (fault === "key") f.snapshot.attempts[0]!.key_id = "d".repeat(16);
    if (fault === "generation") f.snapshot.attempts[0]!.generation_id = "foreign";
    if (fault === "tentative") f.snapshot.attempts[0]!.state = "staging";
    if (fault === "unselected") f.snapshot.selected = [];
    if (fault === "gap-disagreement") f.snapshot.runtimeGaps[0]!.started_at_ms = "1979";
    assert.equal(m.longTailOmissionOracles(f.snapshot, f.child)[0].status, "fail"); assert.throws(() => m.longTailOmissionMetadata(f.snapshot, f.child));
  });
// @ts-expect-error Test-only reopened evidence has no public declaration.
import { durableOracles } from "./durable-oracles.mjs";

// Synthetic metadata only. These oracle fault tests are not integration proof.
function fixture() {
  const occurrence = "9007199254740993@2026-10-01T10:00:00Z";
  const source = { sourceSessionId: 42n, recordingHandle: "a".repeat(32), sha256: "b".repeat(64) };
  const epoch = { bridgeSessionId: "bridge-fixture", clockDomainId: "e2e-clock", captureEpoch: 1n };
  const entries = Array.from({ length: 11 }, (_, i) => {
    const start = BigInt(i * 480), host = 1_000_000_000n + BigInt(i) * 20_000_000n;
    return { kind: "frame" as const, mediaStartSample: start, mediaEndSample: start + 480n, sampleRateHz: 24000, gapOffsetMs: 0n,
      epoch, provenance: { captureEpoch: 1n, sequence: BigInt(i + 1), outputStartSample: start, sampleCount: 480,
        sourceStartNumerator: start * 24000n, sourceEndNumerator: (start + 480n) * 24000n, sourceDenominator: 24000, sourceRateHz: 24000,
        quality: "nominal_frame_endpoint_interpolation" as const, span: { hostStartNs: host, hostEndNs: host + 20_000_000n,
          roundingEnvelopeNs: 1000n, captureUncertaintyNs: null } }, captureStatus: "available" as const, wall: null,
      reasons: ["wall_alignment_missing" as const] };
  });
  const payload = encodeAlignmentPage({ type: "recording_alignment_page", source, policy: ALIGNMENT_POLICY, pageIndex: 0n, entries });
  const text = "Meetbot, please answer?";
  const snapshot = {
    occurrence,
    live: [{ generation_id: "g", segment_id: "1", text, evidence: encodeLiveEvidence({ type: "voice_transcript_final", sessionId: 42n,
      segmentId: "1", turnId: null, text, captureUnavailableReason: "provider_offsets_unavailable" }), result: '{"kind":"anonymous","reason":"timing_unavailable"}',
      occurrence_id: occurrence, bridge_session_id: epoch.bridgeSessionId, runtime_session_id: "42", owner_state: "closed",
      ui_loss_reason: null, wording_loss_reason: null as string | null, live_rows: 1, capture_complete: 1, incomplete_reason: null }],
    recordings: [{ occurrence_id: occurrence, handle: source.recordingHandle, sha256: source.sha256, key_id: "c".repeat(16),
      duration_ms: 220, format: "pcm_s16le/24000/1", capture_drain: null as string | null, capture_drain_reason: null as string | null,
      capture_drain_epoch: null as string | null, capture_drain_last_frame_sequence: null as string | null,
      capture_drain_output_end_sample: null as string | null, capture_drain_final_pair_sequence: null as string | null }],
    gaps: [], runtimeGaps: [] as Array<{ started_at_ms: string; ended_at_ms: string | null; reason: string }>, bindings: [{ generation_id: "g", occurrence_id: occurrence, bridge_session_id: epoch.bridgeSessionId,
      source_session_id: "42", recording_handle: source.recordingHandle, sha256: source.sha256, key_id: "c".repeat(16), recording_kind: "final" }],
    selected: [{ generation_id: "g", attempt_id: "attempt" }],
    attempts: [{ generation_id: "g", attempt_id: "attempt", source_session_id: "42", recording_handle: source.recordingHandle,
      sha256: source.sha256, key_id: "c".repeat(16), timing_contract: "capture-clock/v1", state: "complete", page_count: 1, entry_count: 11,
      stored_bytes: Buffer.byteLength(payload), coverage_status: "partial", warnings_json: '["wall_alignment_missing"]' }],
    pages: [{ attempt_id: "attempt", page_index: 0, entry_count: 11, payload }],
  };
  const runtimeEvents = [{ type: "voice_transcript_final", session_id: "42", segment_id: "1" },
    { type: "response_authorized", session_id: "42", segment_id: "1", turn_id: "9" },
    { session_id: "42", generation_id: "9", event: { type: "turn_cancelled", turn_id: "9" } }];
  const tested = [{ text, segment: "1", turn: "9", authorized: true }];
  const interval = { captureAtFlush: { captureEpoch: "1", sequence: "1", outputEndSample: "480" },
    captureAfterFlush: { captureEpoch: "1", sequence: "11", outputEndSample: "5280" } };
  return { snapshot, options: { tested, runtimeEvents, interval } };
}
function failed(value: ReturnType<typeof fixture>) {
  return durableOracles(value.snapshot, value.options).filter((row: { status: string }) => row.status === "fail").map((row: { name: string }) => row.name);
}

test("reopened evidence binds live wording, one terminal and authenticated recorded frame coverage", () => {
  const f = fixture();
  const rows = durableOracles(f.snapshot, f.options);
  assert.deepEqual(rows.map((row: { name: string }) => row.name), ["durable_live_evidence", "durable_turn_terminals", "selected_recording_alignment", "recorded_capture_after_flush"]);
  assert.deepEqual(failed(f), []);
});

test("selected recording duration must match its decoded fixed-rate media timeline", () => {
  for (const duration of [0, 219, 221, -1, 220.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture(); f.snapshot.recordings[0]!.duration_ms = duration;
    assert.ok(failed(f).includes("selected_recording_alignment"), `must refuse duration ${duration}`);
  }
});

test("duration includes closed media gap offsets without extending an open trailing gap", () => {
  const f = fixture(), row = f.snapshot.pages[0]!, page = decodeAlignmentPage(row.payload);
  const frames = page.entries.map(entry => entry.kind === "frame" && entry.mediaStartSample > 0n
    ? { ...entry, gapOffsetMs: 100n } : entry);
  row.payload = encodeAlignmentPage({ ...page, entries: [frames[0]!,
    { kind: "audio_gap", startedAtMs: 20n, endedAtMs: 120n, reason: "capture_discontinuity" },
    ...frames.slice(1), { kind: "audio_gap", startedAtMs: 320n, endedAtMs: null, reason: "capture_discontinuity" }] });
  row.entry_count = 13;
  const attempt = f.snapshot.attempts[0]!;
  attempt.entry_count = row.entry_count; attempt.stored_bytes = Buffer.byteLength(row.payload);
  attempt.warnings_json = '["audio_missing","wall_alignment_missing"]';
  f.snapshot.runtimeGaps.push({ started_at_ms: "20", ended_at_ms: "120", reason: "capture_discontinuity" },
    { started_at_ms: "320", ended_at_ms: null, reason: "capture_discontinuity" });
  f.snapshot.recordings[0]!.duration_ms = 320;
  assert.deepEqual(failed(f), [], "gap before the selected post-flush interval preserves exact frame coverage");
  f.snapshot.recordings[0]!.duration_ms = 220;
  assert.ok(failed(f).includes("selected_recording_alignment"), "audio-only duration omits the closed media gap");
});

test("durable checks refuse unbound, lost, unresolved or contradictory evidence", () => {
  const cases: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ["durable_live_evidence", f => { f.snapshot.live[0]!.runtime_session_id = "43"; }],
    ["durable_live_evidence", f => { f.snapshot.live[0]!.result = "null"; }],
    ["durable_live_evidence", f => { f.snapshot.live[0]!.wording_loss_reason = "runtime_queue_overflow"; }],
    ["durable_live_evidence", f => { f.snapshot.live[0]!.text = "different question"; }],
    ["durable_turn_terminals", f => { f.options.runtimeEvents.push({ session_id: "42", generation_id: "9", event: { type: "turn_completed", turn_id: "9" } }); }],
    ["durable_turn_terminals", f => { f.options.runtimeEvents[1]!.segment_id = "2"; }],
    ["durable_turn_terminals", f => { f.options.runtimeEvents[1]!.session_id = "43"; }],
    ["durable_turn_terminals", f => { f.options.runtimeEvents[2]!.session_id = "43"; }],
    ["durable_turn_terminals", f => { f.options.runtimeEvents[2]!.generation_id = "10"; }],
    ["selected_recording_alignment", f => { f.snapshot.attempts[0]!.state = "staging"; }],
    ["selected_recording_alignment", f => { f.snapshot.bindings[0]!.sha256 = "d".repeat(64); }],
    ["selected_recording_alignment", f => { f.snapshot.pages[0]!.payload = "{}"; }],
    ["selected_recording_alignment", f => { f.snapshot.attempts[0]!.page_count = 2; }],
    ["selected_recording_alignment", f => { f.snapshot.attempts[0]!.coverage_status = "available"; }],
    ["recorded_capture_after_flush", f => { f.options.interval.captureAfterFlush.outputEndSample = "5760"; }],
    ["recorded_capture_after_flush", f => { f.options.interval.captureAfterFlush.captureEpoch = "2"; }],
  ];
  for (const [expected, mutate] of cases) {
    const f = fixture(); mutate(f);
    assert.ok(failed(f).includes(expected), `must refuse ${expected}`);
  }
});

test("recorded interval refuses missing frames and actual audio gaps without treating wall uncertainty as PCM loss", async () => {
  const { decodeAlignmentPage } = await import("../src/sessions/recording-alignment.ts");
  const f = fixture(), row = f.snapshot.pages[0]!;
  const page = decodeAlignmentPage(row.payload);
  row.payload = encodeAlignmentPage({ ...page, entries: page.entries.filter(entry => entry.kind !== "frame" || entry.provenance!.sequence !== 6n) }); row.entry_count -= 1;
  f.snapshot.attempts[0]!.entry_count -= 1; f.snapshot.attempts[0]!.stored_bytes = Buffer.byteLength(row.payload);
  assert.ok(failed(f).includes("recorded_capture_after_flush"));
  const gap = fixture();
  gap.snapshot.runtimeGaps.push({ started_at_ms: "100", ended_at_ms: "120", reason: "capture_discontinuity" });
  assert.ok(failed(gap).includes("recorded_capture_after_flush"));
});

test("negative decisions require the persisted Runtime session", () => {
  const f = fixture(); f.options.tested[0]!.authorized = false;
  f.options.runtimeEvents = [f.options.runtimeEvents[0]!, { type: "response_skipped", session_id: "42", segment_id: "1" }];
  assert.deepEqual(failed(f), []);
  f.options.runtimeEvents[1]!.session_id = "43";
  assert.ok(failed(f).includes("durable_turn_terminals"));
});

test("durable readers fail closed on missing SQLite schema and malformed or absent trace", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"), path = await import("node:path");
  const Database = (await import("better-sqlite3")).default;
  // @ts-expect-error Test-only reopened evidence has no public declaration.
  const { readDurableEvidence, readRuntimeTrace } = await import("./durable-oracles.mjs");
  const root = mkdtempSync(path.join(tmpdir(), "meeting-durable-reader-"));
  try {
    const filename = path.join(root, "empty.db");
    new Database(filename).close();
    assert.throws(() => readDurableEvidence(filename, "missing"), /no such table/);
    const trace = path.join(root, "trace.ndjson");
    writeFileSync(trace, "{invalid}\n");
    assert.throws(() => readRuntimeTrace(trace));
    writeFileSync(trace, "");
    assert.throws(() => readRuntimeTrace(trace), /missing Runtime trace/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Synthetic persisted/alignment metadata is C-only predicate coverage.
function tailFixture() {
  const f = fixture(), boundary = { captureEpoch: "1", lastFrameSequence: "11", outputEndSample: "5280", finalClockPairSequence: "3" };
  const recording = f.snapshot.recordings[0]!;
  Object.assign(recording, { capture_drain: "confirmed", capture_drain_reason: null,
    capture_drain_epoch: "1", capture_drain_last_frame_sequence: "11", capture_drain_output_end_sample: "5280", capture_drain_final_pair_sequence: "3" });
  const child = { framesSent: 11, capturePosition: { captureEpoch: "1", sequence: "11", outputEndSample: "5280" },
    captureDrain: { drain: "confirmed", reason: null, boundary: { ...boundary } }, captureFinish: {
      sessionId: "42", bridgeSessionId: "bridge-fixture", authenticated: true, requestedBoundary: { ...boundary }, acknowledgedBoundary: { ...boundary } } };
  return { ...f, recording, child };
}
test("positive baseline tail oracle requires exact persisted drain and every authenticated final sample", async () => {
  // @ts-expect-error Test-only reopened evidence has no public declaration.
  const module = await import("./durable-oracles.mjs");
  assert.equal(typeof module.captureTailOracles, "function", "baseline must check reopened exact capture finish/tail");
  const f = tailFixture(), rows = module.captureTailOracles(f.snapshot, f.child);
  assert.deepEqual(rows.map((row: { name: string; status: string }) => [row.name, row.status]), [["confirmed_capture_tail", "pass"]]);
});
test("tail oracle refuses absent, NULL, unconfirmed, mismatched and unselected drain evidence", async () => {
  // @ts-expect-error Test-only reopened evidence has no public declaration.
  const { captureTailOracles } = await import("./durable-oracles.mjs");
  assert.equal(typeof captureTailOracles, "function");
  const cases: Array<(f: ReturnType<typeof tailFixture>) => void> = [
    f => { f.recording.capture_drain = null; }, f => { f.recording.capture_drain = "unconfirmed"; },
    f => { f.recording.capture_drain_output_end_sample = "5760"; }, f => { f.recording.capture_drain_final_pair_sequence = "4"; },
    f => { f.child.captureFinish.authenticated = false; }, f => { f.child.captureFinish.sessionId = "43"; },
    f => { f.child.captureFinish.bridgeSessionId = "unrelated"; }, f => { f.child.captureFinish.acknowledgedBoundary.captureEpoch = "2"; },
    f => { f.child.capturePosition.sequence = "10"; }, f => { f.child.captureDrain.drain = "unconfirmed"; },
    f => { f.snapshot.selected = []; }, f => { f.snapshot.attempts[0]!.state = "staging"; },
    f => { f.child.captureDrain.boundary.outputEndSample = "05280"; },
  ];
  for (const mutate of cases) {
    const f = tailFixture(); mutate(f);
    assert.equal(captureTailOracles(f.snapshot, f.child)[0].status, "fail");
  }
});
test("tail coverage refuses missing/duplicate final frame and wrong epoch/sample end without requiring wall timestamps", async () => {
  // @ts-expect-error Test-only reopened evidence has no public declaration.
  const { captureTailOracles } = await import("./durable-oracles.mjs"); assert.equal(typeof captureTailOracles, "function");
  for (const fault of ["missing", "duplicate", "epoch", "sample"]) {
    const f = tailFixture(), row = f.snapshot.pages[0]!, page = decodeAlignmentPage(row.payload), final = page.entries.at(-1)!;
    assert.equal(final.kind, "frame"); if (final.kind !== "frame") throw new Error("fixture");
    const entries = fault === "missing" ? page.entries.slice(0, -1) : fault === "duplicate" ? [...page.entries, final] :
      [...page.entries.slice(0, -1), fault === "epoch" ? { ...final, epoch: { ...final.epoch!, captureEpoch: 2n }, provenance: { ...final.provenance!, captureEpoch: 2n } } :
        { ...final, provenance: { ...final.provenance!, outputStartSample: 4799n, sourceStartNumerator: 4799n * 24000n, sourceEndNumerator: 5279n * 24000n } }];
    row.payload = encodeAlignmentPage({ ...page, entries }); row.entry_count = entries.length;
    Object.assign(f.snapshot.attempts[0]!, { entry_count: entries.length, stored_bytes: Buffer.byteLength(row.payload) });
    assert.equal(captureTailOracles(f.snapshot, f.child)[0].status, "fail", fault);
  }
  const f = tailFixture(); assert.equal(captureTailOracles(f.snapshot, f.child)[0].status, "pass", "partial wall coverage retains full PCM tail");
});

test("reopened synthetic SQLite reader retains all four exact drain boundary columns", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs"), { tmpdir } = await import("node:os"), path = await import("node:path");
  const Database = (await import("better-sqlite3")).default;
  const { openSessionStore } = await import("../src/adapters/sqlite-session-store.ts");
  // @ts-expect-error Test-only reopened evidence has no public declaration.
  const { readDurableEvidence } = await import("./durable-oracles.mjs");
  const root = mkdtempSync(path.join(tmpdir(), "meeting-synthetic-drain-"));
  try {
    const filename = path.join(root, "synthetic.db"), store = openSessionStore({ filename }); store.close();
    const db = new Database(filename);
    try {
      // Synthetic metadata only, with foreign-key checks disabled on this
      // separate fixture connection; no application finalization is claimed.
      db.pragma("foreign_keys = OFF");
      db.prepare(`INSERT INTO recordings(occurrence_id,handle,sha256,duration_ms,finalized_at_ms,format,key_id,
        capture_drain,capture_drain_reason,capture_drain_epoch,capture_drain_last_frame_sequence,capture_drain_output_end_sample,capture_drain_final_pair_sequence)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("synthetic", "a".repeat(32), "b".repeat(64), 220, 1, "pcm_s16le/24000/1", "c".repeat(16),
        "confirmed", null, "9007199254740993", "11", "5280", "3");
    } finally { db.close(); }
    const recording = readDurableEvidence(filename, "synthetic").recordings[0];
    assert.deepEqual([recording.capture_drain_epoch, recording.capture_drain_last_frame_sequence,
      recording.capture_drain_output_end_sample, recording.capture_drain_final_pair_sequence], ["9007199254740993", "11", "5280", "3"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("retained positive evidence keeps exact drain/time but excludes raw pages, credentials and recovery authorization", async () => {
  // @ts-expect-error Test-only reopened evidence has no public declaration.
  const module = await import("./durable-oracles.mjs");
  assert.equal(typeof module.durableMetadata, "function", "silent baseline must retain sanitized oracle facts");
  assert.equal(typeof module.captureFinishMetadata, "function", "bridge metadata must whitelist exact finish/time evidence");
  const f = tailFixture();
  Object.assign(f.snapshot, { recoveryAuthorization: "PRIVATE_CAPABILITY" });
  Object.assign(f.snapshot.recordings[0]!, { credential: "PRIVATE_CREDENTIAL" });
  Object.assign(f.snapshot.pages[0]!, { recoveryAuthorization: "PRIVATE_CAPABILITY" });
  const endObservation = { reason: "ended", observedAt: "2026-10-05T10:00:00.123Z", observationTiming: {
    clockDomainId: "e2e-clock", hostBeforeNs: "100", hostAfterNs: "200" }, observationTimingReason: null };
  const child = { ...f.child, endObservation, credential: "PRIVATE_CREDENTIAL" };
  Object.assign(child.captureFinish, { credential: "PRIVATE_CREDENTIAL", rawPacket: "PRIVATE_PACKET" });
  const durable = module.durableMetadata(f.snapshot), finish = module.captureFinishMetadata(child);
  assert.equal(durable.recordings[0].capture_drain_output_end_sample, "5280");
  assert.deepEqual(durable.pageMetadata, [{ attempt_id: "attempt", page_index: 0, entry_count: 11,
    storedBytes: Buffer.byteLength(f.snapshot.pages[0]!.payload) }]);
  assert.deepEqual(finish.endObservation, endObservation); assert.deepEqual(finish.captureDrain, f.child.captureDrain);
  assert.equal(finish.captureFinish.sessionId, "42"); assert.deepEqual(finish.captureFinish.acknowledgedBoundary, f.child.captureDrain.boundary);
  const retained = JSON.stringify({ durable, finish });
  for (const privateValue of ["PRIVATE_CAPABILITY", "PRIVATE_CREDENTIAL", "PRIVATE_PACKET", '"payload"']) assert.equal(retained.includes(privateValue), false);
});


test("silent positive evidence retains exact persisted recovery bindings and excludes private binding fields", async () => {
  // @ts-expect-error Test-only reopened evidence has no public declaration.
  const { durableMetadata } = await import("./durable-oracles.mjs");
  const f = tailFixture(); f.snapshot.live = [];
  Object.assign(f.snapshot.bindings[0]!, { recoveryAuthorization: "PRIVATE_BINDING_AUTHORIZATION", credential: "PRIVATE_BINDING_CREDENTIAL" });
  const changed = structuredClone(f.snapshot); changed.bindings[0]!.bridge_session_id = "different-persisted-bridge";
  const retained = durableMetadata(f.snapshot);
  assert.notDeepEqual(retained, durableMetadata(changed), "retained silent evidence must distinguish persisted bridge bindings");
  assert.deepEqual(retained.bindings, [{ generation_id: "g", occurrence_id: "9007199254740993@2026-10-01T10:00:00Z",
    bridge_session_id: "bridge-fixture", source_session_id: "42", recording_handle: "a".repeat(32), sha256: "b".repeat(64),
    key_id: "c".repeat(16), recording_kind: "final" }]);
  assert.deepEqual(retained.liveRows, []);
  const serialized = JSON.stringify(retained);
  assert.equal(serialized.includes("PRIVATE_BINDING_AUTHORIZATION"), false);
  assert.equal(serialized.includes("PRIVATE_BINDING_CREDENTIAL"), false);
});

// Synthetic private-codec pages: threshold expectations are not Runtime proof.
export function timingFixture() {
  const f = tailFixture(), row = f.snapshot.pages[0]!, page = decodeAlignmentPage(row.payload), template = page.entries[0]!;
  if (template.kind !== "frame") throw new Error("fixture");
  const entries = Array.from({ length: 51 }, (_, i) => {
    const start = BigInt(i) * 480n, host = 1_000_000_000n + BigInt(i) * 20_000_000n, target = i === 25;
    return { ...template, mediaStartSample: start, mediaEndSample: start + 480n,
      provenance: { ...template.provenance!, sequence: BigInt(i + 1), outputStartSample: start,
        sourceStartNumerator: start * 24000n, sourceEndNumerator: (start + 480n) * 24000n,
        span: { ...template.provenance!.span!, hostStartNs: host - (target ? 2n : 0n), hostEndNs: host + 20_000_000n } },
      captureStatus: target ? "capture_alignment_missing" as const : "available" as const,
      reasons: target ? ["inconsistent_coordinates" as const, "capture_alignment_missing" as const, "wall_alignment_missing" as const] : template.reasons };
  });
  row.payload = encodeAlignmentPage({ ...page, entries }); row.entry_count = 51;
  Object.assign(f.snapshot.attempts[0]!, { entry_count: 51, stored_bytes: Buffer.byteLength(row.payload), warnings_json: JSON.stringify(pageWarnings({ ...page, entries })) });
  Object.assign(f.recording, { duration_ms: 1020, capture_drain_last_frame_sequence: "51", capture_drain_output_end_sample: "24480" });
  f.child.framesSent = 51; f.child.capturePosition.sequence = "51"; f.child.capturePosition.outputEndSample = "24480";
  for (const boundary of [f.child.captureDrain.boundary, f.child.captureFinish.requestedBoundary, f.child.captureFinish.acknowledgedBoundary]) {
    boundary.lastFrameSequence = "51"; boundary.outputEndSample = "24480";
  }
  const child = { ...f.child, mediaTiming: "invalid2ns", mediaTimingTargetSequence: "26" };
  return { ...f, child };
}
function mutateTimingPage(f: ReturnType<typeof timingFixture>, mutate: (page: ReturnType<typeof decodeAlignmentPage>) => ReturnType<typeof decodeAlignmentPage>) {
  const row = f.snapshot.pages[0]!, page = mutate(decodeAlignmentPage(row.payload));
  row.payload = encodeAlignmentPage(page); row.entry_count = page.entries.length;
  Object.assign(f.snapshot.attempts[0]!, { entry_count: page.entries.length, stored_bytes: Buffer.byteLength(row.payload), warnings_json: JSON.stringify(pageWarnings(page)) });
}
test("invalid2ns strict oracle derives a safe summary only from selected COMPLETE bound pages", async () => {
  // @ts-expect-error Private test route has no declaration.
  const m = await import("./durable-oracles.mjs");
  assert.equal(typeof m.mediaTimingOracles, "function"); assert.equal(typeof m.mediaTimingMetadata, "function");
  const f = timingFixture();
  assert.equal(m.mediaTimingOracles(f.snapshot, f.child, "invalid2ns")[0].status, "pass");
  Object.assign(f.snapshot.bindings[0]!, { recoveryAuthorization: "PRIVATE_AUTH" });
  const summary = m.mediaTimingMetadata(f.snapshot, f.child, "invalid2ns");
  assert.deepEqual(summary.target, { sequence: "26", sourceStartSample: "12000", sourceEndSample: "12480", overlapNs: "2",
    captureStatus: "capture_alignment_missing", wall: null, reasons: ["capture_alignment_missing", "inconsistent_coordinates", "wall_alignment_missing"] });
  assert.deepEqual(m.captureFinishMetadata(f.child).mediaTiming, { mode: "invalid2ns", targetSequence: "26" });
  assert.equal(summary.frames, 51); assert.equal(summary.samples, "24480"); assert.equal(summary.durationMs, 1020);
  for (const value of ["PRIVATE_AUTH", '"payload"', '"provenance"', '"credential"']) assert.equal(JSON.stringify(summary).includes(value), false);
  assert.equal(m.captureTailOracles(f.snapshot, f.child)[0].status, "fail", "normal oracle remains strict");
});
test("invalid2ns mutation matrix refuses timing, source, selection, samples, gaps and false finish", async () => {
  // @ts-expect-error Private test route has no declaration.
  const m = await import("./durable-oracles.mjs"); assert.equal(typeof m.mediaTimingOracles, "function");
  const pageFaults = ["available", "1ns", "3ns", "sequence", "missing", "duplicate", "samples", "end", "warning", "gap", "rounding"];
  for (const fault of pageFaults) {
    const f = timingFixture(); mutateTimingPage(f, page => {
      const entries = [...page.entries], frame = entries[25]!;
      if (frame.kind !== "frame") throw new Error("fixture");
      if (fault === "missing") entries.splice(25, 1);
      else if (fault === "duplicate") entries.splice(25, 0, frame);
      else if (fault === "gap") entries.push({ kind: "audio_gap", startedAtMs: 500n, endedAtMs: 501n, reason: "capture_discontinuity" });
      else entries[25] = { ...frame,
        captureStatus: fault === "available" ? "available" : frame.captureStatus,
        mediaEndSample: ["end", "samples"].includes(fault) ? frame.mediaEndSample - 1n : frame.mediaEndSample,
        reasons: fault === "warning" ? ["capture_alignment_missing", "wall_alignment_missing"] : frame.reasons,
        provenance: { ...frame.provenance!, sequence: fault === "sequence" ? 27n : 26n,
          sampleCount: ["end", "samples"].includes(fault) ? 479 : 480,
          sourceEndNumerator: ["end", "samples"].includes(fault) ? 12479n * 24000n : frame.provenance!.sourceEndNumerator,
          span: { ...frame.provenance!.span!, hostStartNs: fault === "1ns" ? 1_499_999_999n : fault === "3ns" ? 1_499_999_997n : frame.provenance!.span!.hostStartNs,
            roundingEnvelopeNs: fault === "rounding" ? 1001n : 1000n } } };
      return { ...page, entries };
    });
    assert.equal(m.mediaTimingOracles(f.snapshot, f.child, "invalid2ns")[0].status, "fail", fault);
  }
  const cases: Array<(f: ReturnType<typeof timingFixture>) => void> = [
    f => { f.snapshot.bindings[0]!.source_session_id = "43"; }, f => { f.snapshot.bindings[0]!.sha256 = "d".repeat(64); },
    f => { f.snapshot.attempts[0]!.state = "staging"; }, f => { f.snapshot.selected = []; },
    f => { f.snapshot.attempts[0]!.coverage_status = "unavailable_legacy"; }, f => { f.snapshot.attempts[0]!.warnings_json = "[]"; },
    f => { f.recording.capture_drain_output_end_sample = "24479"; }, f => { f.child.captureFinish.acknowledgedBoundary.finalClockPairSequence = "4"; },
    f => {
      for (const boundary of [f.child.captureDrain.boundary, f.child.captureFinish.requestedBoundary, f.child.captureFinish.acknowledgedBoundary]) boundary.finalClockPairSequence = "4";
      f.recording.capture_drain_final_pair_sequence = "4";
    },
    f => { f.child.mediaTiming = "normal"; }, f => { f.child.mediaTimingTargetSequence = "27"; },
    f => { f.snapshot.runtimeGaps.push({ started_at_ms: "500", ended_at_ms: null, reason: "capture_discontinuity" }); },
    f => { f.snapshot.pages[0]!.attempt_id = "unselected"; },
  ];
  for (const mutate of cases) { const f = timingFixture(); mutate(f); assert.equal(m.mediaTimingOracles(f.snapshot, f.child, "invalid2ns")[0].status, "fail"); }
  const f = timingFixture(); f.snapshot.runtimeGaps.push({ started_at_ms: "1020", ended_at_ms: null, reason: "capture_discontinuity" });
  assert.equal(m.mediaTimingOracles(f.snapshot, f.child, "invalid2ns")[0].status, "pass", "open trailing gap at final sample time is preserved");
  assert.equal(m.mediaTimingOracles(f.snapshot, f.child, "normal")[0].status, "fail");
});

// Review regressions use the actual private codec and coherent selected totals.
for (const scope of ["target frame", "all frames", "epoch metadata"]) test(`MT-R1 refuses foreign clock domain in ${scope} before deriving overlap`, async () => {
  // @ts-expect-error Private test route has no declaration.
  const m = await import("./durable-oracles.mjs");
  const f = timingFixture(); mutateTimingPage(f, page => ({ ...page, entries: scope === "epoch metadata"
    ? [{ kind: "epoch", epoch: { bridgeSessionId: "bridge-fixture", captureEpoch: 1n, clockDomainId: "different-clock" } }, ...page.entries]
    : page.entries.map((entry, i) => entry.kind === "frame" && (scope === "all frames" || i === 25)
      ? { ...entry, epoch: { ...entry.epoch!, clockDomainId: "different-clock" } } : entry) }));
  assert.equal(m.mediaTimingOracles(f.snapshot, f.child, "invalid2ns")[0].status, "fail", scope);
  assert.throws(() => m.mediaTimingMetadata(f.snapshot, f.child, "invalid2ns"), /epoch|clock/);
});
test("MT-R2 refuses additional capture failure reasons in available neighbors and fixed target", async () => {
  // @ts-expect-error Private test route has no declaration.
  const m = await import("./durable-oracles.mjs");
  const reasons = ["source_drop", "sequence_hole", "reconnect", "pause", "epoch_reset", "missing_timing", "inconsistent_coordinates",
    "source_discontinuity", "alignment_limit_exceeded", "audio_missing", "capture_alignment_missing", "unavailable_legacy"] as const;
  for (const reason of reasons) {
    for (const index of [24, 25, 26]) {
      if (index === 25 && ["inconsistent_coordinates", "capture_alignment_missing"].includes(reason)) continue;
      const f = timingFixture(); mutateTimingPage(f, page => ({ ...page, entries: page.entries.map((entry, i) =>
        entry.kind === "frame" && i === index ? { ...entry, reasons: [...entry.reasons, reason] } : entry) }));
      assert.equal(m.mediaTimingOracles(f.snapshot, f.child, "invalid2ns")[0].status, "fail", `${index + 1}:${reason}`);
      assert.throws(() => m.mediaTimingMetadata(f.snapshot, f.child, "invalid2ns"));
    }
  }
});
for (const kind of ["source_drop", "inconsistent_coordinates", "alignment_limit"] as const) test(`MT-R2 refuses non-frame ${kind} despite coherent warning and byte totals`, async () => {
  // @ts-expect-error Private test route has no declaration.
  const m = await import("./durable-oracles.mjs");
  const f = timingFixture(); mutateTimingPage(f, page => ({ ...page, entries: [...page.entries,
    kind === "alignment_limit" ? { kind: "alignment_limit" } : { kind: "discontinuity", captureEpoch: 1n, reason: kind }] }));
  assert.equal(m.mediaTimingOracles(f.snapshot, f.child, "invalid2ns")[0].status, "fail", kind);
  assert.throws(() => m.mediaTimingMetadata(f.snapshot, f.child, "invalid2ns"));
});
test("repaired fixed cut permits independent wall uncertainty and same-identity epoch metadata", async () => {
  // @ts-expect-error Private test route has no declaration.
  const m = await import("./durable-oracles.mjs");
  const f = timingFixture(), wallReasons = ["wall_clock_discontinuity", "clock_pair_gap", "clock_bracket_exceeded",
    "missing_clock_pair", "clock_domain_mismatch", "arithmetic_overflow"] as const;
  mutateTimingPage(f, page => ({ ...page, entries: [
    { kind: "epoch", epoch: { bridgeSessionId: "bridge-fixture", clockDomainId: "e2e-clock", captureEpoch: 1n } },
    ...page.entries.map((entry, i) => entry.kind === "frame" && i < wallReasons.length
      ? { ...entry, reasons: ["wall_alignment_missing", wallReasons[i]!] } : entry)] }));
  f.snapshot.runtimeGaps.push({ started_at_ms: "1020", ended_at_ms: null, reason: "capture_discontinuity" });
  assert.equal(m.mediaTimingOracles(f.snapshot, f.child, "invalid2ns")[0].status, "pass");
  assert.equal(m.mediaTimingMetadata(f.snapshot, f.child, "invalid2ns").target.overlapNs, "2");
});

for (const identity of ["bridge", "capture epoch"]) test(`MT-R1 refuses contradictory ${identity} in accepted epoch metadata`, async () => {
  // @ts-expect-error Private test route has no declaration.
  const m = await import("./durable-oracles.mjs");
  const f = timingFixture(); mutateTimingPage(f, page => ({ ...page, entries: [
    { kind: "epoch", epoch: { bridgeSessionId: identity === "bridge" ? "other-bridge" : "bridge-fixture",
      clockDomainId: "e2e-clock", captureEpoch: identity === "capture epoch" ? 2n : 1n } }, ...page.entries] }));
  assert.equal(m.mediaTimingOracles(f.snapshot, f.child, "invalid2ns")[0].status, "fail");
  assert.throws(() => m.mediaTimingMetadata(f.snapshot, f.child, "invalid2ns"), /epoch/);
});

// Synthetic selected pages only: no application DB, recording or receipt writes.
export function omissionFixture(suffix: "none" | "gap" | "reconnect" | "both" = "none") {
  const f = timingFixture(), page = decodeAlignmentPage(f.snapshot.pages[0]!.payload), template = page.entries[0]!;
  if (template.kind !== "frame") throw new Error("fixture");
  const epoch = { bridgeSessionId: "bridge-fixture", clockDomainId: "e2e-clock", captureEpoch: 1n };
  const pair = { clockDomainId: "e2e-clock", wallEpoch: 1n, sequence: 1n, hostBeforeNs: 900_000_000n,
    localUnixNs: 1_790_000_000_000_000_000n, hostAfterNs: 910_000_000n, wallResolutionNs: 1000n, externalUtcAccuracyNs: null };
  const frames = Array.from({ length: 49 }, (_, i) => {
    const start = BigInt(i * 480), host = 1_000_000_000n + BigInt(i) * 20_000_000n;
    return { ...template, epoch, mediaStartSample: start, mediaEndSample: start + 480n,
      captureStatus: "available" as const, wall: null, reasons: ["missing_clock_pair" as const, "wall_alignment_missing" as const],
      provenance: { ...template.provenance!, sequence: BigInt(i + 1), outputStartSample: start,
        sourceStartNumerator: start * 24000n, sourceEndNumerator: (start + 480n) * 24000n,
        span: { ...template.provenance!.span!, hostStartNs: host, hostEndNs: host + 20_000_000n } } };
  });
  const entries: Array<(typeof page.entries)[number]> = [{ kind: "epoch", epoch }, { kind: "clock_pair", pair }, ...frames];
  if (["reconnect", "both"].includes(suffix)) entries.push({ kind: "discontinuity", captureEpoch: 1n, reason: "reconnect" });
  if (["gap", "both"].includes(suffix)) entries.push({ kind: "audio_gap", startedAtMs: 980n, endedAtMs: null, reason: "capture_discontinuity" });
  Object.assign(f.recording, { duration_ms: 980, capture_drain: "unconfirmed", capture_drain_reason: "final_clock_pair_omitted",
    capture_drain_epoch: null, capture_drain_last_frame_sequence: null, capture_drain_output_end_sample: null, capture_drain_final_pair_sequence: null });
  const position = { captureEpoch: "1", sequence: "49", outputEndSample: "23520" };
  const child = { ...f.child, mediaTiming: "omit-final-pair", mediaTimingTargetSequence: null, framesSent: 49,
    mediaClosedReason: "final_clock_pair_omitted", capturePosition: { ...position },
    captureDrain: { drain: "unconfirmed", reason: "final_clock_pair_omitted", boundary: null as null | Record<string, string> },
    captureFinish: { ...f.child.captureFinish, requestedBoundary: null as null | Record<string, string>,
      acknowledgedBoundary: null as null | Record<string, string>, capturePosition: { ...position } } };
  const result = { ...f, child };
  replaceOmissionEntries(result, entries);
  if (["gap", "both"].includes(suffix)) result.snapshot.runtimeGaps.push({ started_at_ms: "980", ended_at_ms: null, reason: "capture_discontinuity" });
  return result;
}
export function replaceOmissionEntries(f: ReturnType<typeof omissionFixture>, entries: ReturnType<typeof decodeAlignmentPage>["entries"]) {
  const page = decodeAlignmentPage(f.snapshot.pages[0]!.payload);
  const chunks = [entries.slice(0, 27), entries.slice(27)];
  f.snapshot.pages = chunks.map((chunk, i) => ({ attempt_id: "attempt", page_index: i, entry_count: chunk.length,
    payload: encodeAlignmentPage({ ...page, pageIndex: BigInt(i), entries: chunk }) }));
  Object.assign(f.snapshot.attempts[0]!, { page_count: 2, entry_count: entries.length,
    stored_bytes: f.snapshot.pages.reduce((n, row) => n + Buffer.byteLength(row.payload), 0),
    warnings_json: JSON.stringify([...new Set(f.snapshot.pages.flatMap(row => pageWarnings(decodeAlignmentPage(row.payload))))].sort()) });
}
export function omissionEntries(f: ReturnType<typeof omissionFixture>) { return f.snapshot.pages.flatMap(row => decodeAlignmentPage(row.payload).entries); }
for (const suffix of ["none", "gap", "reconnect", "both"] as const) test(`omission strict oracle retains all 49 unmapped frames with genuine ${suffix} terminal suffix`, async () => {
  // @ts-expect-error Private test route has no declaration.
  const m = await import("./durable-oracles.mjs");
  assert.equal(typeof m.tailOmissionOracles, "function"); assert.equal(typeof m.tailOmissionMetadata, "function");
  const f = omissionFixture(suffix);
  assert.deepEqual(m.tailOmissionOracles(f.snapshot, f.child).map((row: { name: string; status: string }) => [row.name, row.status]), [["media_timing_omit_final_pair", "pass"]]);
  Object.assign(f.snapshot.bindings[0]!, { recoveryAuthorization: "PRIVATE_CAPABILITY" });
  const summary = m.tailOmissionMetadata(f.snapshot, f.child);
  assert.equal(summary.frames, 49); assert.equal(summary.samples, "23520"); assert.equal(summary.durationMs, 980);
  assert.equal(summary.coverageStatus, "partial"); assert.equal(summary.initialPairSequence, "1");
  assert.deepEqual([summary.finalPairRecorded, summary.finishRequested, summary.finishAcknowledged], [false, false, false]);
  assert.deepEqual(summary.captureDrain, { drain: "unconfirmed", reason: "final_clock_pair_omitted", boundary: null });
  assert.deepEqual(summary.lastFrame, { sequence: "49", sourceStartSample: "23040", sourceEndSample: "23520", captureStatus: "available", wall: null,
    reasons: ["missing_clock_pair", "wall_alignment_missing"] });
  assert.equal(summary.terminalSuffix.length, suffix === "both" ? 2 : suffix === "none" ? 0 : 1);
  assert.deepEqual(m.captureFinishMetadata(f.child).mediaTiming, { mode: "omit-final-pair" });
  for (const secret of ["PRIVATE_CAPABILITY", '"payload"', '"provenance"', '"credential"', '"localUnixNs"'])
    assert.equal(JSON.stringify(summary).includes(secret), false);
  assert.equal(m.captureTailOracles(f.snapshot, f.child)[0].status, "fail");
});
// Semantic changes use the actual codec and refreshed bytes/counts/warning union.
for (const fault of ["wall-prefix", "wall-tail", "missing-pair", "extra-pair", "duplicate-pair", "duplicate-epoch", "missing-tail", "duplicate-tail",
  "samples", "end", "duration", "rational", "rate", "quality", "rounding", "uncertainty", "foreign-frame", "foreign-all", "foreign-epoch", "foreign-pair",
  "pair-sequence", "pair-wall-epoch", "pair-resolution", "pair-accuracy", "overlap", "interior-reconnect", "interior-gap", "reverse-suffix", "duplicate-suffix",
  "closed-gap", "late-gap", "gap-disagreement", "gap-duplicate", "limit", "capture-loss", "source-loss", "audio-loss", "local-wall", "missing-reason"])
  test(`omission rejects coherent selected ${fault}`, async () => {
    // @ts-expect-error Private test route has no declaration.
    const m = await import("./durable-oracles.mjs");
    const f = omissionFixture(fault.includes("suffix") || fault.includes("gap") ? "both" : "none"), entries = omissionEntries(f);
    const index = fault === "wall-prefix" ? 2 : 50, frame = entries[index]!;
    if (frame.kind !== "frame") throw new Error("fixture");
    const p = frame.provenance!;
    if (fault === "missing-pair") entries.splice(1, 1);
    else if (["extra-pair", "duplicate-pair"].includes(fault)) {
      const entry = entries[1]!; if (entry.kind !== "clock_pair") throw new Error("fixture");
      entries.push({ ...entry, pair: { ...entry.pair, sequence: fault === "extra-pair" ? 2n : 1n } });
    } else if (fault === "duplicate-epoch") entries.splice(1, 0, entries[0]!);
    else if (fault === "missing-tail") { entries.splice(50, 1); f.recording.duration_ms = 960; }
    else if (fault === "duplicate-tail") entries.splice(50, 0, frame);
    else if (fault === "duration") f.recording.duration_ms = 981;
    else if (fault.startsWith("pair-") || fault === "foreign-pair") {
      const entry = entries[1]!; if (entry.kind !== "clock_pair") throw new Error("fixture");
      entries[1] = { ...entry, pair: { ...entry.pair, clockDomainId: fault === "foreign-pair" ? "other" : entry.pair.clockDomainId,
        sequence: fault === "pair-sequence" ? 2n : 1n, wallEpoch: fault === "pair-wall-epoch" ? 2n : 1n,
        wallResolutionNs: fault === "pair-resolution" ? 1001n : 1000n, externalUtcAccuracyNs: fault === "pair-accuracy" ? 0n : null } };
    } else if (fault === "foreign-epoch") { const entry = entries[0]!; if (entry.kind !== "epoch") throw new Error("fixture"); entries[0] = { ...entry, epoch: { ...entry.epoch, clockDomainId: "other" } }; }
    else if (fault === "foreign-all") for (let i = 2; i <= 50; i++) { const e = entries[i]!; if (e.kind === "frame") entries[i] = { ...e, epoch: { ...e.epoch!, clockDomainId: "other" } }; }
    else if (fault === "interior-reconnect") entries.splice(25, 0, { kind: "discontinuity", captureEpoch: 1n, reason: "reconnect" });
    else if (fault === "interior-gap") entries.splice(25, 0, { kind: "audio_gap", startedAtMs: 979n, endedAtMs: null, reason: "capture_discontinuity" });
    else if (fault === "reverse-suffix") entries.splice(51, 2, entries[52]!, entries[51]!);
    else if (fault === "duplicate-suffix") entries.push(entries[51]!);
    else if (fault === "closed-gap" || fault === "late-gap") { const e = entries[52]!; if (e.kind !== "audio_gap") throw new Error("fixture"); entries[52] = { ...e, startedAtMs: fault === "late-gap" ? 981n : 980n, endedAtMs: fault === "closed-gap" ? 981n : null }; }
    else if (fault === "gap-disagreement") f.snapshot.runtimeGaps[0]!.started_at_ms = "979";
    else if (fault === "gap-duplicate") f.snapshot.runtimeGaps.push({ ...f.snapshot.runtimeGaps[0]! });
    else if (fault === "limit") entries.push({ kind: "alignment_limit" });
    else entries[index] = { ...frame, wall: fault.startsWith("wall-") ? { quality: "local_wall_estimate", policyId: "local-wall-estimate/v1", localStartNs: 10n, localEndNs: 20n, wallEpoch: 1n, wallRun: 1n,
      maximumBracketNs: 1n, maximumResolutionNs: 1000n, modelAllowanceNs: 10_000_000n, interpolationRoundingNs: 1n, captureRoundingNs: 1000n, captureUncertaintyNs: null, externalUtcAccuracyNs: null, overallPhysicalAccuracyNs: null } : frame.wall,
      sampleRateHz: fault === "rational" ? 23999 : frame.sampleRateHz,
      captureStatus: fault === "quality" ? "capture_alignment_missing" : frame.captureStatus,
      epoch: fault === "foreign-frame" ? { ...frame.epoch!, clockDomainId: "other" } : frame.epoch,
      mediaEndSample: ["samples", "end"].includes(fault) ? frame.mediaEndSample - 1n : frame.mediaEndSample,
      reasons: fault === "missing-reason" ? ["wall_alignment_missing"] : [...frame.reasons,
        ...(({ "capture-loss": ["capture_alignment_missing"], "source-loss": ["source_drop"], "audio-loss": ["audio_missing"], "local-wall": ["local_wall_timestamp_estimate"] } as const)[fault as "capture-loss"] ?? [])],
      provenance: { ...p, sampleCount: ["samples", "end"].includes(fault) ? 479 : p.sampleCount,
        sourceStartNumerator: fault === "rate" ? p.outputStartSample * 48000n : p.sourceStartNumerator,
        sourceEndNumerator: fault === "rate" ? (p.outputStartSample + BigInt(p.sampleCount)) * 48000n : ["samples", "end"].includes(fault) ? (p.outputStartSample + 479n) * 24000n : p.sourceEndNumerator,
        sourceDenominator: fault === "rational" ? 23999 : p.sourceDenominator,
        sourceRateHz: fault === "rate" ? 48000 : p.sourceRateHz,
        quality: fault === "quality" ? "unknown_clock" : p.quality,
        span: fault === "quality" ? null : { ...p.span!, hostStartNs: fault === "overlap" ? p.span!.hostStartNs - 2n : p.span!.hostStartNs,
          roundingEnvelopeNs: fault === "rounding" ? 1001n : 1000n, captureUncertaintyNs: fault === "uncertainty" ? 1n : null } } };
    replaceOmissionEntries(f, entries);
    assert.equal(m.tailOmissionOracles(f.snapshot, f.child)[0].status, "fail", fault);
    assert.throws(() => m.tailOmissionMetadata(f.snapshot, f.child));
  });
for (const fault of ["requested", "acknowledged", "confirmed", "legacy", "reason", "closed-reason", "persisted-boundary", "child-boundary", "mode", "count",
  "position", "finish-position", "auth", "session", "bridge", "source", "hash", "key", "generation", "tentative", "unselected", "page-index", "totals", "warnings"])
  test(`omission rejects stale or unbound ${fault}`, async () => {
    // @ts-expect-error Private test route has no declaration.
    const m = await import("./durable-oracles.mjs"); const f = omissionFixture();
    const stale = { captureEpoch: "1", lastFrameSequence: "49", outputEndSample: "23520", finalClockPairSequence: "1" };
    if (fault === "requested") f.child.captureFinish.requestedBoundary = stale;
    if (fault === "acknowledged") f.child.captureFinish.acknowledgedBoundary = stale;
    if (fault === "confirmed") { f.child.captureDrain.drain = "confirmed"; f.recording.capture_drain = "confirmed"; }
    if (fault === "legacy") f.recording.capture_drain = null;
    if (fault === "reason") { f.recording.capture_drain_reason = "capture_finish_timeout"; f.child.captureDrain.reason = "capture_finish_timeout"; }
    if (fault === "closed-reason") f.child.mediaClosedReason = "media_eof";
    if (fault === "persisted-boundary") f.recording.capture_drain_final_pair_sequence = "1";
    if (fault === "child-boundary") f.child.captureDrain.boundary = stale;
    if (fault === "mode") f.child.mediaTiming = "normal";
    if (fault === "count") f.child.framesSent = 48;
    if (fault === "position") f.child.capturePosition.outputEndSample = "23519";
    if (fault === "finish-position") f.child.captureFinish.capturePosition.sequence = "48";
    if (fault === "auth") f.child.captureFinish.authenticated = false;
    if (fault === "session") f.child.captureFinish.sessionId = "43";
    if (fault === "bridge") f.child.captureFinish.bridgeSessionId = "other";
    if (fault === "source") f.snapshot.bindings[0]!.source_session_id = "43";
    if (fault === "hash") f.recording.sha256 = "d".repeat(64);
    if (fault === "key") f.snapshot.attempts[0]!.key_id = "d".repeat(16);
    if (fault === "generation") f.snapshot.attempts[0]!.generation_id = "other";
    if (fault === "tentative") f.snapshot.attempts[0]!.state = "staging";
    if (fault === "unselected") f.snapshot.selected = [];
    if (fault === "page-index") f.snapshot.pages[1]!.page_index = 0;
    if (fault === "totals") f.snapshot.attempts[0]!.entry_count--;
    if (fault === "warnings") f.snapshot.attempts[0]!.warnings_json = "[]";
    assert.equal(m.tailOmissionOracles(f.snapshot, f.child)[0].status, "fail", fault);
  });

test("restored confirmed finish and final pair refuse omission while ordinary positive tail stays strict", async () => {
  // @ts-expect-error Private test route has no declaration.
  const m = await import("./durable-oracles.mjs"), f = omissionFixture();
  const boundary = { captureEpoch: "1", lastFrameSequence: "49", outputEndSample: "23520", finalClockPairSequence: "2" };
  f.child.captureDrain = { drain: "confirmed", reason: "", boundary };
  f.child.captureFinish.requestedBoundary = boundary; f.child.captureFinish.acknowledgedBoundary = boundary;
  Object.assign(f.recording, { capture_drain: "confirmed", capture_drain_reason: null,
    capture_drain_epoch: "1", capture_drain_last_frame_sequence: "49", capture_drain_output_end_sample: "23520", capture_drain_final_pair_sequence: "2" });
  const entries = omissionEntries(f), first = entries[1]!;
  if (first.kind !== "clock_pair") throw new Error("fixture");
  entries.push({ ...first, pair: { ...first.pair, sequence: 2n } }); replaceOmissionEntries(f, entries);
  assert.equal(m.tailOmissionOracles(f.snapshot, f.child)[0].status, "fail");
  // The separate positive oracle remains unchanged and does require a null reason.
  f.child.mediaTiming = "normal";
  const positiveChild = { ...f.child, captureDrain: { drain: "confirmed", reason: null, boundary } };
  assert.equal(m.captureTailOracles(f.snapshot, positiveChild)[0].status, "pass");
  assert.equal(m.mediaTimingOracles(f.snapshot, f.child, "omit-final-pair")[0].status, "fail");
});
for (const column of ["capture_drain_epoch", "capture_drain_last_frame_sequence", "capture_drain_output_end_sample", "capture_drain_final_pair_sequence"] as const)
  test(`omission refuses non-null persisted ${column}`, async () => {
    // @ts-expect-error Private test route has no declaration.
    const m = await import("./durable-oracles.mjs"), f = omissionFixture(); f.recording[column] = "1";
    assert.equal(m.tailOmissionOracles(f.snapshot, f.child)[0].status, "fail");
  });

// One fixture mutant per predicate the review found unpinned; each asserts the
// intended predicate's detail so an earlier unrelated refusal cannot stand in.
function detailOf(rows: Array<{ name: string; status: string; detail: string }>, name: string) {
  const row = rows.find(entry => entry.name === name)!; assert.ok(row, name); return row;
}
test("durable live evidence refuses a persisted live segment no tested segment names", () => {
  const f = fixture();
  f.snapshot.live.push({ ...f.snapshot.live[0]!, generation_id: "g2", segment_id: "2" });
  const row = detailOf(durableOracles(f.snapshot, f.options), "durable_live_evidence");
  assert.equal(row.status, "fail"); assert.match(row.detail, /untested persisted live segment/);
});
test("a negative decision requires exactly one skip", () => {
  const f = fixture(); f.options.tested[0]!.authorized = false;
  const skip = { type: "response_skipped", session_id: "42", segment_id: "1" };
  f.options.runtimeEvents = [f.options.runtimeEvents[0]!, skip, { ...skip }];
  const row = detailOf(durableOracles(f.snapshot, f.options), "durable_turn_terminals");
  assert.equal(row.status, "fail"); assert.match(row.detail, /negative segment admitted or skip missing/);
});
test("post-flush recorded coverage requires at least ten producer frames", () => {
  for (const [sequence, outputEndSample, pass] of [["11", "5280", true], ["10", "4800", false], ["2", "960", false]] as const) {
    const f = fixture(); Object.assign(f.options.interval.captureAfterFlush, { sequence, outputEndSample });
    const row = detailOf(durableOracles(f.snapshot, f.options), "recorded_capture_after_flush");
    assert.equal(row.status, pass ? "pass" : "fail", `${sequence}: ${row.detail}`);
    if (!pass) assert.match(row.detail, /post-flush producer interval mismatch/);
  }
});
test("a persisted bridge capture gap fails post-flush coverage and the confirmed tail", async () => {
  // @ts-expect-error Test-only reopened evidence has no public declaration.
  const { captureTailOracles } = await import("./durable-oracles.mjs");
  const gap = { ordinal: 0, direction: "capture", started_at: "2026-10-01T10:00:00.100Z", ended_at: "2026-10-01T10:00:00.120Z" };
  const f = fixture(); (f.snapshot.gaps as unknown[]).push(gap);
  const row = detailOf(durableOracles(f.snapshot, f.options), "recorded_capture_after_flush");
  assert.equal(row.status, "fail"); assert.match(row.detail, /bridge capture gap/);
  const t = tailFixture(); (t.snapshot.gaps as unknown[]).push(gap);
  const tail = captureTailOracles(t.snapshot, t.child)[0];
  assert.equal(tail.status, "fail"); assert.match(tail.detail, /unaccounted recorded capture tail or audio loss/);
});
test("the confirmed tail requires the peer's sent-frame count to equal the acknowledged last frame", async () => {
  // @ts-expect-error Test-only reopened evidence has no public declaration.
  const { captureTailOracles } = await import("./durable-oracles.mjs");
  for (const framesSent of [10, 12]) {
    const f = tailFixture(); f.child.framesSent = framesSent;
    const row = captureTailOracles(f.snapshot, f.child)[0];
    assert.equal(row.status, "fail"); assert.match(row.detail, /peer final producer position mismatch/);
  }
});
