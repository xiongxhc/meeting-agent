// A generation that loses its bridge, its media path or its Runtime voice session
// ends with what it captured finalized, a persisted capture gap and its lease released,
// so the composition can start the next generation. A recognition failure never ends
// a generation: it suspends speaking until recognition is seen working again.
//
// "VAD check gates speech recognition, not encrypted recording. Recording must remain
// independent of provider failures."

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import { createCoordinator } from "../src/sessions/coordinator.ts";
import { createMeetingSession } from "../src/sessions/meeting-session.ts";
import { createConversationRuntimeClient } from "../src/adapters/conversation-runtime-client.ts";
import { parseCommandV2, type BridgeCommandMessageV2 } from "../src/contracts/bridge-session-v2.ts";
import { runtimeTestClient, finalizedWire } from "./lib/runtime-sdk.ts";

const NOW_MS = Date.parse("2026-09-02T14:05:00.000Z");
const NOW = new Date(NOW_MS).toISOString();

type Harness = Awaited<ReturnType<typeof harness>>;

async function harness(options: { connectOutcome?: "ok" | "failed"; recovery?: { uncoveredSince: string }; recoveryGeneration?: boolean } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-session-recovery-"));
  const store = openSessionStore({ filename: path.join(dir, "state.db") });
  const identity = buildMeetingIdentity({ providerMeetingId: "recovery", meetingNo: "000000000", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "Recovery", organizer: null });
  const clock = { now: () => NOW_MS };
  const coordinator = createCoordinator({ store, clock, bridgeLeaseTtlMs: 30000, maxConcurrentSessions: 1 });
  coordinator.discover(identity);
  if (options.recoveryGeneration) { coordinator.advance(identity.occurrenceId, "joining"); coordinator.advance(identity.occurrenceId, "listening"); }
  const { client, transport } = await runtimeTestClient(4);
  const runtime = createConversationRuntimeClient(client);
  transport.onSend = (command) => {
    transport.push({ type: "command_accepted", protocol_version: 4, request_id: command.requestId, ...(command.type === "authorize_voice_response" ? { turn_id: "99" } : {}) });
    if (command.type === "start_drainable_timed_voice_session") transport.push({ type: "timed_voice_session_started", protocol_version: 4, request_id: command.requestId,
      media_lease: { media_protocol_version: 3, session_id: "42", connect_endpoint: "tcp://127.0.0.1:9001", credential: "a".repeat(64),
        expires_at_ms: String(Date.now() + 60000), reconnect_window_ms: "10000", capture_format: "pcm_s16le/24000/1/20ms", timing_contract: "capture-clock/v1" } });
    if (command.type === "start_drainable_timed_voice_session") transport.push({ type: "voice_event", protocol_version: 4, event: { type: "voice_session_started", session_id: "42",
      privacy: { privacy_mode: "cloud", components: ["speech_recognition", "language_model", "speech_synthesis", "audio_io"].map((kind) => ({ kind, execution_location: "remote", provider_label: "Synthetic" })) } } });
    if (command.type === "finalize_recording") transport.push({ ...finalizedWire, request_id: command.requestId, recovery_capability: { ...finalizedWire.recovery_capability, source_session_id: "42" } });
  };
  let listener: ((raw: unknown) => void) | undefined, closedListener: (() => void) | undefined, sequence = 0;
  const bridgeCommands: string[] = [];
  const emit = (event: Record<string, unknown>, observedAt = "2026-09-02T14:05:00.000Z") =>
    listener?.({ schema: "bridge-session/v2", sessionId: "bridge-one", sequence: ++sequence, observedAt, ...event });
  const bridge = {
    subscribe(callback: (raw: unknown) => void) { listener = callback; return () => { listener = undefined; }; },
    onClosed(callback: () => void) { closedListener = callback; return () => { closedListener = undefined; }; },
    async send(command: BridgeCommandMessageV2) {
      parseCommandV2(command); bridgeCommands.push(command.type);
      if (command.type === "join") emit({ type: "joined", meetingOccurrenceId: identity.occurrenceId, observationTiming: { clockDomainId: "domain", hostBeforeNs: "0", hostAfterNs: "1" }, observationTimingReason: null });
      if (command.type === "connect_media") {
        if ((options.connectOutcome ?? "ok") === "ok") emit({ type: "media_connected", endpoint: "tcp://127.0.0.1:9001" }, "2026-09-02T14:05:01.000Z");
        emit({ type: "command_result", commandId: command.commandId, outcome: options.connectOutcome ?? "ok", detail: options.connectOutcome === "failed" ? "media_start_failed" : null });
      }
    },
  };
  const session = createMeetingSession({ identity, bridge, runtime, coordinator, clock, agentIdentity: { aliases: ["Meetbot"] },
    bridgeId: "mac", bridgeSessionId: "bridge-one", disclosureText: "Disclosure", timedEvidence: { store },
    ...(options.recovery ? { recovery: options.recovery } : {}) });
  const voice = (event: Record<string, unknown>) => transport.push({ type: "voice_event", protocol_version: 4, event: { session_id: "42", ...event } });
  const final = (segmentId: string, text: string) => voice({ type: "voice_transcript_final", segment_id: segmentId, turn_id: null, text, capture_unavailable_reason: "provider_offsets_unavailable" });
  const fail = (recovery: "continue_session" | "new_session", stage = recovery === "continue_session" ? "speech_recognizer" : "language_model") =>
    voice({ type: "voice_session_failed", recovery, error: { code: "adapter_failure", kind: "adapter", stage, message: "synthetic failure" } });
  const settle = async () => { for (let index = 0; index < 4; index += 1) { await setImmediate(); await session.settled(); } };
  return {
    store, identity, coordinator, transport, session, bridgeCommands, emit, voice, final, fail, settle,
    runtimeCommands: () => transport.commands.map((command) => command.type),
    closeBridge: () => closedListener?.(),
    hasClosedListener: () => closedListener !== undefined,
    async cleanup() { await session.dispose(); await runtime.close(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function assertEndedForRecovery(h: Harness, gapStartedAt: string) {
  const state = h.session.state();
  assert.equal(state.terminalReason, "bridge_failure", "the generation ended for recovery");
  assert.equal(h.runtimeCommands().filter((type) => type === "finalize_recording").length, 1, "what was captured is finalized once");
  assert.ok(h.runtimeCommands().indexOf("stop_voice_session") < h.runtimeCommands().indexOf("finalize_recording"), "stop before finalize");
  assert.equal(h.store.getSession(h.identity.occurrenceId)?.state, "listening", "the occurrence stays recoverable");
  const failed = h.store.getBridgeFailureRecording(h.identity.occurrenceId, 1);
  assert.ok(failed, "the failed generation's recording is persisted");
  assert.equal(failed.handle, finalizedWire.recording.recording_handle);
  const last = failed.gaps.at(-1);
  assert.deepEqual(last && { direction: last.direction, startedAt: last.startedAt, endedAt: last.endedAt }, { direction: "capture", startedAt: gapStartedAt, endedAt: null },
    "the capture loss is persisted as an open gap");
  assert.equal(h.store.getActiveLease(h.identity.occurrenceId), null, "the lease is released");
}

test("a terminal Runtime voice failure ends the generation for recovery: leave, finalize, persisted gap, lease released", async () => {
  const h = await harness();
  try {
    await h.session.join(); await h.settle();
    h.fail("new_session"); await h.settle();
    assert.ok(h.bridgeCommands.includes("leave"), "the bridge is asked to leave so the next generation can claim the client");
    assert.equal(h.session.state().recoveryCause, "runtime_voice_terminal");
    assertEndedForRecovery(h, NOW);
  } finally { await h.cleanup(); }
});

test("a failed connect_media ends the generation for recovery with a gap from the generation start", async () => {
  const h = await harness({ connectOutcome: "failed" });
  try {
    await h.session.join().catch(() => undefined); await h.settle();
    assert.equal(h.session.state().recoveryCause, "media_connect_failed");
    assert.ok(h.bridgeCommands.includes("leave"));
    assertEndedForRecovery(h, h.session.state().generationStartedAt);
  } finally { await h.cleanup(); }
});

test("a bridge transport that closes without left ends the generation without asking the dead bridge to leave", async () => {
  const h = await harness();
  try {
    await h.session.join(); await h.settle();
    assert.ok(h.hasClosedListener(), "the session listens for the bridge transport closing");
    h.closeBridge(); await h.settle();
    assert.equal(h.bridgeCommands.includes("leave"), false);
    assert.equal(h.session.state().recoveryCause, "bridge_closed");
    assertEndedForRecovery(h, NOW);
    assert.equal(h.hasClosedListener(), false, "unsubscribed at terminal");
  } finally { await h.cleanup(); }
});

test("a bridge-reported bridge_failure also persists the capture loss as a gap", async () => {
  const h = await harness();
  try {
    await h.session.join(); await h.settle();
    h.emit({ type: "left", reason: "bridge_failure", observationTiming: null, observationTimingReason: "timing_unavailable" }); await h.settle();
    assertEndedForRecovery(h, NOW);
  } finally { await h.cleanup(); }
});

test("a recognition failure suspends speaking and the next final transcript re-arms it; recording and bridge are untouched", async () => {
  const h = await harness();
  try {
    await h.session.join(); await h.settle();
    h.fail("continue_session"); await h.settle();
    assert.equal(h.session.state().speaking, "aborted");
    assert.equal(h.session.state().speakingAbortReason, "provider_unavailable");
    assert.equal(h.session.state().recognition, "interrupted");
    h.final("10", "Meetbot, what did we decide?"); await h.settle();
    assert.equal(h.session.state().speaking, "enabled", "recognition is healthy again, so speaking is re-armed");
    assert.equal(h.session.state().recognition, "healthy");
    assert.ok(h.runtimeCommands().includes("authorize_voice_response"), "the agent can answer again");
    assert.equal(h.session.state().phase, "listening");
    assert.equal(h.bridgeCommands.includes("leave"), false);
    assert.equal(h.runtimeCommands().includes("finalize_recording"), false);
    assert.equal(h.runtimeCommands().includes("stop_voice_session"), false);
  } finally { await h.cleanup(); }
});

test("repeated recognition failures with no output between them mark recognition failed; recognition output (a partial) still re-arms, and recording continues", async () => {
  const h = await harness();
  try {
    await h.session.join(); await h.settle();
    for (let index = 0; index < 4; index += 1) { h.fail("continue_session"); await h.settle(); }
    let state = h.session.state();
    assert.equal(state.recognitionFailures, 4);
    assert.equal(state.recognition, "failed");
    assert.equal(state.speaking, "aborted");
    assert.equal(state.recognitionOutages.length, 1, "one outage until recognition produces output");
    h.voice({ type: "voice_transcript_partial", segment_id: "30", text: "Meetbot" }); await h.settle();
    state = h.session.state();
    assert.equal(state.recognition, "healthy", "the Runtime's in-session reconnect worked");
    assert.equal(state.speaking, "enabled");
    assert.notEqual(state.recognitionOutages[0]?.endedAt, null);
    assert.equal(state.phase, "listening");
    assert.equal(h.bridgeCommands.includes("leave"), false);
    assert.equal(h.runtimeCommands().includes("finalize_recording"), false);
  } finally { await h.cleanup(); }
});

test("a permanent abort is not re-armed by a later transcript", async () => {
  const h = await harness();
  try {
    await h.session.join(); await h.settle();
    h.fail("continue_session"); await h.settle();
    // A queue overflow is permanent; simulate the one other permanent path reachable here.
    for (let index = 0; index < 300; index += 1) h.emit({ type: "chat_disclosure", outcome: "sent" });
    await h.settle();
    assert.equal(h.session.state().speakingAbortReason, "queue_overflow");
    h.final("40", "Meetbot, hello"); await h.settle();
    assert.equal(h.session.state().speaking, "aborted");
  } finally { await h.cleanup(); }
});

test("a recovery generation records the uncovered span before its media as a capture gap in the recording it finalizes", async () => {
  const h = await harness({ recovery: { uncoveredSince: "2026-09-02T14:01:00.000Z" }, recoveryGeneration: true });
  try {
    await h.session.join(); await h.settle();
    h.emit({ type: "left", reason: "ended", observationTiming: null, observationTimingReason: "timing_unavailable" }, "2026-09-02T14:30:00.000Z"); await h.settle();
    const stored = h.store.getRecording(h.identity.occurrenceId);
    assert.ok(stored);
    assert.deepEqual(stored.gaps.map((gap) => ({ direction: gap.direction, startedAt: gap.startedAt, endedAt: gap.endedAt })),
      [{ direction: "capture", startedAt: "2026-09-02T14:01:00.000Z", endedAt: "2026-09-02T14:05:01.000Z" }]);
  } finally { await h.cleanup(); }
});

test("a language-model or synthesis failure on a kept session fails the turn only: no outage, no speaking suspension, no recognition count", async () => {
  const h = await harness();
  try {
    await h.session.join(); await h.settle();
    h.fail("continue_session", "language_model"); await h.settle();
    h.fail("continue_session", "speech_synthesizer"); await h.settle();
    const state = h.session.state();
    assert.equal(state.speaking, "enabled");
    assert.equal(state.recognition, "healthy");
    assert.equal(state.recognitionFailures, 0);
    assert.deepEqual(state.recognitionOutages, []);
    assert.equal(h.bridgeCommands.includes("leave"), false);
  } finally { await h.cleanup(); }
});

test("a recovery generation's transition gap never starts before the occurrence start", async () => {
  const h = await harness({ recovery: { uncoveredSince: "2026-09-02T13:58:00.000Z" }, recoveryGeneration: true });
  try {
    await h.session.join(); await h.settle();
    h.emit({ type: "left", reason: "ended", observationTiming: null, observationTimingReason: "timing_unavailable" }, "2026-09-02T14:30:00.000Z"); await h.settle();
    assert.deepEqual(h.store.getRecording(h.identity.occurrenceId)?.gaps.map((gap) => [gap.startedAt, gap.endedAt]),
      [["2026-09-02T14:00:00Z", "2026-09-02T14:05:01.000Z"]]);
  } finally { await h.cleanup(); }
});

test("a forged left-shaped line admitted over a full queue cannot use up the bridge-closed notice's admission", async () => {
  const h = await harness();
  try {
    await h.session.join(); await h.settle();
    for (let index = 0; index < 300; index += 1) h.emit({ type: "chat_disclosure", outcome: "sent" });
    h.emit({ type: "left", reason: "not-a-reason", observationTiming: null, observationTimingReason: "timing_unavailable" });
    h.closeBridge();
    await h.settle();
    assert.equal(h.session.state().terminalReason, "bridge_failure", "the closure still ends the generation");
    assert.equal(h.session.state().recoveryCause, "bridge_closed");
  } finally { await h.cleanup(); }
});
