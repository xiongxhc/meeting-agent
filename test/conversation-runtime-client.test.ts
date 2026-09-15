import assert from "node:assert/strict";
import { test } from "node:test";
import { createConversationRuntimeClient } from "../src/adapters/conversation-runtime-client.ts";
import { finalizedWire, runtimeTestClient } from "./lib/runtime-sdk.ts";

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
