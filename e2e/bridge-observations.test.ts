import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import nodeTimers from "node:timers";
import { parseEventV2, createBridgeSessionValidatorV2, type BridgeEventMessageV2, type BridgeEventV2 } from "../src/contracts/bridge-session-v2.ts";
import { reduceAttendance, type MeetingLifecycleEvent } from "../src/domain/participants.ts";
import { FrameUiCursor, mergeTimedRecordingEvidence, type AlignmentFrame } from "../src/sessions/timed-evidence-merge.ts";
import type { DiarizedSegment } from "../src/ports/conversation-runtime.ts";
// @ts-expect-error Private fixture helper has no public declaration.
import * as helpers from "./fixtures/bridge-observations.mjs";
// @ts-expect-error Private fixture lifecycle has no public declaration.
import { createCaptureLifecycle } from "./fixtures/scripted-capture-lifecycle.mjs";
// @ts-expect-error Private fixture outcome helper has no public declaration.
import { createPhysicalOutcomeEmitter } from "./fixtures/bridge-scenarios.mjs";

const START = 10000000000n, at = "2026-10-06T12:00:00.000Z";
const binding = { physicalClientId: "slot-a", physicalGenerationId: "a".repeat(32), occurrenceId: "occ-a", bridgeSessionId: "bridge" };
const bracket = (after: bigint) => ({ clockDomainId: "e2e-clock", hostBeforeNs: (after - 1n).toString(), hostAfterNs: after.toString() });
type Row = { emitAtHostNs: string; event: Record<string, unknown> };
function participant(ms: number, id = "A", type = "participant_joined"): Row {
  const due = START + BigInt(ms) * 1000000n;
  return { emitAtHostNs: due.toString(), event: { type, observedAt: new Date(Date.parse(at) + ms).toISOString(), feishuUserId: id,
    ...(type === "participant_joined" ? { displayName: id } : {}), observationTiming: bracket(due), observationTimingReason: null } };
}
function snapshot(ms: number, n: number, id: string | null = "A", changes: Record<string, unknown> = {}): Row {
  const due = START + BigInt(ms) * 1000000n + 1n;
  return { emitAtHostNs: due.toString(), event: { type: "ui_snapshot", observedAt: new Date(Date.parse(at) + ms).toISOString(), snapshotSequence: n,
    observationTiming: bracket(due), state: id === null ? "unknown" : "ui_exact", feishuUserId: id, reason: id === null ? "no_highlight" : null,
    barrierBefore: null, ...changes } };
}
const plan = (events: Row[] = [], disclosure = "sent") => ({ schema: "e2e-bridge-observations/v1", disclosure, events });
function harness(t: TestContext, input: unknown = plan(), overrides: Record<string, unknown> = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let host = START, maxPending = 0;
  const bytes: string[] = [], states: Array<Record<string, unknown>> = [], pending = new Set<ReturnType<typeof nodeTimers.setTimeout>>();
  const callbacks: Array<() => void> = [];
  const timers = { setTimeout(callback: () => void, delay: number) {
    const wrapped = () => { pending.delete(handle); callback(); };
    const handle = nodeTimers.setTimeout(wrapped, delay); callbacks.push(wrapped); pending.add(handle); maxPending = Math.max(maxPending, pending.size); return handle;
  }, clearTimeout(handle: ReturnType<typeof nodeTimers.setTimeout>) { pending.delete(handle); nodeTimers.clearTimeout(handle); } };
  const emit = helpers.createBridgeEventEmitter({ sessionId: binding.bridgeSessionId, now: () => at, write: (line: string) => bytes.push(line) });
  const owner = helpers.createBridgeObservationOwner({ plan: input, binding, parseEvent: parseEventV2, emit,
    nowHostNs: () => host, timers, onState: (state: Record<string, unknown>) => states.push(state), ...overrides });
  return { owner, emit, bytes, states, callbacks, pending, maxPending: () => maxPending,
    setHost: (value: bigint) => { host = value; }, tick: (ms: number) => { host += BigInt(ms) * 1000000n; t.mock.timers.tick(ms); },
    rows: () => bytes.join("").trim().split("\n").filter(Boolean).map(line => parseEventV2(JSON.parse(line))),
    prepare: () => owner.prepareJoin(bracket(START)) };
}
async function emitted(t: TestContext, rows: Row[]) {
  const f = harness(t, plan(rows)); f.prepare(); const done = f.owner.start();
  let prior = 0;
  for (const row of rows) { const ms = Number((BigInt(row.emitAtHostNs) - START + 999999n) / 1000000n); f.tick(ms - prior); prior = ms; }
  await done; assert.equal(f.pending.size, 0); return f.rows();
}
function attendance(rows: BridgeEventMessageV2[]) {
  const projected: MeetingLifecycleEvent[] = rows.flatMap<MeetingLifecycleEvent>(row => row.type === "participant_joined" ? [{ type: row.type,
    feishuUserId: row.feishuUserId, displayName: row.displayName, occurredAt: row.observedAt, sequence: row.sequence, bridgeSessionId: row.sessionId }]
    : row.type === "participant_left" ? [{ type: row.type, feishuUserId: row.feishuUserId, occurredAt: row.observedAt, sequence: row.sequence, bridgeSessionId: row.sessionId }] : []);
  return reduceAttendance(projected);
}
// Clearly labeled nominal alignment/provider component inputs; never fixture-authored app artifacts.
function frame(index = 0): AlignmentFrame {
  const offset = BigInt(index) * 20000000n;
  return { kind: "frame", mediaStartSample: BigInt(index * 480), mediaEndSample: BigInt((index + 1) * 480), sampleRateHz: 24000, gapOffsetMs: 0n,
    epoch: { bridgeSessionId: "bridge", clockDomainId: "e2e-clock", captureEpoch: 1n },
    provenance: { captureEpoch: 1n, sequence: BigInt(index + 1), outputStartSample: BigInt(index * 480), sampleCount: 480,
      sourceStartNumerator: BigInt(index * 11520000), sourceEndNumerator: BigInt((index + 1) * 11520000), sourceDenominator: 24000, sourceRateHz: 24000,
      quality: "nominal_frame_endpoint_interpolation", span: { hostStartNs: START + 1000000000n + offset, hostEndNs: START + 1020000000n + offset, roundingEnvelopeNs: 1n, captureUncertaintyNs: null } },
    captureStatus: "available", reasons: [], wall: null };
}
const source = { sourceSessionId: 41n, recordingHandle: "a".repeat(32), sha256: "b".repeat(64) };
function finalSegment(id = "one", start = 0n, end = 480n, cluster: string | null = null): DiarizedSegment {
  return { segmentId: id, startedAtMs: start / 24n, endedAtMs: end / 24n, text: "component provider wording", speakerCluster: cluster,
    mediaSampleRange: { startSampleInclusive: start, endSampleExclusive: end, sampleRateHz: 24000, gapOffsetMs: 0n,
      quantizationPolicy: "provider_seconds_outward_samples/v1" } };
}
const merged = (ui: BridgeEventMessageV2[], entries = [frame()], segments = [finalSegment()]) => mergeTimedRecordingEvidence({ source,
  bridgeSessionId: "bridge", entries, ui, live: [], final: { source, segments, warnings: [] }, uiLossReason: null, wordingLossReason: null });
