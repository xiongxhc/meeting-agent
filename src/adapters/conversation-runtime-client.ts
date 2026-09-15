// The installed reviewed SDK owns framing, validation and credit/cancellation.
// This slice composes postmeeting methods only, not live voice/UI events.
import { RuntimeClient, type RuntimeTransport } from "@conversation/runtime";

import type {
  ConversationContextExchange,
  ConversationRuntimePort,
  RuntimeEvent,
} from "../ports/conversation-runtime.ts";
import type { InvocationDecisionReason, InvocationSink } from "../sessions/invocation-gate.ts";

export type ConversationRuntimeSdk = RuntimeClient<4>;

/** Explicit version negotiation; transport ownership stays with the caller. */
export async function connectPostmeetingRuntime(transport: RuntimeTransport): Promise<ConversationRuntimePort> {
  return createConversationRuntimeClient(await RuntimeClient.connect(transport, 4));
}

export function createConversationRuntimeClient(sdk: ConversationRuntimeSdk): ConversationRuntimePort {
  if (!(sdk instanceof RuntimeClient) || typeof sdk.currentSessionId !== "bigint") {
    throw new Error("Postmeeting Runtime requires an open SDK protocol version 4 client");
  }
  return {
    async startVoiceSession() {
      throw new Error("Conversation Runtime live start/events require the later Task 11 application composition");
    },
    seedConversationContext: (exchanges, operationId) =>
      sdk.seedConversationContext(exchanges, operationId),
    authorizeVoiceResponse: (input) => sdk.authorizeVoiceResponse(input),
    skipVoiceResponse: (input) => sdk.skipVoiceResponse(input),
    processText: (input) => sdk.processText(input),
    finalizeRecording: (input) => sdk.finalizeRecording(input),
    readRecordingAlignment: (input) => sdk.readRecordingAlignment(input),
    reconcileRecording: (input) => sdk.reconcileRecording(input),
    // No SDK VoiceSession event stream is available because start is
    // fail-closed above. This inert subscription is safe only in that state;
    // Task 11 replaces it with a real event bridge once it has actual session
    // construction material.
    subscribe: (listener: (event: RuntimeEvent) => void) => {
      void listener;
      return () => {};
    },
    close: () => sdk.close(),
  };
}

/** Adapts a session-aware port to the invocation gate's two-method sink. */
export function createRuntimeInvocationSink(
  runtime: Pick<ConversationRuntimePort, "authorizeVoiceResponse" | "skipVoiceResponse">,
  sessionId: bigint,
  contextExchanges: ConversationContextExchange[],
  onError: (segmentId: string, error: unknown) => void,
): InvocationSink {
  return {
    skipVoiceResponse(segmentId: string, reason: InvocationDecisionReason): void {
      runtime.skipVoiceResponse({ sessionId, segmentId, reason }).catch((error: unknown) => {
        onError(segmentId, error);
      });
    },
    authorizeVoiceResponse(segmentId: string): void {
      runtime.authorizeVoiceResponse({ sessionId, segmentId, contextExchanges }).catch((error: unknown) => {
        onError(segmentId, error);
      });
    },
  };
}
