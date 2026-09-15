import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeClient } from "@conversation/runtime";
import { createConversationRuntimeClient } from "../src/adapters/conversation-runtime-client.ts";
import { finalizedWire, runtimeTestClient, testCapability } from "./lib/runtime-sdk.ts";

test("postmeeting adapter rejects actual SDK negotiated v3 instead of silently dropping recovery authority", async () => {
  const { client } = await runtimeTestClient(3);
  try { assert.throws(() => createConversationRuntimeClient(client as unknown as RuntimeClient<4>), /version 4/); }
  finally { await client.close(); }
});

test("actual v4 SDK adapter retains historical capability and exposes the real alignment iterator", async () => {
  const { client, transport } = await runtimeTestClient(4);
  try {
    const runtime = createConversationRuntimeClient(client);
    const pending = runtime.finalizeRecording({ sessionId: 41n });
    const request = transport.commands[0]; assert.ok(request);
    transport.push({ type: "command_accepted", protocol_version: 4, request_id: request.requestId });
    transport.push({ ...finalizedWire, request_id: request.requestId });
    const recording = await pending;
    assert.deepEqual(Reflect.get(recording, "recoveryCapability"), testCapability);
    assert.equal(client.currentSessionId, 42n);
    assert.equal(typeof Reflect.get(runtime, "readRecordingAlignment"), "function");
    await assert.rejects(runtime.startVoiceSession({ profile: "online", responseMode: "external_gate" }), /Task 11|live/);
  } finally { await client.close(); }
});
