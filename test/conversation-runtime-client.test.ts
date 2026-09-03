import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createConversationRuntimeClient,
  type ConversationRuntimeSdk,
} from "../src/adapters/conversation-runtime-client.ts";

test("the SDK-shaped adapter forwards every session-aware object request without a wire codec", async () => {
  const calls: unknown[] = [];
  const sdk = {
    async startVoiceSession(options?: { profile?: "offline" | "online"; responseMode?: "automatic" | "external_gate" }) {
      calls.push({ method: "startVoiceSession", options });
      return { events: () => (async function* () {})(), stop: async () => {}, pauseCapture: async () => {}, resumeCapture: async () => {} };
    },
    async seedConversationContext(exchanges: readonly { user: string; assistant: string }[], operationId: string) {
      calls.push({ method: "seedConversationContext", exchanges, operationId });
    },
    async authorizeVoiceResponse(input: { sessionId: bigint; segmentId: string; contextExchanges: { user: string; assistant: string }[] }) {
      calls.push({ method: "authorizeVoiceResponse", input });
      return 99n;
    },
    async skipVoiceResponse(input: { sessionId: bigint; segmentId: string; reason: string }) {
      calls.push({ method: "skipVoiceResponse", input });
    },
    async finalizeRecording(input: { sessionId: bigint }) {
      calls.push({ method: "finalizeRecording", input });
      return {
        recordingHandle: "0a1b2c3d4e5f60718293a4b5c6d7e8f9",
        encryptedPath: "/synthetic/recording.enc",
        sha256: "0".repeat(64),
        durationMs: 3_600_000n,
        format: "ogg/opus",
        keyId: "runtime-key",
        gaps: [{ startedAtMs: 7n, endedAtMs: null, reason: "capture_gap" }],
      };
    },
    async reconcileRecording(input: { sessionId: bigint; recordingHandle: string }) {
      calls.push({ method: "reconcileRecording", input });
      return { segments: [], warnings: [] };
    },
    async processText(input: {
      sessionId: bigint;
      instructions: string;
      input: string;
      outputSchema: Record<string, unknown>;
      maxOutputBytes: number;
    }) {
      calls.push({ method: "processText", input });
      return { output: { summary: "synthetic" }, warnings: [] };
    },
    async close() {
      calls.push({ method: "close" });
    },
  } satisfies ConversationRuntimeSdk;
  const runtime = createConversationRuntimeClient(sdk);
  const contextExchanges = [{ user: "What changed?", assistant: "The launch moved to October." }];

  await assert.rejects(
    runtime.startVoiceSession({ profile: "online", responseMode: "external_gate" }),
    /before Task 11/,
  );
  await runtime.seedConversationContext(contextExchanges, "seed-seg-1");
  assert.equal(await runtime.authorizeVoiceResponse({ sessionId: 41n, segmentId: "seg-1", contextExchanges }), 99n);
  await runtime.skipVoiceResponse({ sessionId: 41n, segmentId: "seg-2", reason: "no_alias_match" });
  const recording = await runtime.finalizeRecording({ sessionId: 41n });
  assert.equal(recording.durationMs, 3_600_000n);
  assert.deepEqual(recording.gaps, [{ startedAtMs: 7n, endedAtMs: null, reason: "capture_gap" }]);
  await runtime.reconcileRecording({ sessionId: 41n, recordingHandle: recording.recordingHandle });
  assert.deepEqual(
    await runtime.processText({
      sessionId: 41n,
      instructions: "Return a compact JSON summary.",
      input: "The launch moved to October.",
      outputSchema: { type: "object" },
      maxOutputBytes: 1024,
    }),
    { output: { summary: "synthetic" }, warnings: [] },
  );

  assert.deepEqual(calls, [
    { method: "seedConversationContext", exchanges: contextExchanges, operationId: "seed-seg-1" },
    { method: "authorizeVoiceResponse", input: { sessionId: 41n, segmentId: "seg-1", contextExchanges } },
    { method: "skipVoiceResponse", input: { sessionId: 41n, segmentId: "seg-2", reason: "no_alias_match" } },
    { method: "finalizeRecording", input: { sessionId: 41n } },
    { method: "reconcileRecording", input: { sessionId: 41n, recordingHandle: recording.recordingHandle } },
    {
      method: "processText",
      input: {
        sessionId: 41n,
        instructions: "Return a compact JSON summary.",
        input: "The launch moved to October.",
        outputSchema: { type: "object" },
        maxOutputBytes: 1024,
      },
    },
  ]);
});
