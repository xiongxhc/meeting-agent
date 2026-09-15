import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { RuntimeEvent } from "../src/ports/conversation-runtime.ts";
import { createConversationRuntimeClient } from "../src/adapters/conversation-runtime-client.ts";
import { finalizedWire, runtimeTestClient } from "./lib/runtime-sdk.ts";

test("actual SDK timed admission preserves source evidence and never invents UTC or automatic authorization", async () => {
  const { client, transport } = await runtimeTestClient(4);
  transport.onSend = (command) => {
    transport.push({ type: "command_accepted", protocol_version: 4, request_id: command.requestId });
    if (command.type === "start_timed_voice_session") transport.push({ type: "timed_voice_session_started", protocol_version: 4,
      request_id: command.requestId, media_lease: { media_protocol_version: 2, session_id: "42", connect_endpoint: "tcp://127.0.0.1:9001",
        credential: "a".repeat(64), expires_at_ms: String(Date.now() + 60_000), reconnect_window_ms: "10000", capture_format: "pcm_s16le/24000/1/20ms", timing_contract: "capture-clock/v1" } });
  };
  const runtime = createConversationRuntimeClient(client);
  const events: unknown[] = [];
  runtime.subscribe((event) => events.push(event));
  try {
    const handle = await runtime.startVoiceSession({ timingContract: "capture-clock/v1", bridgeSessionId: "bridge-1", profile: "online", responseMode: "external_gate" });
    assert.equal(handle.sessionId, 42n);
    assert.equal(handle.timingContract, "capture-clock/v1");
    transport.push({ type: "voice_event", protocol_version: 4, event: { type: "voice_session_started", session_id: "42",
      privacy: { privacy_mode: "local_only", components: ["speech_recognition", "language_model", "speech_synthesis", "audio_io"].map((kind) => ({
        kind, execution_location: "local", provider_label: "Synthetic" })) } } });
    transport.push({ type: "voice_event", protocol_version: 4, event: { type: "voice_transcript_final", session_id: "42",
      segment_id: "9", turn_id: null, text: "Agent, remember this", capture_unavailable_reason: "provider_offsets_unavailable" } });
    await setImmediate();
    assert.deepEqual(events.at(-1), { type: "timed_voice_event", bridgeSessionId: "bridge-1", event: {
      type: "voice_transcript_final", sessionId: 42n, segmentId: "9", turnId: null, text: "Agent, remember this",
      captureUnavailableReason: "provider_offsets_unavailable" } });
    assert.deepEqual(transport.commands.map(({ requestId, ...command }) => { assert.ok(requestId); return command; }), [
      { type: "start_timed_voice_session", bridgeSessionId: "bridge-1", profile: "online", responseMode: "external_gate" },
    ]);
  } finally { await runtime.close(); }
});

