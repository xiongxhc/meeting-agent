// Test infrastructure for test/meeting-session.test.ts. Not a *.test.ts file,
// so `npm test`'s glob does not pick it up as a suite.
//
// Two fakes and a clock. The runtime fake exists because
// `@conversation/runtime` is not built yet (see the header of
// src/ports/conversation-runtime.ts): every assertion in this task is made
// against this object, never against the SDK.
//
// Both fakes are deliberately dumb -- they record what they were asked to do
// and emit exactly what a test tells them to emit, in the order the test says.
// Nothing here retries, buffers, reorders or times out, because a fake that
// has behaviour of its own is a second implementation to debug.

import { BRIDGE_SESSION_SCHEMA } from "../../src/contracts/bridge-session-v1.ts";
import type { BridgeCommandMessage } from "../../src/ports/bridge.ts";
import type { BridgeTransport } from "../../src/ports/bridge.ts";
import type {
  ConversationRuntimePort,
  RecordingGap,
  RecordingHandle,
  RuntimeEvent,
  StartVoiceSessionInput,
  VoiceSessionHandle,
} from "../../src/ports/conversation-runtime.ts";
import type { SeededContext } from "../../src/ports/knowledge.ts";

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

export type FakeClock = {
  now(): number;
  advance(ms: number): void;
};