const positive = () => [participant(10), participant(20, "S"), snapshot(900, 1, null), snapshot(990, 2), snapshot(1020, 3)];

test("same wire serializer preserves original bytes and shares actual issued command sequencing", async t => {
  assert.equal(typeof helpers.createBridgeEventEmitter, "function", "the child serializer must be extracted, not reconstructed in tests");
  const f = harness(t, plan([participant(10)]));
  f.emit({ type: "media_connected", endpoint: "component" });
  assert.equal(f.bytes[0], '{"schema":"bridge-session/v2","sessionId":"bridge","sequence":1,"observedAt":"2026-10-06T12:00:00.000Z","type":"media_connected","endpoint":"component"}\n');
  f.prepare(); const done = f.owner.start(); f.tick(10); await done;
  f.owner.postDisclosure("chat-1");
  const validator = createBridgeSessionValidatorV2("bridge");
  assert.equal(validator.acceptCommand({ schema: "bridge-session/v2", sessionId: "bridge", commandId: "chat-1", type: "post_disclosure", text: "fixture" }).ok, true);
  const rows = f.rows(); assert.deepEqual(rows.map(row => row.sequence), [1, 2, 3, 4]);
  assert.equal(rows[1]!.observedAt, "2026-10-06T12:00:00.010Z");
  for (const row of rows) assert.equal(validator.acceptEvent(row).ok, true);
});
test("admission refuses bad last row, forbidden surfaces, bounds and non-JSON before any effects", () => {
  assert.equal(typeof helpers.createBridgeObservationOwner, "function");
  const invalid: unknown[] = [null, [], {}, plan([], "spoken"), { ...plan(), unknown: true }, plan([{ ...participant(10), extra: true } as unknown as Row]),
    plan([participant(10), { ...participant(20), event: { ...participant(20).event, sequence: 9 } }]),
    plan([participant(10), { ...participant(20), event: { ...participant(20).event, binding } }]),
    plan([participant(10), { ...participant(20), event: { ...participant(20).event, type: "active_speaker" } }]),
    plan([{ ...participant(10), emitAtHostNs: "010" }]), plan([{ ...participant(10), emitAtHostNs: "18446744073709551616" }]),
    plan([participant(60001)]), plan([participant(10), participant(10)]), plan([participant(20), participant(10)]),
    plan([snapshot(10, 2)]), plan([snapshot(10, 1), snapshot(20, 3)]), plan([snapshot(10, 1), snapshot(20, 1)]),
    plan([snapshot(10, 1), snapshot(20, 2), snapshot(30, 1)]),
    plan([{ ...participant(10), event: { ...participant(10).event, observedAt: "not-a-date" } }]),
    plan([{ ...participant(10), event: { ...participant(10).event, observedAt: "2026-02-30T00:00:00Z" } }]),
    plan([{ ...participant(10), event: { ...participant(10).event, observedAt: "x".repeat(5000) } }]),
    plan([{ ...participant(10), event: { ...participant(10).event, feishuUserId: "x".repeat(5000) } }]),
    plan([{ ...participant(10), event: { ...participant(10).event, displayName: "x".repeat(4096) } }]),
    plan([{ ...participant(10), event: { ...participant(10).event, observationTiming: { ...bracket(START + 10000000n), clockDomainId: "other" } } }]),
    plan([{ ...participant(10), event: { ...participant(10).event, observationTiming: bracket(START + 9000000n) } }]),
    plan([{ ...participant(10), event: { ...participant(10).event, observationTiming: { ...bracket(START + 10000000n), hostBeforeNs: (START + 11000000n).toString() } } }]),
    plan([{ ...participant(10), event: { ...participant(10).event, observationTiming: null, observationTimingReason: "timing_unavailable" } }]),
    plan([participant(10), { ...participant(20), event: { ...participant(20).event, observedAt: at } }]),
    plan(Array.from({ length: 65 }, (_, i) => participant(i + 1))),
    plan(Array.from({ length: 17 }, (_, i) => participant(i + 1, `person-${i}`))),
    plan(Array.from({ length: 64 }, (_, i) => ({ ...participant(i + 1), event: { ...participant(i + 1).event, displayName: "x".repeat(700) } }))),
    { ...plan(), disclosure: undefined }, { ...plan(), events: [() => {}] }, { ...plan(), events: [NaN] }, { ...plan(), events: [1n] },
    { ...plan(), events: [new Date()] }];
  let getterCalls = 0;
  const accessor = Object.defineProperty(plan(), "length", { enumerable: true, get: () => { getterCalls++; return 1; } });
  const symbol = { ...plan(), [Symbol("hidden")]: 1 }, cyclic = plan() as Record<string, unknown>;
  cyclic.events = cyclic;
  invalid.push(accessor, symbol, cyclic, plan(new Array(1)),
    plan([{ ...participant(10), event: { ...participant(10).event, observationTiming: { ...bracket(START + 10000000n), hostBeforeNs: "01" } } }]),
    plan([{ ...participant(3000), event: { ...participant(3000).event, observationTiming: { ...bracket(START + 3000000000n), hostBeforeNs: START.toString() } } }]),
    plan([participant(10), { ...participant(20), event: { ...participant(20).event, observationTiming: { ...bracket(START + 20000000n), hostBeforeNs: START.toString() } } }]),
    plan([{ ...participant(10), event: { ...participant(10).event, sessionId: "override" } }]),
    plan([{ ...participant(10), event: { ...participant(10).event, schema: "bridge-session/v2" } }]));
  const effects: string[] = [];
  for (const input of invalid) assert.throws(() => helpers.createBridgeObservationOwner({ plan: input, binding, parseEvent: parseEventV2,
    emit: () => effects.push("emit"), nowHostNs: () => START, timers: { setTimeout: () => effects.push("timer") }, onState: () => effects.push("state") }), /invalid_bridge_observation_plan/);
  assert.throws(() => helpers.createBridgeObservationOwner({ plan: plan(), binding, participants: [{ feishuUserId: "hidden" }], parseEvent: parseEventV2,
    nowHostNs: () => START, emit: () => effects.push("emit") }), /invalid_bridge_observation_plan/);
  assert.deepEqual(effects, []); assert.equal(getterCalls, 0);
});
test("caller mutation cannot alter scheduled payloads, timing or copied generation", async t => {
  const input = plan([participant(10)]), supplied = { ...binding };
  const f = harness(t, input, { binding: supplied });
  input.events[0]!.event.feishuUserId = "changed";
  (input.events[0]!.event.observationTiming as Record<string, unknown>).hostAfterNs = "1";
  input.events.length = 0; supplied.bridgeSessionId = "other";
  f.prepare(); const done = f.owner.start(); f.tick(10); await done;
  assert.equal(f.rows()[0]!.sessionId, "bridge"); assert.equal(f.rows()[0]!.type, "participant_joined");
  assert.equal((f.rows()[0] as Extract<BridgeEventMessageV2, { type: "participant_joined" }>).feishuUserId, "A");
});
test("one timer follows monotonic due order, early callback cannot emit, repeated callback cannot replay", async t => {
  const f = harness(t, plan([participant(10), participant(20, "S")])); f.prepare(); const done = f.owner.start();
  f.tick(9); assert.equal(f.bytes.length, 0);
  const early = f.callbacks[0]!; early(); assert.equal(f.bytes.length, 0);
  f.tick(1); assert.equal(f.bytes.length, 1); early(); assert.equal(f.bytes.length, 1);
  f.tick(10); assert.deepEqual(await done, { phase: "completed", planned: 2, emitted: 2 });
  assert.equal(f.maxPending(), 1); assert.equal(f.pending.size, 0);
  assert.throws(() => f.owner.start(), /bridge_observation_state/); assert.throws(() => f.prepare(), /bridge_observation_state/);
});
test("stale admission and regressing or fixed-horizon callback clock refuse", async t => {
  const f = harness(t, plan([participant(10)])); f.setHost(START + 10000000n);
  assert.throws(() => f.prepare(), /bridge_observation_state/); assert.equal(f.bytes.length, 0); assert.equal(f.pending.size, 0);
  t.mock.timers.reset();
  for (const host of [START - 1n, START + 60000000001n]) {
    const g = harness(t, plan([participant(10)])); g.prepare(); const done = g.owner.start();
    const rejected = assert.rejects(done, /bridge_observation_failed/); g.setHost(host); t.mock.timers.tick(10); await rejected;
    assert.equal(g.pending.size, 0); assert.equal(g.bytes.length, 0); t.mock.timers.reset();
  }
});
test("empty plan completes; disposal aborts pending work and fences late chat nonthrowingly", async t => {
  const f = harness(t); f.prepare(); assert.deepEqual(await f.owner.start(), { phase: "completed", planned: 0, emitted: 0 });
  f.owner.postDisclosure("one"); f.owner.dispose(); f.owner.dispose(); assert.throws(() => f.owner.postDisclosure("late"), /bridge_observation_state/);
  assert.equal(f.bytes.length, 2); t.mock.timers.reset();
  const g = harness(t, plan([participant(10)]), { onState: () => { throw new Error("sensitive"); } });
  assert.doesNotThrow(() => g.owner.dispose()); assert.equal(g.pending.size, 0);
});
test("early stop aborts exactly once without inventing participant leaves", async t => {
  const f = harness(t, plan([participant(10), participant(20, "A", "participant_left")])); f.prepare(); const done = f.owner.start();
  f.tick(10); f.owner.dispose(); f.owner.dispose(); f.tick(20);
  assert.deepEqual(await done, { phase: "disposed", planned: 2, emitted: 1 });
  assert.deepEqual(f.rows().map(row => row.type), ["participant_joined"]); assert.equal(attendance(f.rows())[0]!.leftAt, null); assert.equal(f.pending.size, 0);
});
test("write and state exceptions fail finitely with no retries or pending timers", async t => {
  for (const override of [{ emit: () => { throw new Error("sensitive write"); } },
    { onState: (value: Record<string, unknown>) => { if (value.emitted === 1) throw new Error("sensitive state"); } }]) {
    const f = harness(t, plan([participant(10), participant(20)]), override); f.prepare(); const done = f.owner.start();
    const rejected = assert.rejects(done, /^Error: bridge_observation_failed$/); f.tick(10); await rejected;
    assert.equal(f.pending.size, 0); assert.throws(() => f.owner.postDisclosure("late"), /bridge_observation_state/); f.owner.dispose(); t.mock.timers.reset();
  }
});
test("reentrant emission disposal cannot schedule remaining work or report success", async t => {
  let writes = 0;
  const f = harness(t, plan([participant(10), participant(20)]), { emit: () => { writes++; owner.dispose(); } });
  const owner = f.owner; f.prepare(); const done = owner.start(); f.tick(10);
  assert.deepEqual(await done, { phase: "disposed", planned: 2, emitted: 1 }); assert.equal(writes, 1); assert.equal(f.pending.size, 0);
});
test("two physical generations remain independent and have no rebind or restart API", async t => {
  const a = harness(t, plan([participant(10)]));
  const other = { ...binding, physicalClientId: "slot-b", physicalGenerationId: "b".repeat(32), occurrenceId: "occ-b", bridgeSessionId: "bridge-b" };
  const bBytes: string[] = [];
  const bEmit = helpers.createBridgeEventEmitter({ sessionId: other.bridgeSessionId, now: () => at, write: (line: string) => bBytes.push(line) });
  let host = START;
  const b = helpers.createBridgeObservationOwner({ plan: plan([participant(10, "B")]), binding: other, parseEvent: parseEventV2, emit: bEmit,
    nowHostNs: () => host, timers: nodeTimers });
  a.prepare(); b.prepareJoin(bracket(START)); const ad = a.owner.start(), bd = b.start(); a.owner.dispose();
  host += 10000000n; a.tick(10); await ad; await bd;
  assert.equal(a.bytes.length, 0); assert.equal(parseEventV2(JSON.parse(bBytes[0]!)).sessionId, "bridge-b");
  assert.equal(parseEventV2(JSON.parse(bBytes[0]!)).sequence, 1); assert.equal(a.owner.rebind, undefined); assert.equal(b.restart, undefined);
});
test("closed disclosure selectors produce actual request-correlated chat results and preserve absent failure", async t => {
  for (const [selector, expected, outcome, detail] of [["sent", "sent", "ok", null], ["unavailable", "unavailable", "failed", "synthetic disclosure unavailable"],
    ["failed", "failed", "failed", "synthetic disclosure failure"], [undefined, "failed", "failed", "synthetic disclosure failure"]] as const) {
    const f = harness(t, selector === undefined ? undefined : plan([], selector), selector === undefined ? { plan: undefined } : {}); f.prepare(); await f.owner.start(); assert.equal(f.bytes.length, 0);
    for (const commandId of ["chat-one", "chat-two"]) f.owner.postDisclosure(commandId);
    assert.deepEqual(f.rows().map(row => row.type), ["chat_disclosure", "command_result", "chat_disclosure", "command_result"]);
    const rows = f.rows(); assert.equal((rows[0] as Extract<BridgeEventV2, { type: "chat_disclosure" }>).outcome, expected);
    assert.deepEqual(rows.filter(row => row.type === "command_result").map(row => [row.commandId, row.outcome, row.detail]), [["chat-one", outcome, detail], ["chat-two", outcome, detail]]);
    assert.throws(() => f.owner.postDisclosure(null), /bridge_observation_state/); assert.equal(f.bytes.length, 4);
    f.owner.dispose(); assert.throws(() => f.owner.postDisclosure("late")); t.mock.timers.reset();
  }
});
test("actual decoded observations earn A while silent S remains attendance-only; missing confirmation/attendance veto", async t => {
  const rows = await emitted(t, positive());
  assert.deepEqual(attendance(rows).map(row => row.feishuUserId), ["A", "S"]);
  assert.deepEqual((await merged(rows)).segments[0]!.speaker, { kind: "named", feishuUserId: "A" });
  t.mock.timers.reset();
  const noConfirmation = await emitted(t, positive().slice(0, -1));
  assert.equal((await merged(noConfirmation)).segments[0]!.speaker.kind, "anonymous");
  t.mock.timers.reset();
  const noAttendance = await emitted(t, positive().filter(row => row.event.type !== "participant_joined"));
  assert.equal((await merged(noAttendance)).segments[0]!.speaker.kind, "anonymous");
  assert.ok(!(await merged(rows)).segments.some(row => row.speaker.kind === "named" && row.speaker.feishuUserId === "S"));
});
test("missing, unreadable and conflicting UI are legal raw bytes and cannot earn a name", async t => {
  for (const changed of [{ state: "unknown", feishuUserId: null, reason: "identity_unavailable" },
    { state: "unreadable", feishuUserId: null, reason: "snapshot_unreadable" },
    { state: "unreadable", feishuUserId: null, reason: "timing_unavailable", observationTiming: null },
    { state: "ambiguous", feishuUserId: null, reason: null }, { state: "ui_exact", feishuUserId: "B", reason: null }]) {
    const rows = await emitted(t, [participant(10), participant(20, "B"), snapshot(900, 1, null), snapshot(990, 2), snapshot(1010, 3, null, changed), snapshot(1020, 4)]);
    assert.equal((await merged(rows)).segments[0]!.speaker.kind, "anonymous"); t.mock.timers.reset();
  }
});
test("same component provider voice cluster with independently named A and B is vetoed by production merge", async t => {
  const rows = await emitted(t, [participant(10), participant(20, "B"), snapshot(900, 1, null), snapshot(990, 2), snapshot(1020, 3),
    snapshot(1030, 4, "B"), snapshot(1060, 5, "B")]);
  const entries = [frame(0), frame(1), frame(2)];
  const result = await merged(rows, entries, [finalSegment("a", 0n, 480n, "component-cluster"), finalSegment("b", 960n, 1440n, "component-cluster")]);
  assert.deepEqual(result.segments.map(row => row.speaker.kind), ["ambiguous", "ambiguous"]);
  assert.ok(result.warnings.some(row => row.code === "timed_cluster_conflict"));
});
test("UI outage and stream restart preserve continuous nominal media and require fresh coverage", async t => {
  const rows = await emitted(t, [...positive(), snapshot(3200, 4, null, { state: "unreadable", reason: "snapshot_unreadable" }),
    snapshot(3300, 5, "A", { barrierBefore: "stream_start" }), participant(3310), snapshot(3320, 6, null), snapshot(3330, 7), snapshot(3380, 8)]);
  const entries = Array.from({ length: 120 }, (_, i) => frame(i));
  const result = await merged(rows, entries, [finalSegment("initial", 0n, 480n), finalSegment("outage", 480n, 53280n),
    finalSegment("lone", 55200n, 55680n), finalSegment("fresh", 56640n, 57120n)]);
  assert.deepEqual(result.segments.map(row => row.speaker.kind), ["named", "anonymous", "anonymous", "named"]);
  assert.ok(!result.warnings.some(row => row.code === "timed_capture_loss" || row.code === "timed_ui_evidence_loss"));
  assert.equal(attendance(rows).filter(row => row.feishuUserId === "A").length, 1);
  assert.ok(rows.every(row => ["participant_joined", "ui_snapshot"].includes(row.type)));
});
test("only raw leave/rejoin creates a genuine attendance gap with exact supplied instants", async t => {
  const rows = await emitted(t, [participant(10), participant(20, "S"), participant(100, "A", "participant_left"),
    snapshot(200, 1, null, { barrierBefore: "poll_gap" }), participant(300), snapshot(400, 2, null, { barrierBefore: "stream_start" }), participant(500)]);
  assert.deepEqual(attendance(rows).filter(row => row.feishuUserId === "A").map(row => [row.joinedAt, row.leftAt]),
    [["2026-10-06T12:00:00.010Z", "2026-10-06T12:00:00.100Z"], ["2026-10-06T12:00:00.300Z", null]]);
  assert.equal(attendance(rows).filter(row => row.feishuUserId === "S").length, 1);
});
test("declared increasing snapshot hole emits legal bytes but cursor cannot carry a name across it", async t => {
  const rows = await emitted(t, [participant(10), snapshot(900, 1, null), snapshot(990, 2), snapshot(1020, 4, "A", { barrierBefore: "observation_drop" })]);
  assert.equal(new FrameUiCursor(rows, "bridge").read(frame()).candidate, null);
  assert.ok(!(await merged(rows)).warnings.some(row => row.code === "timed_ui_evidence_loss"), "pure raw/cursor proof is not durable warning proof");
});
test("lifecycle fence aborts observations before draining; finish precedes existing terminal and physical outcome", async t => {
  const f = harness(t, plan([participant(10), participant(20, "A", "participant_left")])); f.prepare(); const observationsDone = f.owner.start(); f.tick(10);
  let finish: (value: unknown) => void = () => {}; const finishWork = new Promise(resolve => { finish = resolve; });
  const order: string[] = [];
  const lifecycle = createCaptureLifecycle({ getMedia: () => ({ finishCapture: () => { order.push("finish"); return finishWork; } }),
    fenceCapture: () => { f.owner.dispose(); order.push("fence"); }, getCaptureWork: () => Promise.resolve(), participants: [],
    emit: (payload: BridgeEventV2) => { order.push(payload.type); f.emit(payload); } });
  const outcome = createPhysicalOutcomeEmitter({ binding, write: (bytes: Buffer) => { order.push("physical"); return bytes.length; }, close: () => order.push("close"), now: () => at });
  const stop = lifecycle.observeEnd({ reason: "ended", observedAt: at, observationTiming: bracket(START + 15000000n), observationTimingReason: null });
  await Promise.resolve(); await Promise.resolve(); assert.deepEqual(order, ["fence", "finish"]); f.tick(30);
  assert.equal(f.rows().length, 1); assert.equal(f.pending.size, 0); assert.equal((await observationsDone).phase, "disposed");
  finish({ drain: "unconfirmed", reason: "component", boundary: null }); await stop; await outcome.finish({ joined: true, left: "ended" });
  assert.deepEqual(order, ["fence", "finish", "media_disconnected", "left", "physical", "close"]);
  assert.deepEqual(f.rows().map(row => row.type), ["participant_joined", "media_disconnected", "left"]);
});

