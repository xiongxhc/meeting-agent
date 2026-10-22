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
import timers from "node:timers";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import { createCoordinator } from "../src/sessions/coordinator.ts";
import { createMeetingSession } from "../src/sessions/meeting-session.ts";
import { createConversationRuntimeClient } from "../src/adapters/conversation-runtime-client.ts";
import { parseCommandV2, type BridgeCommandMessageV2 } from "../src/contracts/bridge-session-v2.ts";
import { runtimeTestClient, finalizedWire } from "./lib/runtime-sdk.ts";
import type { RuntimeEvent } from "../src/ports/conversation-runtime.ts";

const NOW_MS = Date.parse("2026-09-02T14:05:00.000Z");
const NOW = new Date(NOW_MS).toISOString();

type Harness = Awaited<ReturnType<typeof harness>>;

async function harness(options: { connectOutcome?: "ok" | "failed"; recovery?: { uncoveredSince: string }; recoveryGeneration?: boolean;
  /** A short lease on the real clock (the SDK checks expiry against it); default keeps the fixed clock and a 60 s lease. */
  leaseMs?: number;
  /** Installs the port's renewMediaLease, with the Runtime capability reported as `supported` (default true). */
  renew?: (input: { readonly sessionId: bigint }) => Promise<bigint>;
  supported?: boolean;
  /** Whether the bridge's connected answer advertises renewal (default true). */
  bridgeAdvertises?: boolean;
  renewalOutcome?: "ok" | "rejected" } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-session-recovery-"));
  const store = openSessionStore({ filename: path.join(dir, "state.db") });
  const identity = buildMeetingIdentity({ providerMeetingId: "recovery", meetingNo: "000000000", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "Recovery", organizer: null });
  const clock = { now: () => options.leaseMs === undefined ? NOW_MS : Date.now() };
  const coordinator = createCoordinator({ store, clock, bridgeLeaseTtlMs: 30000, maxConcurrentSessions: 1 });
  coordinator.discover(identity);
  if (options.recoveryGeneration) { coordinator.advance(identity.occurrenceId, "joining"); coordinator.advance(identity.occurrenceId, "listening"); }
  const { client, transport } = await runtimeTestClient(4);
  const runtime = createConversationRuntimeClient(client);
  const runtimeListeners = new Set<(event: RuntimeEvent) => void>();
  const base = options.renew === undefined ? runtime
    : { ...runtime, renewMediaLease: options.renew, supportsMediaLeaseRenewal: async () => options.supported ?? true };
  // Records the session's Runtime listener, so a test can deliver an event the
  // pinned SDK cannot parse yet (round-2 codes) at the port boundary.
  const port = { ...base,
    subscribe(listener: (event: RuntimeEvent) => void) {
      runtimeListeners.add(listener);
      const unsubscribe = base.subscribe(listener);
      return () => { runtimeListeners.delete(listener); unsubscribe(); };
    },
  };
  transport.onSend = (command) => {
    transport.push({ type: "command_accepted", protocol_version: 4, request_id: command.requestId, ...(command.type === "authorize_voice_response" ? { turn_id: "99" } : {}) });
    if (command.type === "start_drainable_timed_voice_session") transport.push({ type: "timed_voice_session_started", protocol_version: 4, request_id: command.requestId,
      media_lease: { media_protocol_version: 3, session_id: "42", connect_endpoint: "tcp://127.0.0.1:9001", credential: "a".repeat(64),
        expires_at_ms: String(Date.now() + (options.leaseMs ?? 60000)), reconnect_window_ms: options.leaseMs === undefined ? "10000" : String(Math.floor(options.leaseMs / 2)), capture_format: "pcm_s16le/24000/1/20ms", timing_contract: "capture-clock/v1" } });
    if (command.type === "start_drainable_timed_voice_session") transport.push({ type: "voice_event", protocol_version: 4, event: { type: "voice_session_started", session_id: "42",
      privacy: { privacy_mode: "cloud", components: ["speech_recognition", "language_model", "speech_synthesis", "audio_io"].map((kind) => ({ kind, execution_location: "remote", provider_label: "Synthetic" })) } } });
    if (command.type === "finalize_recording") transport.push({ ...finalizedWire, request_id: command.requestId, recovery_capability: { ...finalizedWire.recovery_capability, source_session_id: "42" } });
  };
  let listener: ((raw: unknown) => void) | undefined, closedListener: (() => void) | undefined, sequence = 0;
  const bridgeCommands: string[] = [];
  const renewals: string[] = [];
  const emit = (event: Record<string, unknown>, observedAt = "2026-09-02T14:05:00.000Z") =>
    listener?.({ schema: "bridge-session/v2", sessionId: "bridge-one", sequence: ++sequence, observedAt, ...event });
  const bridge = {
    subscribe(callback: (raw: unknown) => void) { listener = callback; return () => { listener = undefined; }; },
    onClosed(callback: () => void) { closedListener = callback; return () => { closedListener = undefined; }; },
    async send(command: BridgeCommandMessageV2) {
      parseCommandV2(command); bridgeCommands.push(command.type);
      if (command.type === "renew_media_lease") {
        renewals.push(command.leaseRenewal.expiresAtMs);
        emit({ type: "command_result", commandId: command.commandId, outcome: options.renewalOutcome ?? "ok", detail: options.renewalOutcome === "rejected" ? "media_not_connected" : null });
      }
      if (command.type === "join") emit({ type: "joined", meetingOccurrenceId: identity.occurrenceId, observationTiming: { clockDomainId: "domain", hostBeforeNs: "0", hostAfterNs: "1" }, observationTimingReason: null });
      if (command.type === "connect_media") {
        if ((options.connectOutcome ?? "ok") === "ok") emit({ type: "media_connected", endpoint: "tcp://127.0.0.1:9001" }, "2026-09-02T14:05:01.000Z");
        emit({ type: "command_result", commandId: command.commandId, outcome: options.connectOutcome ?? "ok",
          detail: options.connectOutcome === "failed" ? "media_start_failed" : options.bridgeAdvertises === false ? null : "media_lease_renewal" });
      }
    },
  };
  const session = createMeetingSession({ identity, bridge, runtime: port, coordinator, clock, agentIdentity: { aliases: ["Meetbot"] },
    bridgeId: "mac", bridgeSessionId: "bridge-one", disclosureText: "Disclosure", timedEvidence: { store },
    ...(options.recovery ? { recovery: options.recovery } : {}) });
  const voice = (event: Record<string, unknown>) => transport.push({ type: "voice_event", protocol_version: 4, event: { session_id: "42", ...event } });
  const final = (segmentId: string, text: string) => voice({ type: "voice_transcript_final", segment_id: segmentId, turn_id: null, text, capture_unavailable_reason: "provider_offsets_unavailable" });
  const fail = (recovery: "continue_session" | "new_session", stage = recovery === "continue_session" ? "speech_recognizer" : "language_model", code = "adapter_failure") =>
    voice({ type: "voice_session_failed", recovery, error: { code, kind: "adapter", stage, message: "synthetic failure" } });
  const settle = async () => { for (let index = 0; index < 4; index += 1) { await setImmediate(); await session.settled(); } };
  return {
    store, identity, coordinator, transport, session, bridgeCommands, renewals, emit, voice, final, fail, settle,
    runtimeCommands: () => transport.commands.map((command) => command.type),
    injectRuntime: (event: RuntimeEvent) => { for (const listener of [...runtimeListeners]) listener(event); },
    closeBridge: () => closedListener?.(),
    hasClosedListener: () => closedListener !== undefined,
    async cleanup() { await session.dispose(); await runtime.close(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** `gapStartedAt` null: the session ran on the real clock, so only the gap's shape is checked. */
function assertEndedForRecovery(h: Harness, gapStartedAt: string | null) {
  const state = h.session.state();
  assert.equal(state.terminalReason, "bridge_failure", "the generation ended for recovery");
  assert.equal(h.runtimeCommands().filter((type) => type === "finalize_recording").length, 1, "what was captured is finalized once");
  assert.ok(h.runtimeCommands().indexOf("stop_voice_session") < h.runtimeCommands().indexOf("finalize_recording"), "stop before finalize");
  assert.equal(h.store.getSession(h.identity.occurrenceId)?.state, "listening", "the occurrence stays recoverable");
  const failed = h.store.getBridgeFailureRecording(h.identity.occurrenceId, 1);
  assert.ok(failed, "the failed generation's recording is persisted");
  assert.equal(failed.handle, finalizedWire.recording.recording_handle);
  const last = failed.gaps.at(-1);
  assert.deepEqual(last && { direction: last.direction, startedAt: gapStartedAt === null ? null : last.startedAt, endedAt: last.endedAt }, { direction: "capture", startedAt: gapStartedAt, endedAt: null },
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

// The media lease is renewed while the meeting runs, so the bridge's own
// reconnect admission follows the Runtime's. Only both sides advertising it
// starts renewal. A failed renewal while media still flows is degraded, never a
// relaunch; only a real media loss relaunches.
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function assertStillRecording(h: Harness) {
  assert.equal(h.session.state().terminalReason, null, "the generation is not ended");
  assert.equal(h.session.state().phase, "listening");
  assert.equal(h.bridgeCommands.includes("leave"), false);
  assert.equal(h.runtimeCommands().includes("finalize_recording"), false, "the recording is not split");
  assert.equal(h.runtimeCommands().includes("stop_voice_session"), false);
}

test("the live session renews at a third of the remaining lifetime and forwards each expiry to the bridge", async () => {
  const calls: bigint[] = [];
  const h = await harness({ leaseMs: 900, renew: async ({ sessionId }) => { calls.push(sessionId); return BigInt(Date.now() + 900); } });
  try {
    await h.session.join(); await h.settle();
    await wait(200);
    assert.equal(calls.length, 0, "nothing is renewed before a third of the lifetime has passed");
    await wait(250); await h.settle();
    assert.ok(calls.length >= 1, "renewed by about a third of the lifetime");
    await wait(500); await h.settle();
    assert.ok(calls.length >= 2 && calls.length <= 4, `one renewal per third of the lifetime (${calls.length} in ~950 ms)`);
    assert.ok(calls.every((sessionId) => sessionId === 42n), "always the live voice session");
    assert.ok(h.renewals.length >= 2);
    assert.deepEqual(h.renewals.map(BigInt), [...h.renewals.map(BigInt)].sort((a, b) => (a < b ? -1 : 1)), "expiries only move forward");
    assert.equal(h.session.state().leaseRenewal, "renewing");
    assertStillRecording(h);
    h.emit({ type: "left", reason: "ended", observationTiming: null, observationTimingReason: "timing_unavailable" }); await h.settle();
    const after = calls.length;
    await wait(500);
    assert.equal(calls.length, after, "the renewal timer stops with the session");
  } finally { await h.cleanup(); }
});

test("without the Runtime capability, or a bridge that does not advertise renewal, nothing is renewed and nothing relaunches", async () => {
  for (const options of [{}, { supported: false }, { bridgeAdvertises: false }]) {
    const calls: bigint[] = [];
    const h = await harness({ leaseMs: 300, ...("supported" in options || "bridgeAdvertises" in options ? { renew: async ({ sessionId }: { readonly sessionId: bigint }) => { calls.push(sessionId); return BigInt(Date.now() + 300); } } : {}), ...options });
    try {
      await h.session.join(); await h.settle();
      await wait(450); await h.settle();
      assert.equal(calls.length, 0, JSON.stringify(options));
      assert.equal(h.bridgeCommands.includes("renew_media_lease"), false);
      // The actual adapter on the pinned SDK, and a Runtime without the flag, report unsupported;
      // a bridge that did not advertise renewal never gets as far as asking.
      assert.equal(h.session.state().leaseRenewal, "bridgeAdvertises" in options ? "inactive" : "unsupported");
      assertStillRecording(h);
    } finally { await h.cleanup(); }
  }
});

test("on today's pinned SDK the actual adapter reports no renewal support: no status probe, no renewal, no relaunch", async () => {
  const h = await harness({ leaseMs: 300 });
  try {
    await h.session.join(); await h.settle();
    await wait(450); await h.settle();
    assert.equal(h.bridgeCommands.includes("renew_media_lease"), false);
    assert.equal(h.runtimeCommands().includes("status"), false);
    assertStillRecording(h);
  } finally { await h.cleanup(); }
});

for (const [name, renew, extra] of [
  ["a refused renewal", async () => { throw new Error("renewal refused"); }, {}],
  ["a renewal that never answers", () => new Promise<bigint>(() => undefined), {}],
  ["a renewal the bridge cannot apply", async () => BigInt(Date.now() + 600), { renewalOutcome: "rejected" as const }],
] as const) {
  test(`${name} while media flows marks renewal degraded and retries; it never relaunches`, async () => {
    let calls = 0;
    const h = await harness({ leaseMs: 600, renew: () => { calls += 1; return renew(); }, ...extra });
    try {
      await h.session.join(); await h.settle();
      await wait(450); await h.settle();
      assert.equal(h.session.state().leaseRenewal, "degraded");
      assert.ok(h.session.state().leaseRenewalFailures >= 1);
      assertStillRecording(h);
      await wait(500); await h.settle();
      assert.ok(calls >= 2 || h.session.state().leaseRenewal === "lapsed", "it retried before the lease lapsed");
      assertStillRecording(h);
    } finally { await h.cleanup(); }
  });
}

test("retries of a failing renewal stay at least a floor apart and none is sent once the lease has passed", async () => {
  const at: number[] = [];
  let expiry = 0;
  const h = await harness({ leaseMs: 900, renew: async () => { at.push(Date.now()); throw new Error("renewal refused"); } });
  try {
    expiry = Date.now() + 900;
    await h.session.join(); await h.settle();
    await wait(1400); await h.settle();
    assert.equal(h.session.state().leaseRenewal, "lapsed");
    const gaps = at.slice(1).map((value, index) => value - at[index]!);
    assert.ok(gaps.every((gap) => gap >= 200), `no retries bunched near the lapse (gaps ${gaps.join(",")} ms)`);
    assert.ok(at.length >= 2 && at.length <= 4, `${at.length} calls`);
    assert.ok(at.every((value) => value < expiry + 50), "nothing is sent after the lease has passed");
    assertStillRecording(h);
  } finally { await h.cleanup(); }
});

test("a renewal that timed out is still the one call in flight: no second call overlaps it", async () => {
  let inFlight = 0, most = 0, calls = 0;
  const h = await harness({ leaseMs: 900, renew: () => { calls += 1; inFlight += 1; most = Math.max(most, inFlight); return new Promise<bigint>(() => undefined); } });
  try {
    await h.session.join(); await h.settle();
    await wait(1300); await h.settle();
    assert.equal(most, 1, "one call in flight");
    assert.equal(calls, 1, "the unanswered call is not overlapped");
    assert.ok(h.session.state().leaseRenewalFailures >= 2, "each skipped attempt still counts as a failure");
    assert.equal(h.session.state().leaseRenewal, "lapsed");
    assertStillRecording(h);
  } finally { await h.cleanup(); }
});

test("the renewal loop holds one timer and one abort listener, and clears its timer when the session ends", async () => {
  // Counts only what meeting-session.ts itself creates through node:timers and addEventListener.
  const fromSession = () => (new Error().stack?.split("\n")[3] ?? "").includes("meeting-session.ts");
  const original = { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, add: EventTarget.prototype.addEventListener };
  const live = new Set<unknown>();
  let most = 0, abortListeners = 0;
  timers.setTimeout = ((callback: () => void, ms: number) => {
    const counted = fromSession();
    const handle: ReturnType<typeof setTimeout> = original.setTimeout(() => { live.delete(handle); callback(); }, ms);
    if (counted) { live.add(handle); most = Math.max(most, live.size); }
    return handle;
  }) as typeof timers.setTimeout;
  timers.clearTimeout = ((handle: ReturnType<typeof setTimeout> | undefined) => { live.delete(handle); original.clearTimeout(handle); }) as typeof timers.clearTimeout;
  EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, ...rest: unknown[]) {
    if (type === "abort" && fromSession()) abortListeners += 1;
    return (original.add as (...args: unknown[]) => void).call(this, type, ...rest);
  } as typeof EventTarget.prototype.addEventListener;
  syncBuiltinESMExports();
  try {
    const h = await harness({ leaseMs: 300, renew: async () => BigInt(Date.now() + 300) });
    try {
      await h.session.join(); await h.settle();
      await wait(450); await h.settle();
      assert.ok(h.renewals.length >= 3, "several renewals ran");
      assert.equal(most, 1, "one timer at a time");
      assert.equal(abortListeners, 1, "one abort listener for the whole loop");
      assert.equal(live.size, 1, "the next renewal is armed");
      h.emit({ type: "left", reason: "ended", observationTiming: null, observationTimingReason: "timing_unavailable" }); await h.settle();
      assert.equal(live.size, 0, "the session's end clears the timer");
    } finally { await h.cleanup(); }
  } finally {
    timers.setTimeout = original.setTimeout; timers.clearTimeout = original.clearTimeout; EventTarget.prototype.addEventListener = original.add;
    syncBuiltinESMExports();
  }
});

test("once the lease lapses renewal stops and is reported; recording continues", async () => {
  let calls = 0;
  const h = await harness({ leaseMs: 300, renew: async () => { calls += 1; throw new Error("renewal refused"); } });
  try {
    await h.session.join(); await h.settle();
    await wait(700); await h.settle();
    assert.equal(h.session.state().leaseRenewal, "lapsed");
    const after = calls;
    await wait(300);
    assert.equal(calls, after, "a lapsed lease is not renewed");
    assertStillRecording(h);
  } finally { await h.cleanup(); }
});

for (const reason of ["reconnect_exhausted", "media_failed"]) {
  test(`a bridge that gives up its media path (${reason}) ends the generation for recovery`, async () => {
    const h = await harness();
    try {
      await h.session.join(); await h.settle();
      h.emit({ type: "media_disconnected", reason: "media_transport_interrupted" }); await h.settle();
      assert.equal(h.session.state().terminalReason, null, "an interruption the bridge is still recovering from is not a give-up");
      h.emit({ type: "media_disconnected", reason }); await h.settle();
      assert.equal(h.session.state().recoveryCause, "media_lost");
      assert.ok(h.bridgeCommands.includes("leave"));
      assertEndedForRecovery(h, NOW);
    } finally { await h.cleanup(); }
  });
}

test("the Runtime's media_lease_lost ends the generation for recovery; another audio_capture failure does not", async () => {
  const h = await harness();
  try {
    await h.session.join(); await h.settle();
    h.fail("continue_session", "audio_capture"); await h.settle();
    assertStillRecording(h);
    h.injectRuntime({ type: "timed_voice_event", bridgeSessionId: "bridge-one", event: { type: "voice_session_failed", sessionId: 42n, recovery: "continue_session",
      error: { code: "media_lease_lost", kind: "adapter", stage: "audio_capture", message: "synthetic media loss" } } } as unknown as RuntimeEvent);
    await h.settle();
    assert.equal(h.session.state().recoveryCause, "media_lost");
    assertEndedForRecovery(h, NOW);
  } finally { await h.cleanup(); }
});