test("the actual SDK adapter forwards session-aware requests through its own parser", async () => {
  const { client, transport } = await runtimeTestClient(4);
  transport.onSend = (command) => {
    transport.push({ type: "command_accepted", protocol_version: 4, request_id: command.requestId,
      ...(command.type === "authorize_voice_response" ? { turn_id: "99" } : {}) });
    if (command.type === "finalize_recording") transport.push({ ...finalizedWire, request_id: command.requestId });
    if (command.type === "reconcile_recording") transport.push({ type: "recording_reconciled", protocol_version: 4,
      request_id: command.requestId, reconciliation: { segments: [], warnings: [] } });
    if (command.type === "process_text") transport.push({ type: "text_processed", protocol_version: 4,
      request_id: command.requestId, processed: { output: { summary: "synthetic" }, warnings: [] } });
  };
  const runtime = createConversationRuntimeClient(client);
  try {
    const contextExchanges = [{ user: "What changed?", assistant: "The launch moved to October." }];
    await assert.rejects(runtime.startVoiceSession({ profile: "online", responseMode: "external_gate" }), /Task 11/);
    await runtime.seedConversationContext(contextExchanges, "seed-seg-1");
    assert.equal(await runtime.authorizeVoiceResponse({ sessionId: 41n, segmentId: "1", contextExchanges }), 99n);
    await runtime.skipVoiceResponse({ sessionId: 41n, segmentId: "2", reason: "no_alias_match" });
    const recording = await runtime.finalizeRecording({ sessionId: 41n });
    assert.equal(recording.durationMs, 10n);
    await runtime.reconcileRecording({ sessionId: 41n, recordingHandle: recording.recordingHandle });
    assert.deepEqual(await runtime.processText({ sessionId: 42n, instructions: "Return a compact JSON summary.",
      input: "The launch moved to October.", outputSchema: { type: "object" }, maxOutputBytes: 1024 }),
      { output: { summary: "synthetic" }, warnings: [] });
    assert.deepEqual(transport.commands.map(({ requestId, ...command }) => { assert.ok(requestId); return command; }), [
      { type: "seed_conversation_context", operationId: "seed-seg-1", exchanges: contextExchanges },
      { type: "authorize_voice_response", sessionId: 41n, segmentId: "1", contextExchanges },
      { type: "skip_voice_response", sessionId: 41n, segmentId: "2", reason: "no_alias_match" },
      { type: "finalize_recording", sessionId: 41n },
      { type: "reconcile_recording", sessionId: 41n, recordingHandle: recording.recordingHandle },
      { type: "process_text", sessionId: 42n, instructions: "Return a compact JSON summary.",
        input: "The launch moved to October.", outputSchema: { type: "object" }, maxOutputBytes: 1024 },
    ]);
  } finally { await runtime.close(); }
});

