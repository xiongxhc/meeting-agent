// The installed reviewed SDK owns framing, validation and credit/cancellation.
import { RuntimeClient, type DrainableTimedVoiceSession, type RuntimeProfile, type RuntimeTransport, type TimedVoiceSession } from "@conversation/runtime";

import type {
  ConversationContextExchange,
  ConversationRuntimePort,
  FinalizedRecordingRuntime,
  RuntimeEvent,
} from "../ports/conversation-runtime.ts";
import type { InvocationDecisionReason, InvocationSink } from "../sessions/invocation-gate.ts";

export type ConversationRuntimeSdk = RuntimeClient<4>;

/** A post-meeting connection and the profile its Runtime reports for itself:
 * the profile every batch call on this connection actually runs in. */
export type PostmeetingRuntime = ConversationRuntimePort & FinalizedRecordingRuntime & {
  readonly runtimeProfile: RuntimeProfile;
};

/** Explicit version negotiation; transport ownership stays with the caller. */
export async function connectPostmeetingRuntime(transport: RuntimeTransport): Promise<PostmeetingRuntime> {
  const sdk = await RuntimeClient.connect(transport, 4);
  const port = createConversationRuntimeClient(sdk);
  let runtimeProfile: RuntimeProfile;
  try { runtimeProfile = (await sdk.status()).profile; }
  catch (error) { await port.close().catch(() => undefined); throw error; }
  return Object.assign(port, { runtimeProfile });
}

/** The renewal method a lease-renewal SDK adds (Runtime C2); absent from the pinned SDK. */
type MediaLeaseRenewingSdk = { renewMediaLease(): Promise<bigint> };

export type ConversationRuntimeClientOptions = {
  /** Receives the SDK's own timed session so an owner can call its
   * authoritative stopIfActive; the adapter never reimplements that state. */
  readonly onTimedSession?: (session: TimedVoiceSession | DrainableTimedVoiceSession) => void;
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
      // D029 §3: the live timed path is the DRAINABLE start, so the lease the
      // Runtime issues is media v3 and the producer can finish its capture.
      // There is no negotiation and no fallback to the media-v2 start: the
      // lease version this adapter reports is whatever the SDK returned.
      const session = await sdk.startDrainableTimedVoiceSession({ bridgeSessionId: input.bridgeSessionId, profile: "online", responseMode: "external_gate" });
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
    // Renewal needs an SDK that has it (today's pinned SDK does not, so no
    // probe is sent) and a gateway whose status -- the same status its ready
    // message carried -- advertises `media_lease_renewal`. Without both the
    // session does not renew; that is never treated as a media loss.
    async supportsMediaLeaseRenewal() {
      if (typeof (sdk as Partial<MediaLeaseRenewingSdk>).renewMediaLease !== "function") return false;
      const status = await sdk.status();
      return (status.capabilities as readonly string[]).includes("media_lease_renewal");
    },
    renewMediaLease(input) {
      const renew = (sdk as Partial<MediaLeaseRenewingSdk>).renewMediaLease;
      if (typeof renew !== "function") return Promise.reject(new Error("media lease renewal is not supported by this SDK"));
      if (input.sessionId !== sdk.currentSessionId) return Promise.reject(new Error("media lease renewal names a different session"));
      return renew.call(sdk);
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
