import { Readable } from "node:stream";
import { RuntimeClient, type ClientCommand, type ClientProtocolVersion, type RuntimeTransport } from "@conversation/runtime";

/** Only transport is synthetic: the package's real client parses every reply. */
export class RuntimeTestTransport implements RuntimeTransport {
  readonly messages = new Readable({ objectMode: true, read() {} });
  readonly commands: ClientCommand[] = [];
  onSend: ((command: ClientCommand) => void) | undefined;
  async send(command: ClientCommand): Promise<void> { this.commands.push(command); this.onSend?.(command); }
  push(message: unknown): void { this.messages.push(message); }
  async close(): Promise<void> { this.messages.push(null); }
}

export async function runtimeTestClient<V extends ClientProtocolVersion>(version: V) {
  const transport = new RuntimeTestTransport();
  transport.push({ type: "ready", protocol_version: version, ...(version === 4 ? { current_session_id: "42" } : {}),
    status: { profile: "offline", transport: "stdio", privacy_mode: "local_only", language_location: "local",
      model_id: "synthetic", memory_enabled: false, memory_location: null, telemetry_enabled: false,
      capabilities: ["text", "conversation_context_seed"], components: [{ kind: "language_model", execution_location: "local", provider_label: "Synthetic" }],
      last_context_seed_operation_id: null } });
  return { client: await RuntimeClient.connect(transport, version), transport };
}

/** Parser/SQLite fixture, NOT evidence of capability authentication. */
export const testCapability = { sourceSessionId: 41n, recordingHandle: "a".repeat(32), sha256: "b".repeat(64), keyId: "c".repeat(16), authorization: "d".repeat(64) };
export const finalizedWire = { type: "recording_finalized", protocol_version: 4,
  recording: { recording_handle: testCapability.recordingHandle, encrypted_path: "/synthetic/encrypted.crsr", sha256: testCapability.sha256,
    key_id: testCapability.keyId, duration_ms: "10", format: "pcm_s16le/24000/1/20ms", gaps: [] },
  recovery_capability: { source_session_id: "41", recording_handle: testCapability.recordingHandle, sha256: testCapability.sha256,
    key_id: testCapability.keyId, authorization: testCapability.authorization } };