test("failed join admission is one-shot and cannot be repaired into positive observations", t => {
  const f = harness(t, plan([participant(10)]));
  assert.throws(() => f.owner.prepareJoin(bracket(START + 20000000n)), /bridge_observation_state/);
  assert.throws(() => f.prepare(), /bridge_observation_state/);
  assert.throws(() => f.owner.start(), /bridge_observation_state/);
  assert.equal(f.bytes.length, 0); assert.equal(f.pending.size, 0);
});
test("empty schedule still refuses clock regression after prepared join", async t => {
  const f = harness(t); f.prepare(); f.setHost(START - 1n);
  await assert.rejects(f.owner.start(), /bridge_observation_failed/); assert.equal(f.bytes.length, 0);
});
test("initial and terminal diagnostic failures reject the cached work without disclosure revival", async t => {
  for (const trigger of ["running", "completed"]) {
    const f = harness(t, plan([participant(10)]), { onState: (state: Record<string, unknown>) => { if (state.phase === trigger) throw new Error("private diagnostic"); } });
    f.prepare(); const done = f.owner.start(); const rejected = assert.rejects(done, /^Error: bridge_observation_failed$/);
    f.tick(10); await rejected; assert.equal(f.pending.size, 0); assert.throws(() => f.owner.postDisclosure("late"));
    f.owner.dispose(); t.mock.timers.reset();
  }
});
test("same timer callback reentry cannot emit a planned row twice", async t => {
  let calls = 0;
  const f = harness(t, plan([participant(10), participant(20)]), { emit: () => { calls++; f.callbacks[0]!(); } });
  f.prepare(); const done = f.owner.start(); f.tick(10); f.tick(10); await done;
  assert.equal(calls, 2); assert.equal(f.pending.size, 0);
});

