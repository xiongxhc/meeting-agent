import { Readable } from "node:stream";
import { RuntimeClient, type ClientCommand, type ClientProtocolVersion, type RuntimeTransport } from "@conversation/runtime";

/** Only transport is synthetic: the package's real client parses every reply. */
export class RuntimeTestTransport implements RuntimeTransport {
  readonly messages = new Readable({ objectMode: true, read() {} });
  readonly commands: ClientCommand[] = [];
  onSend: ((command: ClientCommand) => void) | undefined;
  /** When set, a `status` command is answered here (accepted, then this
   * status) and not passed to onSend, so a status probe can never hang a test. */
  statusReply: { readonly version: number; readonly status: Record<string, unknown> } | undefined;
  async send(command: ClientCommand): Promise<void> {
    this.commands.push(command);
    if (command.type === "status" && this.statusReply !== undefined) {
      this.push({ type: "command_accepted", protocol_version: this.statusReply.version, request_id: command.requestId });
      this.push({ type: "status", protocol_version: this.statusReply.version, request_id: command.requestId, status: this.statusReply.status });
      return;
    }
    this.onSend?.(command);
  }
  push(message: unknown): void { this.messages.push(message); }
  async close(): Promise<void> { this.messages.push(null); }
}

/** The gateway capabilities a test Runtime advertises unless a test names others. */
export const TEST_RUNTIME_CAPABILITIES: readonly string[] = ["text", "conversation_context_seed"];

/** A connected pinned SDK client over a fake transport. `capabilities` is what
 * the gateway's ready (and every status answer) advertises. */
export async function runtimeTestClient<V extends ClientProtocolVersion>(version: V, currentSessionId = 42n,
  options: { readonly capabilities?: readonly string[] } = {}) {
  const transport = new RuntimeTestTransport();
  const status = { profile: "offline", transport: "stdio", privacy_mode: "local_only", language_location: "local",
    model_id: "synthetic", memory_enabled: false, memory_location: null, telemetry_enabled: false,
    capabilities: [...(options.capabilities ?? TEST_RUNTIME_CAPABILITIES)], components: [{ kind: "language_model", execution_location: "local", provider_label: "Synthetic" }],
    last_context_seed_operation_id: null };
  transport.statusReply = { version, status };
  transport.push({ type: "ready", protocol_version: version, ...(version === 4 ? { current_session_id: currentSessionId.toString() } : {}), status });
  return { client: await RuntimeClient.connect(transport, version), transport };
}

/** Stands in for an SDK that has no `renewMediaLease` (one built before
 * lease renewal), whatever the pinned SDK has. */
export function withoutMediaLeaseRenewal<T extends object>(client: T): T {
  Object.defineProperty(client, "renewMediaLease", { value: undefined, configurable: true });
  return client;
}

/** Parser/SQLite fixture, NOT evidence of capability authentication. */
export const testCapability = { sourceSessionId: 41n, recordingHandle: "a".repeat(32), sha256: "b".repeat(64), keyId: "c".repeat(16), authorization: "d".repeat(64) };
export const finalizedWire = { type: "recording_finalized", protocol_version: 4,
  recording: { recording_handle: testCapability.recordingHandle, encrypted_path: "/synthetic/encrypted.crsr", sha256: testCapability.sha256,
    key_id: testCapability.keyId, duration_ms: "10", format: "pcm_s16le/24000/1/20ms", gaps: [] },
  recovery_capability: { source_session_id: "41", recording_handle: testCapability.recordingHandle, sha256: testCapability.sha256,
    key_id: testCapability.keyId, authorization: testCapability.authorization } };
