import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import Database from "better-sqlite3";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import { createCoordinator } from "../src/sessions/coordinator.ts";
import { createMeetingSession } from "../src/sessions/meeting-session.ts";
import { createConversationRuntimeClient } from "../src/adapters/conversation-runtime-client.ts";
import { parseCommandV2, type BridgeCommandMessageV2 } from "../src/contracts/bridge-session-v2.ts";
import { runtimeTestClient, finalizedWire } from "./lib/runtime-sdk.ts";
import type { ProvisionalResolution } from "../src/sessions/live-provisional.ts";
import { fakeRuntime } from "./lib/session-fakes.ts";
import type { RuntimeEvent } from "../src/ports/conversation-runtime.ts";

const prematureFinal: RuntimeEvent = { type: "timed_voice_event", bridgeSessionId: "bridge-one", event: {
  type: "voice_transcript_final", sessionId: 42n, segmentId: "9", turnId: null, text: "Meetbot, premature wording", captureUnavailableReason: "provider_offsets_unavailable" } };

test("actual SDK/v2 session retains synchronous join evidence and authorizes text before late UI resolution", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-timed-session-"));
  const store = openSessionStore({ filename: path.join(dir, "state.db") });
  const identity = buildMeetingIdentity({ providerMeetingId: "synthetic", meetingNo: "000000000", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "Synthetic", organizer: null });
  const coordinator = createCoordinator({ store, clock: { now: () => 1000 }, bridgeLeaseTtlMs: 30000, maxConcurrentSessions: 1 });
  coordinator.discover(identity);
  const { client, transport } = await runtimeTestClient(4);
  const runtime = createConversationRuntimeClient(client);
  let runtimeListener: ((event: RuntimeEvent) => void) | undefined;
  const subscribeRuntime = runtime.subscribe.bind(runtime), startRuntime = runtime.startVoiceSession.bind(runtime);
  runtime.subscribe = (callback) => { runtimeListener = callback; return subscribeRuntime(callback); };
  runtime.startVoiceSession = (input) => { runtimeListener?.(prematureFinal); return startRuntime(input); };
  let listener: ((raw: unknown) => void) | undefined;
  let sequence = 0;
  const emit = (event: Record<string, unknown>) => listener?.({ schema: "bridge-session/v2", sessionId: "bridge-one", sequence: ++sequence,
    observedAt: "2026-09-02T14:00:00Z", ...event });
  const timing = (before: string, after: string) => ({ clockDomainId: "domain", hostBeforeNs: before, hostAfterNs: after });
  const bridge = { subscribe(callback: (raw: unknown) => void) { listener = callback; return () => { listener = undefined; }; },
    async send(command: BridgeCommandMessageV2) {
      parseCommandV2(command);
      if (command.type === "join") {
        runtimeListener?.(prematureFinal);
        runtimeListener?.({ type: "timed_voice_event", bridgeSessionId: "bridge-one", event: { type: "response_skipped", sessionId: 42n, segmentId: "9", reason: "no_alias_match" } });
        emit({ type: "joined", meetingOccurrenceId: identity.occurrenceId, observationTiming: timing("0", "1"), observationTimingReason: null });
        emit({ type: "participant_joined", feishuUserId: "person", displayName: "Person", observationTiming: timing("2", "3"), observationTimingReason: null });
        emit({ type: "ui_snapshot", snapshotSequence: 1, state: "unknown", feishuUserId: null, reason: "no_highlight", barrierBefore: "stream_start", observationTiming: timing("4", "5") });
        emit({ type: "ui_snapshot", snapshotSequence: 2, state: "ui_exact", feishuUserId: "person", reason: null, barrierBefore: null, observationTiming: timing("900000000", "950000000") });
      }
    } };
  transport.onSend = (command) => {
    transport.push({ type: "command_accepted", protocol_version: 4, request_id: command.requestId,
      ...(command.type === "authorize_voice_response" ? { turn_id: "99" } : {}) });
    if (command.type === "start_drainable_timed_voice_session") transport.push({ type: "timed_voice_session_started", protocol_version: 4, request_id: command.requestId,
      media_lease: { media_protocol_version: 3, session_id: "42", connect_endpoint: "tcp://127.0.0.1:9001", credential: "a".repeat(64),
        expires_at_ms: String(Date.now() + 60000), reconnect_window_ms: "10000", capture_format: "pcm_s16le/24000/1/20ms", timing_contract: "capture-clock/v1" } });
    if (command.type === "finalize_recording") transport.push({ ...finalizedWire, request_id: command.requestId,
      recovery_capability: { ...finalizedWire.recovery_capability, source_session_id: "42" } });
  };
  const results: ProvisionalResolution[] = [], transcripts: string[] = [];
  const session = createMeetingSession({ identity, bridge, runtime, coordinator, clock: { now: () => 1000 }, agentIdentity: { aliases: ["Meetbot"] },
    bridgeId: "mac", bridgeSessionId: "bridge-one", disclosureText: "Disclosure", timedEvidence: { store, onResult: (result) => results.push(result), onTranscript: (event) => transcripts.push(event.segmentId) } });
  try {
    await session.join(); await session.settled();
    const binding = { occurrenceId: identity.occurrenceId, bridgeSessionId: "bridge-one", runtimeSessionId: 42n };
    assert.equal(store.getTimedEvidenceStatus(binding, 1000)?.liveRows, 0);
    assert.deepEqual(transcripts, []);
    assert.equal(store.readTimedUi(binding, 0, 1000).length, 4);
    transport.push({ type: "voice_event", protocol_version: 4, event: { type: "voice_session_started", session_id: "42", privacy: { privacy_mode: "local_only",
      components: ["speech_recognition", "language_model", "speech_synthesis", "audio_io"].map((kind) => ({ kind, execution_location: "local", provider_label: "Synthetic" })) } } });
    transport.push({ type: "voice_event", protocol_version: 4, event: { type: "voice_transcript_final", session_id: "42", segment_id: "9", turn_id: null,
      text: "Meetbot, please summarize", capture: { kind: "source_sample_range/v1", clock_domain_id: "domain", capture_epoch: "1", first_frame_sequence: "7", last_frame_sequence: "8",
        source_start_sample: "9007199254740993", source_end_sample: "9007199254741017", sample_rate_hz: 24000 },
      live_coverage: { kind: "whole_touched_frame_nominal_host_envelope/v1", host_start_ns: "1000000000", host_end_ns: "2000000000", first_frame_host_end_ns: "1500000000",
        mapping_quality: "nominal_frame_endpoint_interpolation", capture_uncertainty_ns: null, known_rounding_allowance_ns: "1" } } });
    await setImmediate(); await session.settled();
    assert.ok(transport.commands.some((command) => command.type === "authorize_voice_response" && command.segmentId === "9"));
    assert.equal(results.length, 0);
    assert.equal(store.readTimedFinal(binding, "", 1000)?.event.text, "Meetbot, please summarize");
    emit({ type: "ui_snapshot", snapshotSequence: 3, state: "ui_exact", feishuUserId: "person", reason: null, barrierBefore: null, observationTiming: timing("2000000000", "2000000001") });
    await session.settled(); assert.equal(results[0]?.result.kind, "provisional_ui_observed");
    assert.equal(session.state().liveTranscript.length, 0); // No invented legacy UTC transcript.
    transport.push({ type: "voice_event", protocol_version: 4, event: { type: "voice_transcript_final", session_id: "42", segment_id: "9", turn_id: null,
      text: "Meetbot, please summarize", capture_unavailable_reason: "provider_offsets_unavailable" } });
    await setImmediate(); await session.settled();
    assert.deepEqual(transcripts, ["9"]);
    emit({ type: "command_result", commandId: "never-issued", outcome: "ok", detail: null });
    await session.settled();
    assert.equal(session.state().commandResults.some((event) => event.commandId === "never-issued"), false);
    const raw = new Database(path.join(dir, "state.db"));
    try {
      // Fill the existing durable row cap with bounded, already parsed fixture
      // evidence; the 257th delivery still goes through the actual SDK/session.
      const insert = raw.prepare(`INSERT INTO timed_live_evidence(generation_id, segment_id, text, evidence, result)
        SELECT generation_id, ?, 'seed', json_set(evidence, '$.segmentId', ?), result FROM timed_live_evidence WHERE segment_id = '9'`);
      raw.transaction(() => { for (let i = 1000; i < 1255; i++) insert.run(String(i), String(i)); })();
    } finally { raw.close(); }
    transport.push({ type: "voice_event", protocol_version: 4, event: { type: "voice_transcript_final", session_id: "42", segment_id: "10", turn_id: null,
      text: "Meetbot, please summarize this too", capture_unavailable_reason: "provider_offsets_unavailable" } });
    await setImmediate(); await session.settled();
    assert.deepEqual(transcripts, ["9", "10"]);
    assert.equal(store.getTimedEvidenceStatus(binding, 1000)?.wordingLossReason, "live_limit_exceeded");
    assert.equal(store.getTimedEvidenceStatus(binding, 1000)?.liveRows, 256);
    assert.ok(transport.commands.some((command) => command.type === "authorize_voice_response" && command.segmentId === "10"));
    assert.equal(results.length, 1); // No invented durable anonymous result for the unpersisted row.
  } finally { await session.dispose(); await runtime.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const variant of ["invalid_control", "start_rejected", "lease_mismatch", "cancel_join", "left_during_start"] as const) {
  test(`timed ${variant} fails closed without invented recording or media admission`, { timeout: 3000 }, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-timed-negative-")), store = openSessionStore({ filename: path.join(dir, "state.db") });
    const identity = buildMeetingIdentity({ providerMeetingId: variant, meetingNo: "000000000", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "Negative", organizer: null });
    const coordinator = createCoordinator({ store, clock: { now: () => 1000 }, bridgeLeaseTtlMs: 30000, maxConcurrentSessions: 1 }); coordinator.discover(identity);
    const { client, transport } = await runtimeTestClient(4), actual = createConversationRuntimeClient(client);
    let closed = 0; const commands: BridgeCommandMessageV2[] = [];
    let runtimeListener: ((event: RuntimeEvent) => void) | undefined;
    let bridgeListener: ((raw: unknown) => void) | undefined;
    const transcripts: string[] = [];
    const runtime = { ...actual, currentSessionId: variant === "invalid_control" ? 0n : 42n, close: async () => { closed++; await actual.close(); },
      subscribe: (callback: (event: RuntimeEvent) => void) => { runtimeListener = callback; return actual.subscribe(callback); },
      ...(variant === "lease_mismatch" ? { startVoiceSession: async () => { runtimeListener?.(prematureFinal); return { timingContract: "capture-clock/v1" as const, bridgeSessionId: "wrong-bridge", sessionId: 43n,
        mediaLease: { mediaProtocolVersion: 2 as const, sessionId: 43n, connectEndpoint: "tcp://127.0.0.1:9001", credential: "a".repeat(64), expiresAtMs: BigInt(Date.now() + 60000),
          reconnectWindowMs: 10000n, captureFormat: "pcm_s16le/24000/1/20ms" as const, timingContract: "capture-clock/v1" as const } }; } } : {}) };
    transport.onSend = (command) => {
      if (command.type === "start_drainable_timed_voice_session" && variant === "left_during_start") {
        // Leave the actual SDK start promise unresolved. An early final cannot
        // block the same reader from observing left and closing that SDK owner.
        queueMicrotask(() => { runtimeListener?.(prematureFinal); bridgeListener?.({ schema: "bridge-session/v2", sessionId: "bridge-one", sequence: 1,
          observedAt: "2026-09-02T14:00:00Z", type: "left", reason: "ended", observationTiming: null, observationTimingReason: "timing_unavailable" }); });
        return;
      }
      if (command.type === "start_drainable_timed_voice_session") transport.push({ type: "command_rejected", protocol_version: 4, request_id: command.requestId,
        error: { code: "invalid_state", kind: "invalid_state", stage: "runtime", message: "synthetic rejected" } });
      else { transport.push({ type: "command_accepted", protocol_version: 4, request_id: command.requestId });
        if (command.type === "finalize_recording") transport.push({ ...finalizedWire, request_id: command.requestId }); }
    };
    let releaseJoin!: () => void, reachedJoin!: () => void;
    const joinHeld = new Promise<void>((resolve) => { releaseJoin = resolve; }), joinReached = new Promise<void>((resolve) => { reachedJoin = resolve; });
    const bridge = { subscribe(callback: (raw: unknown) => void) { bridgeListener = callback; return () => { bridgeListener = undefined; }; }, async send(command: BridgeCommandMessageV2) { parseCommandV2(command); commands.push(command);
      if (command.type === "join") runtimeListener?.(prematureFinal);
      if (variant === "cancel_join" && command.type === "join") { reachedJoin(); await joinHeld; } } };
    const session = createMeetingSession({ identity, bridge, runtime, coordinator, clock: { now: () => 1000 }, agentIdentity: { aliases: ["Meetbot"] },
      bridgeId: "mac", bridgeSessionId: "bridge-one", disclosureText: "Disclosure", timedEvidence: { store, onTranscript: (event) => transcripts.push(event.segmentId) } });
    try {
      const joining = assert.rejects(session.join());
      if (variant === "cancel_join") { await joinReached; const disposing = session.dispose(); releaseJoin(); await disposing; }
      await joining; await session.settled();
      assert.equal(commands.some((command) => command.type === "connect_media"), false);
      assert.equal(transport.commands.some((command) => command.type === "finalize_recording"), false);
      assert.equal(session.state().runtimeSessionId, null); assert.equal(session.state().recording, null);
      assert.deepEqual(transcripts, []);
      if (variant !== "invalid_control") assert.equal(store.getTimedEvidenceStatus({ occurrenceId: identity.occurrenceId, bridgeSessionId: "bridge-one", runtimeSessionId: 42n }, 1000)?.liveRows, 0);
      if (variant === "invalid_control") assert.equal(commands.some((command) => command.type === "join"), false);
      else assert.equal(closed, 1);
    } finally { await session.dispose(); await actual.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test("early v2 leave closes the connected SDK/evidence owner without finalizing a never-started voice recording", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-timed-early-")), store = openSessionStore({ filename: path.join(dir, "state.db") });
  const identity = buildMeetingIdentity({ providerMeetingId: "early", meetingNo: "000000000", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "Early", organizer: null });
  const coordinator = createCoordinator({ store, clock: { now: () => 1000 }, bridgeLeaseTtlMs: 30000, maxConcurrentSessions: 1 }); coordinator.discover(identity);
  const { client, transport } = await runtimeTestClient(4), runtime = createConversationRuntimeClient(client);
  let closed = 0; const close = transport.close.bind(transport);
  transport.close = async () => { closed++; await close(); };
  let listener: ((raw: unknown) => void) | undefined;
  const bridge = { subscribe(callback: (raw: unknown) => void) { listener = callback; return () => { listener = undefined; }; },
    async send(command: BridgeCommandMessageV2) { parseCommandV2(command); if (command.type === "join") listener?.({ schema: "bridge-session/v2", sessionId: "bridge-one", sequence: 1,
      observedAt: "2026-09-02T14:00:00Z", type: "left", reason: "ended", observationTiming: null, observationTimingReason: "timing_unavailable" }); } };
  const session = createMeetingSession({ identity, bridge, runtime, coordinator, clock: { now: () => 1000 }, agentIdentity: { aliases: ["Meetbot"] },
    bridgeId: "mac", bridgeSessionId: "bridge-one", disclosureText: "Disclosure", timedEvidence: { store } });
  try {
    await assert.rejects(session.join(), /cancelled/); await session.settled();
    assert.equal(closed, 1);
    assert.deepEqual(transport.commands, []);
    assert.equal(session.state().runtimeSessionId, null); assert.equal(session.state().recording, null); assert.equal(session.state().mediaConnected, false);
    assert.equal(store.getTimedEvidenceStatus({ occurrenceId: identity.occurrenceId, bridgeSessionId: "bridge-one", runtimeSessionId: 42n }, 1000)?.state, "closed");
  } finally { await session.dispose(); await runtime.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const writeFailure of [false, true]) {
  test(`timed queue overflow closes pre-drop coverage and records separate durable loss (write failure=${writeFailure})`, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-timed-overflow-")), filename = path.join(dir, "state.db"), store = openSessionStore({ filename }), raw = new Database(filename);
    const identity = buildMeetingIdentity({ providerMeetingId: "overflow", meetingNo: "000000000", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "Overflow", organizer: null });
    const coordinator = createCoordinator({ store, clock: { now: () => 1000 }, bridgeLeaseTtlMs: 30000, maxConcurrentSessions: 1 }); coordinator.discover(identity);
    const injected = fakeRuntime(); let release!: () => void, reached!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; }), waiting = new Promise<void>((resolve) => { reached = resolve; });
    const runtime = { ...injected, currentSessionId: 42n, startVoiceSession: async () => ({ timingContract: "capture-clock/v1" as const, bridgeSessionId: "bridge-one", sessionId: 42n,
      mediaLease: { mediaProtocolVersion: 2 as const, sessionId: 42n, connectEndpoint: "tcp://127.0.0.1:9001", credential: "a".repeat(64), expiresAtMs: BigInt(Date.now() + 60000),
        reconnectWindowMs: 10000n, captureFormat: "pcm_s16le/24000/1/20ms" as const, timingContract: "capture-clock/v1" as const } }),
      skipVoiceResponse: async (input: { segmentId: string }) => { if (input.segmentId === "10") { reached(); await held; } } };
    let listener: ((raw: unknown) => void) | undefined, sequence = 0;
    const bridge = { subscribe(callback: (raw: unknown) => void) { listener = callback; return () => { listener = undefined; }; }, async send(command: BridgeCommandMessageV2) { parseCommandV2(command); } };
    const emit = (event: Record<string, unknown>) => listener?.({ schema: "bridge-session/v2", sessionId: "bridge-one", sequence: ++sequence, observedAt: "2026-09-02T14:00:00Z", ...event });
    const timing = (before: number) => ({ clockDomainId: "domain", hostBeforeNs: String(before), hostAfterNs: String(before + 1) });
    const results: ProvisionalResolution[] = [];
    const session = createMeetingSession({ identity, bridge, runtime, coordinator, clock: { now: () => 1000 }, agentIdentity: { aliases: ["Meetbot"] }, maxQueuedEvents: 2,
      bridgeId: "mac", bridgeSessionId: "bridge-one", disclosureText: "Disclosure", timedEvidence: { store, onResult: (event) => results.push(event) } });
    const binding = { occurrenceId: identity.occurrenceId, bridgeSessionId: "bridge-one", runtimeSessionId: 42n };
    try {
      await session.join();
      emit({ type: "participant_joined", feishuUserId: "person", displayName: "Person", observationTiming: timing(0), observationTimingReason: null }); await session.settled();
      emit({ type: "ui_snapshot", snapshotSequence: 1, state: "unknown", feishuUserId: null, reason: "no_highlight", barrierBefore: "stream_start", observationTiming: timing(10) }); await session.settled();
      emit({ type: "ui_snapshot", snapshotSequence: 2, state: "ui_exact", feishuUserId: "person", reason: null, barrierBefore: null, observationTiming: timing(900000000) }); await session.settled();
      injected.emit({ type: "timed_voice_event", bridgeSessionId: "bridge-one", event: { type: "voice_transcript_final", sessionId: 42n, segmentId: "9", turnId: null, text: "Discussion",
        capture: { kind: "source_sample_range/v1", clockDomainId: "domain", captureEpoch: 1n, firstFrameSequence: 1n, lastFrameSequence: 2n, sourceStartSample: 0n, sourceEndSample: 960n, sampleRateHz: 24000 },
        liveCoverage: { kind: "whole_touched_frame_nominal_host_envelope/v1", hostStartNs: 1000000000n, hostEndNs: 2000000000n, firstFrameHostEndNs: 1500000000n,
          mappingQuality: "nominal_frame_endpoint_interpolation", captureUncertaintyNs: null, knownRoundingAllowanceNs: 1n } } }); await session.settled();
      assert.equal(results.length, 0);
      injected.emit({ type: "provider_unavailable", detail: "synthetic pause" }); await session.settled();
      const final = { type: "voice_transcript_final" as const, sessionId: 42n, segmentId: "10", turnId: null, text: "wording", captureUnavailableReason: "provider_offsets_unavailable" as const };
      injected.emit({ type: "timed_voice_event", bridgeSessionId: "bridge-one", event: final }); await waiting;
      if (writeFailure) raw.exec("CREATE TRIGGER reject_loss BEFORE UPDATE ON timed_evidence_owners BEGIN SELECT RAISE(ABORT, 'injected loss failure'); END");
      emit({ type: "chat_disclosure", outcome: "sent" }); emit({ type: "chat_disclosure", outcome: "sent" });
      assert.doesNotThrow(() => emit({ type: "ui_snapshot", snapshotSequence: 3, state: "unreadable", feishuUserId: null, reason: "snapshot_unreadable", barrierBefore: null, observationTiming: timing(2000000000) }));
      assert.doesNotThrow(() => injected.emit({ type: "timed_voice_event", bridgeSessionId: "bridge-one", event: { ...final, segmentId: "11" } }));
      assert.equal(results.find((result) => result.segmentId === "9")?.result.kind, "anonymous");
      release(); await session.settled();
      const reopened = openSessionStore({ filename });
      try { assert.equal(reopened.getTimedEvidenceStatus(binding, 1000)?.wordingLossReason, writeFailure ? null : "runtime_queue_overflow");
        assert.equal(reopened.getTimedEvidenceStatus(binding, 1000)?.uiLossReason, writeFailure ? null : "ui_sequence_gap"); }
      finally { reopened.close(); }
      if (writeFailure) { assert.ok(session.state().routingErrors.length >= 2); raw.exec("DROP TRIGGER reject_loss"); }
    } finally { release(); await session.dispose(); raw.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const replay of ["changed_same", "backward_new", "identical", "wrong_generation", "stale_left", "stale_admin"] as const) {
  test(`session UI replay ${replay} cannot bypass durable fencing or reroute stale lifecycle`, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-timed-replay-")), filename = path.join(dir, "state.db"), store = openSessionStore({ filename });
    const identity = buildMeetingIdentity({ providerMeetingId: replay, meetingNo: "000000000", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "Replay", organizer: null });
    const coordinator = createCoordinator({ store, clock: { now: () => 1000 }, bridgeLeaseTtlMs: 30000, maxConcurrentSessions: 1 }); coordinator.discover(identity);
    const injected = fakeRuntime(), runtime = { ...injected, currentSessionId: 42n, startVoiceSession: async () => ({ timingContract: "capture-clock/v1" as const, bridgeSessionId: "bridge-one", sessionId: 42n,
      mediaLease: { mediaProtocolVersion: 2 as const, sessionId: 42n, connectEndpoint: "tcp://127.0.0.1:9001", credential: "a".repeat(64), expiresAtMs: BigInt(Date.now() + 60000),
        reconnectWindowMs: 10000n, captureFormat: "pcm_s16le/24000/1/20ms" as const, timingContract: "capture-clock/v1" as const } }) };
    let listener: ((raw: unknown) => void) | undefined, monotonic = 0;
    const timers = new Set<() => void>(), results: ProvisionalResolution[] = [];
    const bridge = { subscribe(callback: (raw: unknown) => void) { listener = callback; return () => { listener = undefined; }; }, async send(command: BridgeCommandMessageV2) { parseCommandV2(command); } };
    const envelope = { schema: "bridge-session/v2", sessionId: "bridge-one", observedAt: "2026-09-02T14:00:00Z" };
    const timing = (before: number) => ({ clockDomainId: "domain", hostBeforeNs: String(before), hostAfterNs: String(before + 1) });
    const positive = { ...envelope, sequence: 12, type: "ui_snapshot", snapshotSequence: 2, state: "ui_exact", feishuUserId: "person", reason: null, barrierBefore: null, observationTiming: timing(900000000) };
    const session = createMeetingSession({ identity, bridge, runtime, coordinator, clock: { now: () => 1000 }, agentIdentity: { aliases: ["Meetbot"] },
      bridgeId: "mac", bridgeSessionId: "bridge-one", disclosureText: "Disclosure", timedEvidence: { store, onResult: (event) => results.push(event),
        catchupClock: { now: () => monotonic, schedule(callback) { timers.add(callback); return () => { timers.delete(callback); }; } } } });
    const binding = { occurrenceId: identity.occurrenceId, bridgeSessionId: "bridge-one", runtimeSessionId: 42n };
    try {
      await session.join();
      listener?.({ ...envelope, sequence: 10, type: "participant_joined", feishuUserId: "person", displayName: "Person", observationTiming: timing(0), observationTimingReason: null }); await session.settled();
      listener?.({ ...positive, sequence: 11, snapshotSequence: 1, state: "unknown", feishuUserId: null, reason: "no_highlight", observationTiming: timing(10) }); await session.settled();
      listener?.(positive); await session.settled();
      listener?.({ ...positive, sequence: 13, snapshotSequence: 3, observationTiming: timing(2000000000) }); await session.settled();
      const conflict = { ...positive, state: "ambiguous", feishuUserId: null };
      if (replay === "changed_same") listener?.(conflict);
      else if (replay === "backward_new") listener?.({ ...conflict, sequence: 9 });
      else if (replay === "identical") listener?.(positive);
      else if (replay === "wrong_generation") listener?.({ ...conflict, sessionId: "retired-bridge" });
      else if (replay === "stale_left") listener?.({ ...envelope, sequence: 12, type: "left", reason: "ended", observationTiming: timing(2100000000), observationTimingReason: null });
      else listener?.({ ...envelope, sequence: 12, type: "command_result", commandId: "cmd_0001", outcome: "failed", detail: null });
      await session.settled();
      injected.emit({ type: "timed_voice_event", bridgeSessionId: "bridge-one", event: { type: "voice_transcript_final", sessionId: 42n, segmentId: "9", turnId: null, text: "Discussion",
        capture: { kind: "source_sample_range/v1", clockDomainId: "domain", captureEpoch: 1n, firstFrameSequence: 1n, lastFrameSequence: 2n, sourceStartSample: 0n, sourceEndSample: 960n, sampleRateHz: 24000 },
        liveCoverage: { kind: "whole_touched_frame_nominal_host_envelope/v1", hostStartNs: 1000000000n, hostEndNs: 2000000000n, firstFrameHostEndNs: 1500000000n,
          mappingQuality: "nominal_frame_endpoint_interpolation", captureUncertaintyNs: null, knownRoundingAllowanceNs: 1n } } });
      await session.settled(); monotonic = 2000; for (const task of [...timers]) task();
      const bad = replay === "changed_same" || replay === "backward_new";
      assert.equal(results[0]?.result.kind, bad ? "anonymous" : "provisional_ui_observed");
      assert.equal(session.state().terminalReason, null); assert.equal(session.state().commandResults.length, 0);
      const reopened = openSessionStore({ filename });
      try { assert.equal(reopened.readTimedFinal(binding, "", 1000)?.result?.kind, bad ? "anonymous" : "provisional_ui_observed");
        assert.equal(reopened.getTimedEvidenceStatus(binding, 1000)?.uiLossReason, replay === "changed_same" ? "ui_invalid" : replay === "backward_new" ? "ui_sequence_gap" : null); }
      finally { reopened.close(); }
    } finally { await session.dispose(); assert.equal(timers.size, 0); store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const firstEvent of ["final", "failure"] as const) {
  test(`coalesced actual SDK typed lease and ${firstEvent} retain valid admission ordering`, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-timed-coalesced-")), store = openSessionStore({ filename: path.join(dir, "state.db") });
    const identity = buildMeetingIdentity({ providerMeetingId: firstEvent, meetingNo: "000000000", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "Coalesced", organizer: null });
    const coordinator = createCoordinator({ store, clock: { now: () => 1000 }, bridgeLeaseTtlMs: 30000, maxConcurrentSessions: 1 }); coordinator.discover(identity);
    const { client, transport } = await runtimeTestClient(4), runtime = createConversationRuntimeClient(client), transcripts: string[] = [];
    transport.onSend = (command) => {
      transport.push({ type: "command_accepted", protocol_version: 4, request_id: command.requestId, ...(command.type === "authorize_voice_response" ? { turn_id: "99" } : {}) });
      if (command.type === "start_drainable_timed_voice_session") {
        transport.push({ type: "timed_voice_session_started", protocol_version: 4, request_id: command.requestId, media_lease: { media_protocol_version: 3, session_id: "42",
          connect_endpoint: "tcp://127.0.0.1:9001", credential: "a".repeat(64), expires_at_ms: String(Date.now() + 60000), reconnect_window_ms: "10000", capture_format: "pcm_s16le/24000/1/20ms", timing_contract: "capture-clock/v1" } });
        if (firstEvent === "failure") transport.push({ type: "voice_event", protocol_version: 4, event: { type: "voice_session_failed", session_id: "42", recovery: "new_session",
          error: { code: "adapter_failure", kind: "adapter", stage: "speech_recognizer", message: "synthetic early failure" } } });
        else {
          transport.push({ type: "voice_event", protocol_version: 4, event: { type: "voice_session_started", session_id: "42", privacy: { privacy_mode: "local_only",
            components: ["speech_recognition", "language_model", "speech_synthesis", "audio_io"].map((kind) => ({ kind, execution_location: "local", provider_label: "Synthetic" })) } } });
          transport.push({ type: "voice_event", protocol_version: 4, event: { type: "voice_transcript_final", session_id: "42", segment_id: "9", turn_id: null,
            text: "Meetbot, please summarize", capture_unavailable_reason: "provider_offsets_unavailable" } });
        }
      }
      if (command.type === "finalize_recording") transport.push({ ...finalizedWire, request_id: command.requestId, recovery_capability: { ...finalizedWire.recovery_capability, source_session_id: "42" } });
    };
    let bridgeListener: ((raw: unknown) => void) | undefined;
    const bridge = { subscribe(callback: (raw: unknown) => void) { bridgeListener = callback; return () => { bridgeListener = undefined; }; }, async send(command: BridgeCommandMessageV2) {
      parseCommandV2(command);
      if (command.type === "join") bridgeListener?.({ schema: "bridge-session/v2", sessionId: "bridge-one", sequence: 1, observedAt: "2026-09-02T14:00:00Z",
        type: "joined", meetingOccurrenceId: identity.occurrenceId, observationTiming: { clockDomainId: "domain", hostBeforeNs: "0", hostAfterNs: "1" }, observationTimingReason: null });
    } };
    const session = createMeetingSession({ identity, bridge, runtime, coordinator, clock: { now: () => 1000 }, agentIdentity: { aliases: ["Meetbot"] },
      bridgeId: "mac", bridgeSessionId: "bridge-one", disclosureText: "Disclosure", timedEvidence: { store, onTranscript: (event) => transcripts.push(event.segmentId) } });
    try {
      await session.join(); await setImmediate(); await session.settled();
      const status = store.getTimedEvidenceStatus({ occurrenceId: identity.occurrenceId, bridgeSessionId: "bridge-one", runtimeSessionId: 42n }, 1000);
      if (firstEvent === "final") {
        assert.equal(status?.liveRows, 1); assert.deepEqual(transcripts, ["9"]);
        assert.ok(transport.commands.some((command) => command.type === "authorize_voice_response" && command.segmentId === "9"));
      } else { assert.equal(status?.liveRows, 0); assert.deepEqual(transcripts, []); assert.equal(session.state().speakingAbortReason, "provider_unavailable"); }
    } finally { await session.dispose(); await runtime.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}