export function fakeClock(startMs = 1_756_800_000_000): FakeClock {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// Bridge transport fake
// ---------------------------------------------------------------------------

export type FakeBridge = BridgeTransport & {
  /** Every message the session actually handed to the transport, in order.
   * A message that failed contract validation never reaches this list. */
  readonly sent: BridgeCommandMessage[];
  /** Pushes one raw inbound message to every live subscriber. Takes `unknown`
   * on purpose: a test must be able to deliver malformed and frame-shaped
   * bytes, which is the whole point of the boundary. */
  emit(raw: unknown): void;
  /** Builds a well-formed event envelope with the next sequence number. */
  event(payload: Record<string, unknown>): Record<string, unknown>;
  /** True once every subscriber has unsubscribed. */
  subscriberCount(): number;
  /** Makes the send of the FIRST command of `type` throw. Targeted by type
   * rather than by position so a test can fail exactly the command it means
   * to -- "the disclosure could not be sent" must not become "the join could
   * not be sent" if the command order ever changes. */
  failSendOfType(type: string, error: Error): void;
};

export function fakeBridge(sessionId: string, observedAt = "2026-09-02T14:00:00Z"): FakeBridge {
  const sent: BridgeCommandMessage[] = [];
  const listeners = new Set<(raw: unknown) => void>();
  let sequence = 0;
  const failures = new Map<string, Error>();

  return {
    sent,
    async send(message: BridgeCommandMessage): Promise<void> {
      const failure = failures.get(message.type);
      if (failure !== undefined) {
        failures.delete(message.type);
        throw failure;
      }
      sent.push(message);
    },
    subscribe(listener: (raw: unknown) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(raw: unknown): void {
      for (const listener of [...listeners]) listener(raw);
    },
    event(payload: Record<string, unknown>): Record<string, unknown> {
      sequence += 1;
      return { schema: BRIDGE_SESSION_SCHEMA, sessionId, sequence, observedAt, ...payload };
    },
    subscriberCount: () => listeners.size,
    failSendOfType(type: string, error: Error): void {
      failures.set(type, error);
    },
  };
}

// ---------------------------------------------------------------------------
// Conversation Runtime fake
// ---------------------------------------------------------------------------

export type RuntimeCall =
  | { readonly method: "startVoiceSession"; readonly input: StartVoiceSessionInput }
  | { readonly method: "seedContext"; readonly context: SeededContext }
  | { readonly method: "authorizeVoiceResponse"; readonly segmentId: string }
  | { readonly method: "skipVoiceResponse"; readonly segmentId: string; readonly reason: string }
  | { readonly method: "processText"; readonly text: string }
  | { readonly method: "finalizeRecording"; readonly observedGaps: readonly RecordingGap[] }
  | { readonly method: "reconcileRecording"; readonly gaps: readonly RecordingGap[] }
  | { readonly method: "close" };

export type FakeRuntimeOptions = {
  readonly handle?: Partial<VoiceSessionHandle>;
  readonly recording?: Partial<RecordingHandle>;
  /** When set, finalizeRecording resolves with these gaps regardless of what
   * it was handed -- the "the runtime disagrees with the bridge" case. */
  readonly finalizedGaps?: readonly RecordingGap[];
  /** When set, reconcileRecording resolves with these gaps instead of echoing
   * what it was handed -- the "the runtime STILL disagrees after being asked
   * to reconcile" case, which is the only way to reach `unreconciled`. */
  readonly reconciledGaps?: readonly RecordingGap[];
  readonly startVoiceSessionError?: Error;
};

export type FakeRuntime = ConversationRuntimePort & {
  readonly calls: RuntimeCall[];
  emit(event: RuntimeEvent): void;
  subscriberCount(): number;
  callsOf(method: RuntimeCall["method"]): RuntimeCall[];
};

const DEFAULT_HANDLE: VoiceSessionHandle = {
  runtimeSessionId: "rt_sess_0000000000000001",
  profile: "online",
  responseMode: "external_gate",
  status: "ready",
  media: {
    endpoint: "udp://127.0.0.1:40001",
    sessionToken: "synthetic-media-token-not-a-secret",
    format: "pcm_s16le/48000/1/20ms",
    expiresAt: "2026-09-02T15:00:00Z",
  },
};

const DEFAULT_RECORDING: RecordingHandle = {
  handle: "rec_synthetic_0001",
  sha256: "0".repeat(64),
  durationMs: 3_600_000,
  gaps: [],
};

export function fakeRuntime(options: FakeRuntimeOptions = {}): FakeRuntime {
  const calls: RuntimeCall[] = [];
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const handle: VoiceSessionHandle = { ...DEFAULT_HANDLE, ...options.handle };

  function recordingFor(gaps: readonly RecordingGap[]): RecordingHandle {
    return { ...DEFAULT_RECORDING, ...options.recording, gaps };
  }

  return {
    calls,
    callsOf: (method) => calls.filter((call) => call.method === method),

    async startVoiceSession(input: StartVoiceSessionInput): Promise<VoiceSessionHandle> {
      calls.push({ method: "startVoiceSession", input });
      if (options.startVoiceSessionError) throw options.startVoiceSessionError;
      return handle;
    },
    async seedContext(context: SeededContext): Promise<void> {
      calls.push({ method: "seedContext", context });
    },
    async authorizeVoiceResponse(segmentId: string): Promise<void> {
      calls.push({ method: "authorizeVoiceResponse", segmentId });
    },
    async skipVoiceResponse(segmentId: string, reason: string): Promise<void> {
      calls.push({ method: "skipVoiceResponse", segmentId, reason });
    },
    async processText(text: string): Promise<void> {
      calls.push({ method: "processText", text });
    },
    async finalizeRecording(input: {
      readonly observedGaps: readonly RecordingGap[];
    }): Promise<RecordingHandle> {
      calls.push({ method: "finalizeRecording", observedGaps: input.observedGaps });
      return recordingFor(options.finalizedGaps ?? input.observedGaps);
    },
    async reconcileRecording(input: {
      readonly gaps: readonly RecordingGap[];
    }): Promise<RecordingHandle> {
      calls.push({ method: "reconcileRecording", gaps: input.gaps });
      return recordingFor(options.reconciledGaps ?? input.gaps);
    },
    subscribe(listener: (event: RuntimeEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(event: RuntimeEvent): void {
      for (const listener of [...listeners]) listener(event);
    },
    subscriberCount: () => listeners.size,
    async close(): Promise<void> {
      calls.push({ method: "close" });
    },
  };
}
