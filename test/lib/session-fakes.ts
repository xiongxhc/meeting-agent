// Deterministic bridge/runtime fakes for the Meeting Agent suites. The
// runtime fake mirrors the current SDK-shaped port; its local VoiceSession
// handle is the explicit Task 11 injection seam, never a production claim.

import { BRIDGE_SESSION_SCHEMA } from "../../src/contracts/bridge-session-v1.ts";
import type { BridgeCommandMessage, BridgeTransport } from "../../src/ports/bridge.ts";
import type {
  ConversationContextExchange,
  ConversationRuntimePort,
  ProcessTextRequest,
  RecordingGap,
  RecordingReconciliation,
  RecordingSummary,
  RuntimeEvent,
  StartVoiceSessionInput,
  VoiceSessionHandle,
} from "../../src/ports/conversation-runtime.ts";

export type FakeClock = { now(): number; advance(ms: number): void };

export function fakeClock(startMs = 1_756_800_000_000): FakeClock {
  let current = startMs;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

export type FakeBridge = BridgeTransport & {
  readonly sent: BridgeCommandMessage[];
  emit(raw: unknown): void;
  event(payload: Record<string, unknown>): Record<string, unknown>;
  subscriberCount(): number;
  failSendOfType(type: string, error: Error): void;
};

export function fakeBridge(sessionId: string, observedAt = "2026-09-02T14:00:00Z"): FakeBridge {
  const sent: BridgeCommandMessage[] = [];
  const listeners = new Set<(raw: unknown) => void>();
  const failures = new Map<string, Error>();
  let sequence = 0;
  return {
    sent,
    async send(message) {
      const failure = failures.get(message.type);
      if (failure !== undefined) {
        failures.delete(message.type);
        throw failure;
      }
      sent.push(message);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    emit(raw) { for (const listener of [...listeners]) listener(raw); },
    event(payload) {
      sequence += 1;
      return { schema: BRIDGE_SESSION_SCHEMA, sessionId, sequence, observedAt, ...payload };
    },
    subscriberCount: () => listeners.size,
    failSendOfType(type, error) { failures.set(type, error); },
  };
}

export type RuntimeCall =
  | { readonly method: "startVoiceSession"; readonly input: StartVoiceSessionInput }
  | { readonly method: "seedConversationContext"; readonly exchanges: ConversationContextExchange[]; readonly operationId: string }
  | { readonly method: "authorizeVoiceResponse"; readonly input: { sessionId: bigint; segmentId: string; contextExchanges: ConversationContextExchange[] } }
  | { readonly method: "skipVoiceResponse"; readonly input: { sessionId: bigint; segmentId: string; reason: string } }
  | { readonly method: "processText"; readonly input: ProcessTextRequest; readonly outcome: "accepted" | "refused_live_session" }
  | { readonly method: "finalizeRecording"; readonly input: { sessionId: bigint } }
  | { readonly method: "reconcileRecording"; readonly input: { sessionId: bigint; recordingHandle: string } }
  | { readonly method: "close" };

export type FakeRuntimeOptions = {
  readonly handle?: Partial<VoiceSessionHandle>;
  readonly recording?: Partial<RecordingSummary>;
  readonly finalizedGaps?: readonly RecordingGap[];
  readonly startVoiceSessionError?: Error;
  readonly reconciliation?: RecordingReconciliation;
  readonly diarizationBackend?: "online" | "local";
  readonly reconcileRecordingError?: Error;
};

export type FakeRuntime = ConversationRuntimePort & {
  readonly sessionId: bigint;
  readonly calls: RuntimeCall[];
  emit(event: RuntimeEvent): void;
  subscriberCount(): number;
  callsOf(method: RuntimeCall["method"]): RuntimeCall[];
};

const DEFAULT_HANDLE: VoiceSessionHandle = {
  sessionId: 17n,
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

const DEFAULT_RECORDING: RecordingSummary = {
  recordingHandle: "0a1b2c3d4e5f60718293a4b5c6d7e8f9",
  encryptedPath: "/synthetic-runtime/recordings/0a1b2c3d4e5f60718293a4b5c6d7e8f9.enc",
  sha256: "0".repeat(64),
  durationMs: 3_600_000n,
  format: "ogg/opus",
  keyId: "runtime-key-20260902",
  gaps: [],
};

export function fakeRuntime(options: FakeRuntimeOptions = {}): FakeRuntime {
  const calls: RuntimeCall[] = [];
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const handle: VoiceSessionHandle = { ...DEFAULT_HANDLE, ...options.handle };
  let liveVoiceSession = false;

  function recordingFor(gaps: readonly RecordingGap[]): RecordingSummary {
    return { ...DEFAULT_RECORDING, ...options.recording, gaps };
  }

  function refuseWhileLive(method: string): void {
    if (liveVoiceSession) {
      throw new Error(`${method} is refused while a voice session is live on this session (ruling R54); it is post-meeting only`);
    }
  }

  return {
    calls,
    sessionId: handle.sessionId,
    callsOf: (method) => calls.filter((call) => call.method === method),
    async startVoiceSession(input) {
      calls.push({ method: "startVoiceSession", input });
      if (options.startVoiceSessionError) throw options.startVoiceSessionError;
      liveVoiceSession = true;
      return handle;
    },
    async seedConversationContext(exchanges, operationId) {
      calls.push({ method: "seedConversationContext", exchanges, operationId });
    },
    async authorizeVoiceResponse(input) {
      calls.push({ method: "authorizeVoiceResponse", input });
      return 99n;
    },
    async skipVoiceResponse(input) {
      calls.push({ method: "skipVoiceResponse", input });
    },
    async processText(input) {
      if (liveVoiceSession) {
        calls.push({ method: "processText", input, outcome: "refused_live_session" });
        refuseWhileLive("processText");
      }
      calls.push({ method: "processText", input, outcome: "accepted" });
      return { output: null, warnings: [] };
    },
    async finalizeRecording(input) {
      calls.push({ method: "finalizeRecording", input });
      liveVoiceSession = false;
      return recordingFor(options.finalizedGaps ?? []);
    },
    async reconcileRecording(input) {
      calls.push({ method: "reconcileRecording", input });
      refuseWhileLive("reconcileRecording");
      if (options.reconcileRecordingError) throw options.reconcileRecordingError;
      const reconciliation = options.reconciliation ?? { segments: [], warnings: [] };
      if (options.diarizationBackend === "local") {
        return {
          segments: reconciliation.segments.map((segment) => ({ ...segment, text: "" })),
          warnings: reconciliation.warnings,
        };
      }
      return reconciliation;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    emit(event) { for (const listener of [...listeners]) listener(event); },
    subscriberCount: () => listeners.size,
    async close() {
      calls.push({ method: "close" });
      liveVoiceSession = false;
    },
  };
}