test("accepted v4 literal source locator/envelope and missing reasons survive actual adapter parsing", async () => {
  const bytes = readFileSync(new URL("../fixtures/runtime-6f8e88f/transcription-v4/events.jsonl", import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "fd6dd8fe5e0cc416e330b410ed45bd3af0ad791a68aa3f1ead4c6dc7f261c4e5");
  const { client, transport } = await runtimeTestClient(4, 7n), runtime = createConversationRuntimeClient(client), events: RuntimeEvent[] = [];
  runtime.subscribe((event) => events.push(event));
  transport.onSend = (command) => {
    transport.push({ type: "command_accepted", protocol_version: 4, request_id: command.requestId });
    transport.push({ type: "timed_voice_session_started", protocol_version: 4, request_id: command.requestId,
      media_lease: { media_protocol_version: 2, session_id: "7", connect_endpoint: "tcp://127.0.0.1:9001", credential: "a".repeat(64),
        expires_at_ms: String(Date.now() + 60000), reconnect_window_ms: "10000", capture_format: "pcm_s16le/24000/1/20ms", timing_contract: "capture-clock/v1" } });
  };
  try {
    await runtime.startVoiceSession({ timingContract: "capture-clock/v1", bridgeSessionId: "bridge", profile: "online", responseMode: "external_gate" });
    transport.push({ type: "voice_event", protocol_version: 4, event: { type: "voice_session_started", session_id: "7", privacy: { privacy_mode: "local_only",
      components: ["speech_recognition", "language_model", "speech_synthesis", "audio_io"].map((kind) => ({ kind, execution_location: "local", provider_label: "Synthetic" })) } } });
    for (const line of bytes.toString("utf8").trim().split("\n")) transport.push(JSON.parse(line));
    await setImmediate();
    const finals = events.filter((event) => event.type === "timed_voice_event").map((event) => event.event).filter((event) => event.type === "voice_transcript_final");
    assert.equal(finals.length, 3); assert.equal(finals[0]?.capture?.sourceStartSample, 9007199254740993n);
    assert.equal(finals[0]?.liveCoverage?.captureUncertaintyNs, null);
    assert.equal(finals[1]?.captureUnavailableReason, "capture_timing_missing");
    assert.equal(finals[2]?.captureUnavailableReason, "capture_boundary_evicted");
    assert.equal(finals[2]?.text, "boundary unavailable");
  } finally { await runtime.close(); }
});

test("actual adapter rejects v3 and non-external timed admission before sending a start", async () => {
  const legacy = await runtimeTestClient(3), current = await runtimeTestClient(4);
  try {
    assert.throws(() => Reflect.apply(createConversationRuntimeClient, undefined, [legacy.client]), /protocol version 4/);
    const adapter = createConversationRuntimeClient(current.client);
    await assert.rejects(adapter.startVoiceSession({ profile: "online", responseMode: "automatic", timingContract: "capture-clock/v1", bridgeSessionId: "bridge" }), /external_gate/);
    assert.deepEqual(current.transport.commands, []); await adapter.close();
  } finally { await legacy.client.close(); await current.client.close(); }
});

test("actual SDK mismatched lease fails admission without leaking credentials or permitting reuse", async () => {
  const { client, transport } = await runtimeTestClient(4), runtime = createConversationRuntimeClient(client);
  transport.onSend = (command) => {
    transport.push({ type: "command_accepted", protocol_version: 4, request_id: command.requestId });
    transport.push({ type: "timed_voice_session_started", protocol_version: 4, request_id: command.requestId,
      media_lease: { media_protocol_version: 2, session_id: "43", connect_endpoint: "tcp://127.0.0.1:9001", credential: "a".repeat(64),
        expires_at_ms: String(Date.now() + 60000), reconnect_window_ms: "10000", capture_format: "pcm_s16le/24000/1/20ms", timing_contract: "capture-clock/v1" } });
  };
  try {
    const input = { timingContract: "capture-clock/v1" as const, bridgeSessionId: "bridge", profile: "online" as const, responseMode: "external_gate" as const };
    await assert.rejects(runtime.startVoiceSession(input), (error: unknown) => !String(error).includes("a".repeat(64)));
    await assert.rejects(runtime.startVoiceSession(input), /already admitted/);
    assert.equal(transport.commands.length, 1);
  } finally { await runtime.close(); }
});

test("early actual v4 voice failure is routed without claiming healthy media and closed subscriptions cannot resurrect", async () => {
  const { client, transport } = await runtimeTestClient(4), runtime = createConversationRuntimeClient(client), events: RuntimeEvent[] = [];
  runtime.subscribe((event) => events.push(event));
  transport.onSend = (command) => {
    transport.push({ type: "command_accepted", protocol_version: 4, request_id: command.requestId });
    transport.push({ type: "timed_voice_session_started", protocol_version: 4, request_id: command.requestId,
      media_lease: { media_protocol_version: 2, session_id: "42", connect_endpoint: "tcp://127.0.0.1:9001", credential: "a".repeat(64),
        expires_at_ms: String(Date.now() + 60000), reconnect_window_ms: "10000", capture_format: "pcm_s16le/24000/1/20ms", timing_contract: "capture-clock/v1" } });
    transport.push({ type: "voice_event", protocol_version: 4, event: { type: "voice_session_failed", session_id: "42", recovery: "new_session",
      error: { code: "adapter_failure", kind: "adapter", stage: "speech_recognizer", message: "synthetic failure" } } });
  };
  try {
    const handle = await runtime.startVoiceSession({ timingContract: "capture-clock/v1", bridgeSessionId: "bridge", profile: "online", responseMode: "external_gate" });
    assert.equal("status" in handle, false); await setImmediate();
    assert.equal(events.length, 1); assert.equal(events[0]?.type, "timed_voice_event");
    if (events[0]?.type === "timed_voice_event") assert.equal(events[0].event.type, "voice_session_failed");
    await runtime.close(); assert.throws(() => runtime.subscribe(() => {}), /closed/); await runtime.close();
  } finally { await runtime.close(); }
});