test("enabled disclosure-only plan refuses an unavailable production codec before effects", () => {
  const effects: string[] = [];
  assert.throws(() => helpers.createBridgeObservationOwner({ plan: plan(), binding, nowHostNs: () => START,
    emit: () => effects.push("emit"), onState: () => effects.push("state") }), /invalid_bridge_observation_plan/);
  assert.deepEqual(effects, []);
});

function rowAtEnvelopeLimit(sequence: number): Row {
  const row = participant(10);
  row.event.displayName = "";
  const envelope = { schema: "bridge-session/v2", sessionId: binding.bridgeSessionId, sequence, ...row.event };
  row.event.displayName = "x".repeat(4096 - Buffer.byteLength(JSON.stringify(envelope)));
  assert.equal(Buffer.byteLength(JSON.stringify({ ...envelope, displayName: row.event.displayName })), 4096);
  return row;
}
test("admission reserves the full supported outer sequence width before all effects", () => {
  const row = rowAtEnvelopeLimit(1), effects: string[] = [];
  assert.doesNotThrow(() => parseEventV2({ schema: "bridge-session/v2", sessionId: "bridge", sequence: 1, ...row.event }));
  assert.throws(() => parseEventV2({ schema: "bridge-session/v2", sessionId: "bridge", sequence: 10, ...row.event }), /invalid_bridge_v2/);
  assert.throws(() => helpers.createBridgeObservationOwner({ plan: plan([row]), binding, parseEvent: parseEventV2, nowHostNs: () => START,
    emit: () => effects.push("emit"), timers: { setTimeout: () => effects.push("timer") }, onState: () => effects.push("state") }), /invalid_bridge_observation_plan/);
  const aboveReserved = rowAtEnvelopeLimit(Number.MAX_SAFE_INTEGER);
  aboveReserved.event.displayName = String(aboveReserved.event.displayName) + "x";
  assert.throws(() => helpers.createBridgeObservationOwner({ plan: plan([aboveReserved]), binding, parseEvent: parseEventV2, nowHostNs: () => START,
    emit: () => effects.push("emit"), timers: { setTimeout: () => effects.push("timer") }, onState: () => effects.push("state") }), /invalid_bridge_observation_plan/);
  assert.deepEqual(effects, []);
});
test("near-limit admitted raw payload remains legal across the actual 9 to 10 sequence boundary", async t => {
  const f = harness(t, plan([rowAtEnvelopeLimit(Number.MAX_SAFE_INTEGER)]));
  for (let i = 0; i < 9; i++) f.emit({ type: "media_connected", endpoint: "component" });
  f.prepare(); const done = f.owner.start(); f.tick(10); await done;
  assert.deepEqual(f.rows().map(row => row.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(Buffer.byteLength(f.bytes[9]!.trimEnd()), 4082);
  assert.equal(f.rows()[9]!.type, "participant_joined"); assert.equal(f.pending.size, 0);
});
test("async timer cancellation exception settles static failure and fences stale callbacks", async t => {
  let cancelCalls = 0;
  const callbacks: Array<() => void> = [];
  const timers = { setTimeout(callback: () => void, delay: number) { callbacks.push(callback); return nodeTimers.setTimeout(callback, delay); },
    clearTimeout() { cancelCalls++; throw new Error("private timer diagnostic"); } };
  const f = harness(t, plan([participant(10), participant(20)]), { timers });
  f.prepare(); const done = f.owner.start(), rejected = assert.rejects(done, /^Error: bridge_observation_failed$/);
  assert.doesNotThrow(() => f.tick(10)); await rejected;
  assert.equal(cancelCalls, 1, "local handle ownership must release before the throwing cancel");
  assert.equal(f.states.at(-1)!.phase, "failed"); assert.equal(f.bytes.length, 0);
  assert.doesNotThrow(() => callbacks[0]!()); assert.throws(() => f.owner.postDisclosure("late"), /bridge_observation_state/);
  f.owner.dispose(); f.tick(20); assert.equal(f.bytes.length, 0); assert.equal(cancelCalls, 1);
});
test("failure with an uncancellable pending timer still settles and cannot revive disclosure or rows", async t => {
  let cancelCalls = 0, pending = 0;
  const callbacks: Array<() => void> = [];
  const timers = { setTimeout(callback: () => void, delay: number) {
    pending++; callbacks.push(callback); return nodeTimers.setTimeout(() => { pending--; callback(); }, delay);
  }, clearTimeout() { cancelCalls++; throw new Error("private cancel diagnostic"); } };
  const f = harness(t, plan([participant(10)]), { timers, emit: () => { throw new Error("private write diagnostic"); },
    onState: (state: Record<string, unknown>) => { if (state.phase === "failed") throw new Error("private failed diagnostic"); } });
  f.prepare(); const done = f.owner.start(), rejected = assert.rejects(done, /^Error: bridge_observation_failed$/);
  assert.equal(pending, 1);
  assert.throws(() => f.owner.postDisclosure("actual-command"), /^Error: bridge_observation_failed$/); await rejected;
  assert.equal(cancelCalls, 1); assert.equal(pending, 1, "a throwing timer dependency cannot prove external cancellation");
  assert.doesNotThrow(() => callbacks[0]!()); f.tick(10); assert.equal(pending, 0);
  assert.throws(() => f.owner.postDisclosure("late"), /bridge_observation_state/); assert.doesNotThrow(() => f.owner.dispose());
  assert.equal(f.bytes.length, 0); assert.equal(cancelCalls, 1);
});
