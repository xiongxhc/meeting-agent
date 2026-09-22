// The installed reviewed SDK owns framing, validation and credit/cancellation.
import { RuntimeClient, type RuntimeTransport, type TimedVoiceSession } from "@conversation/runtime";

import type {
  ConversationContextExchange,
  ConversationRuntimePort,
  FinalizedRecordingRuntime,
  RuntimeEvent,
} from "../ports/conversation-runtime.ts";
import type { InvocationDecisionReason, InvocationSink } from "../sessions/invocation-gate.ts";

export type ConversationRuntimeSdk = RuntimeClient<4>;

/** Explicit version negotiation; transport ownership stays with the caller. */
export async function connectPostmeetingRuntime(transport: RuntimeTransport): Promise<ConversationRuntimePort & FinalizedRecordingRuntime> {
  return createConversationRuntimeClient(await RuntimeClient.connect(transport, 4));
}

export type ConversationRuntimeClientOptions = {
  /** Receives the SDK's own timed session so an owner can call its
   * authoritative stopIfActive; the adapter never reimplements that state. */
  readonly onTimedSession?: (session: TimedVoiceSession) => void;
};

export function createConversationRuntimeClient(sdk: ConversationRuntimeSdk, options: ConversationRuntimeClientOptions = {}): ConversationRuntimePort & FinalizedRecordingRuntime {
  if (!(sdk instanceof RuntimeClient) || typeof sdk.currentSessionId !== "bigint") {
    throw new Error("Postmeeting Runtime requires an open SDK protocol version 4 client");
  }
  const listeners = new Set<(event: RuntimeEvent) => void>();
  let admitted = false;
  let closing = false;
  let pump: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  const emit = (event: RuntimeEvent) => {
    if (!closing) for (const listener of listeners) listener(event);
  };
  return {
    get currentSessionId() { return sdk.currentSessionId!; },
    async startVoiceSession(input) {
      if (input.timingContract !== "capture-clock/v1") throw new Error("Task 11 timed bridge input is required for actual Runtime live admission");
      if (closing || admitted) throw new Error("Runtime live owner is closed or already admitted");
      if (input.profile !== "online" || input.responseMode !== "external_gate") throw new Error("Meeting timed admission requires online/external_gate");
      admitted = true; // One generation per adapter, including failed starts.
      const session = await sdk.startTimedVoiceSession({ bridgeSessionId: input.bridgeSessionId, profile: "online", responseMode: "external_gate" });
      options.onTimedSession?.(session);
      if (closing) throw new Error("Runtime live owner closed during admission");
      pump = (async () => {
        try {
          for await (const event of session.events()) {
            emit({ type: "timed_voice_event", bridgeSessionId: input.bridgeSessionId, event });
          }
        } catch {
          emit({ type: "provider_unavailable", detail: "runtime_live_transport_failed" });
        }
      })();
      return { timingContract: "capture-clock/v1", bridgeSessionId: input.bridgeSessionId,
        sessionId: session.mediaLease.sessionId, mediaLease: session.mediaLease };
    },
    seedConversationContext: (exchanges, operationId) =>
      sdk.seedConversationContext(exchanges, operationId),
    authorizeVoiceResponse: (input) => sdk.authorizeVoiceResponse(input),
    skipVoiceResponse: (input) => sdk.skipVoiceResponse(input),
    processText: (input) => sdk.processText(input),
    finalizeRecording: (input) => sdk.finalizeRecording(input),
    readRecordingAlignment: (input) => sdk.readRecordingAlignment(input),
    reconcileRecording: (input) => sdk.reconcileRecording(input),
    reconcileFinalizedRecording: (input) => sdk.reconcileFinalizedRecording(input),
    subscribe: (listener: (event: RuntimeEvent) => void) => {
      if (closing) throw new Error("Runtime live owner is closed");
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      listeners.clear();
      closePromise = (async () => {
        try { await sdk.close(); } finally { await pump; }
      })();
      return closePromise;
    },
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
