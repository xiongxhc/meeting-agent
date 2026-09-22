import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setImmediate as nextTurn } from "node:timers/promises";
import { RuntimeClient, StdioGatewayTransport } from "@conversation/runtime";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import { createCoordinator } from "../src/sessions/coordinator.ts";
import { RecordingAlignmentOwner } from "../src/sessions/recording-alignment.ts";

const DEADLINE_MS = 5_000;
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("synthetic Runtime integration deadline")), DEADLINE_MS);
  })]); } finally { clearTimeout(timer); }
}
/** Media v3 reuses every media-v2 body for kinds 1, 2, 6, 7, 8 and 9 under the
 * `MED3\x03` envelope, so the immutable v2 fixtures are retagged rather than
 * re-cut: same ten-byte header layout, same body, bytes 3 and 4 only. */
function med3(bytes: Buffer): Buffer {
  bytes[3] = 0x33; bytes[4] = 3; return bytes;
}
function packet(kind: number, body: Buffer): Buffer {
  const header = Buffer.from([77, 69, 68, 51, 3, kind, 0, 0, 0, 0]); header.writeUInt32BE(body.length, 6);
  return Buffer.concat([header, body]);
}
function sourcePacket(hex: string, source: bigint): Buffer {
  const bytes = med3(Buffer.from(hex, "hex")); bytes.writeBigUInt64BE(source, 10); return bytes;
}
/** Only counts complete opaque ciphertext chunks, never decrypts or interprets
 * plaintext. Accepted 4c97 session_recording.rs documents 48-byte header/u32len. */
function encryptedChunks(filename: string): number {
  if (statSync(filename).size > 64 * 1024) throw new Error("synthetic ciphertext bound exceeded");
  const bytes = readFileSync(filename);
  if (bytes.length < 48) return 0;
  assert.equal(bytes.subarray(0, 8).toString(), "CRSREC03");
  let offset = 48, count = 0;
  while (offset + 4 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    assert.ok(length >= 16 && length <= 16 * 1024);
    if (offset + 4 + length > bytes.length) return count;
    offset += 4 + length; count++;
  }
  return count;
}

test("actual encrypted Runtime recording restarts with private authority and stages SDK pages into SQLite", { timeout: 30_000 }, async () => {
  const binary = process.env.MEETING_TEST_RUNTIME_GATEWAY;
  assert.ok(binary && path.isAbsolute(binary), "Prebuild immutable Runtime4c97 gateway and set MEETING_TEST_RUNTIME_GATEWAY; do not skip this proof");
  const root = mkdtempSync(path.join(os.tmpdir(), "meeting-authenticated-alignment-"));
  const runtimeRoot = path.join(root, "runtime"), stateRoot = path.join(root, "meeting");
  mkdirSync(runtimeRoot, { mode: 0o700 }); mkdirSync(stateRoot, { mode: 0o700 });
  mkdirSync(path.join(runtimeRoot, "models"), { mode: 0o700 });
  let unexpectedCalls = 0;
  const health = createServer((request, response) => { if (request.url !== "/health" || request.method !== "GET") unexpectedCalls++;
    response.end("{}"); });
  health.listen(0, "127.0.0.1"); await once(health, "listening");
  const address = health.address(); assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const config = path.join(runtimeRoot, "gateway.toml"), wrapper = path.join(runtimeRoot, "gateway-exec");
  const loader = path.resolve(import.meta.dirname, "fixtures/runtime-alignment-child.mjs");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const errorPath = path.join(runtimeRoot, "runtime-startup.log");
  const script = `${quote(process.execPath)} ${quote(loader)} ${quote(config)} || exit 2
IFS= read -r MEETING_TEST_RUNTIME_KEY < ${quote(path.join(runtimeRoot, "runtime-synthetic.key"))} || [ -n "$MEETING_TEST_RUNTIME_KEY" ] || exit 2
export MEETING_TEST_RUNTIME_KEY
printf '%s' "$$" > ${quote(path.join(runtimeRoot, "runtime-owned.pid"))}
exec ${quote(binary)} "$@"`;
  writeFileSync(wrapper, `#!/bin/sh\nexec /usr/bin/env -i PATH=${quote(process.env.PATH ?? "/usr/bin:/bin")} TMPDIR=${quote(runtimeRoot)} /bin/sh -c ${quote(script)} gateway-exec "$@" 2>${quote(errorPath)}\n`, { mode: 0o700 });
  writeFileSync(config, `schema_version = 3
profile = "offline"
privacy_mode = "local-only"
[language]
backend = "ollama-compatible"
execution = "local"
provider = "fixture-language"
provider_host = "fixture"
endpoint = "${endpoint}"
model = "synthetic"
thinking = false
temperature = 0.0
seed = 1
num_predict = 128
num_ctx = 1024
max_assistant_content_bytes = 65536
[persona]
mode = "direct-answer"
warmth = 50
humor = 50
teasing = 50
initiative = 50
directness = 50
intimacy = 50
verbosity = 50
follow_up_frequency = 50
[[provider_hosts]]
id = "fixture"
ownership = "external"
readiness_url = "${endpoint}/health"
startup_timeout_ms = 5000
environment = "inherit"
[voice.capture]
device = "system-default"
[voice.turn]
speech_start_ms = 200
final_silence_ms = 600
[voice.asr]
backend = "whisperkit"
execution = "local"
provider = "fixture-asr"
model_path = "${runtimeRoot}/models"
download = false
[voice.speech]
backend = "openai-compatible"
execution = "local"
provider = "fixture-speech"
provider_host = "fixture"
mode = "buffered"
endpoint = "${endpoint}/v1"
model = "fixture"
voice = "fixture"
speed = 1.0
language = "auto"
instructions = "fixture"
max_tokens = 128
repetition_penalty = 1.0
max_text_bytes = 4096
max_audio_bytes = 8388608
[voice.audio]
backend = "managed-sidecar"
execution = "local"
provider = "fixture-audio"
sidecar_executable = "/bin/sh"
max_error_bytes = 65536
[recording]
directory = "${runtimeRoot}/recordings"
key_env = "MEETING_TEST_RUNTIME_KEY"
[media]
bind = "127.0.0.1:0"
advertised_endpoint = "tcp://127.0.0.1:0"
credential_lifetime_ms = 60000
reconnect_window_ms = 10000
max_frames_per_second = 100
max_payload_bytes = 16384
max_outbound_queue_bytes = 262144
max_outbound_queue_ms = 10000
capture_format = "pcm_s16le/24000/1/20ms"
`, { mode: 0o600 });
  const clients: RuntimeClient<4>[] = [];
  const transports: StdioGatewayTransport[] = [];
  const start = async () => {
    const transport = await StdioGatewayTransport.start({ gatewayPath: wrapper, configPath: config, protocolVersion: 4 });
    transports.push(transport);
    return bounded(RuntimeClient.connect(transport, 4));
  };
  const databasePath = path.join(stateRoot, "state.db");
  let store = openSessionStore({ filename: databasePath });
  let media: ReturnType<typeof createConnection> | undefined;
  let owner: RecordingAlignmentOwner | undefined;
  let stage = "first-connect";
  let primaryFailure: unknown;
  try {
    const first = await start();
    clients.push(first); const firstId = first.currentSessionId; assert.ok(firstId);
    stage = "timed-start";
    const voice = await bounded(first.startDrainableTimedVoiceSession({ bridgeSessionId: "bridge-independent", profile: "offline", responseMode: "external_gate" }));
    const lease = voice.mediaLease, target = new URL(lease.connectEndpoint);
    stage = "media-authentication";
    media = createConnection({ host: target.hostname, port: Number(target.port) }); await bounded(once(media, "connect"));
    const source = Buffer.alloc(8); source.writeBigUInt64BE(firstId);
    const bridge = Buffer.from("bridge-independent"), credential = Buffer.from(lease.credential);
    const incoming: Buffer[] = []; let received = 0;
    media.on("data", (data: Buffer) => { received += data.length; assert.ok(received <= 4096); incoming.push(data); });
    media.write(packet(1, Buffer.concat([source, Buffer.from([credential.length]), credential, Buffer.from([bridge.length]), bridge])));
    await bounded((async () => { while (received < 37) await nextTurn(); })());
    assert.deepEqual(Buffer.concat(incoming), packet(9, Buffer.concat([source, Buffer.from([bridge.length]), bridge])));
    media.removeAllListeners("data");
    stage = "encrypted-batch";
    const metadata = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../fixtures/runtime-4c97c47/timed-capture-v1/metadata.json"), "utf8")) as Record<string, string>;
    const frame = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../fixtures/runtime-4c97c47/timed-capture-v1/frame.json"), "utf8")) as { frameHex: string };
    media.write(sourcePacket(metadata.epochPacketHex!, firstId));
    for (let sequence = 1; sequence <= 70; sequence++) {
      const pair = sourcePacket(metadata.clockPairPacketHex!, firstId), base = 10 + 8 + 1 + 14;
      const host = 900_000_000n + BigInt(sequence - 1) * 4_000_000n;
      pair.writeBigUInt64BE(BigInt(sequence), base + 8); pair.writeBigUInt64BE(host, base + 16);
      pair.writeBigInt64BE(host + 1_100_000_000n, base + 24); pair.writeBigUInt64BE(host, base + 32);
      media.write(pair);
      if (sequence === 1) media.write(sourcePacket(frame.frameHex, firstId));
    }
    // Policy + epoch +70 pairs +one frame =73 complete sealed records. Before
    // stop there are no deliberate gaps/other records that could satisfy this.
    await bounded((async () => {
      for (;;) {
        const files = readdirSync(path.join(runtimeRoot, "recordings"));
        if (files.some((file) => encryptedChunks(path.join(runtimeRoot, "recordings", file)) >= 73)) return;
        await nextTurn();
      }
    })());
    let flushBytes = Buffer.alloc(0);
    media.on("data", (chunk: Buffer) => {
      flushBytes = Buffer.concat([flushBytes, chunk]); assert.ok(flushBytes.length <= 4096);
      while (flushBytes.length >= 22) {
        const flush = Buffer.from(flushBytes.subarray(0, 22)); flushBytes = flushBytes.subarray(22);
        assert.equal(flush.subarray(0, 6).toString("hex"), "4d4544310104"); flush[5] = 5; media?.write(flush);
      }
    });
    stage = "voice-stop"; await bounded(voice.stop());
    stage = "recording-finalize";
    const finalized = await bounded(first.finalizeRecording({ sessionId: firstId }));
    const identity = buildMeetingIdentity({ providerMeetingId: "synthetic-runtime", meetingNo: "000000000", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "Synthetic", organizer: null });
    const coordinator = createCoordinator({ store, clock: { now: () => 1000 }, bridgeLeaseTtlMs: 30000, maxConcurrentSessions: 1 });
    coordinator.discover(identity); coordinator.advance(identity.occurrenceId, "joining"); coordinator.advance(identity.occurrenceId, "listening");
    store.beginReconciliationGeneration(identity.occurrenceId, "bridge-independent", 1000); store.setReconciliationRuntimeSession(identity.occurrenceId, "bridge-independent", firstId);
    coordinator.finalizeWithRecording(identity.occurrenceId, { kind: "advance", toState: "finalizing" }, {
      handle: finalized.recordingHandle, sha256: finalized.sha256, keyId: finalized.keyId, encryptedPath: finalized.encryptedPath,
      format: finalized.format, durationMs: Number(finalized.durationMs), gaps: [], runtimeGaps: [],
      recovery: { bridgeSessionId: "bridge-independent", capability: finalized.recoveryCapability },
    }, "bridge-independent");
    store.close();
    const pid = Number(readFileSync(path.join(runtimeRoot, "runtime-owned.pid"), "utf8"));
    stage = "first-close"; await bounded(first.close()); assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    media.destroy(); media = undefined;
    stage = "second-connect";
    const second = await start();
    clients.push(second); assert.notEqual(second.currentSessionId, firstId);
    store = openSessionStore({ filename: databasePath });
    const recovery = store.getRecordingRecovery(identity.occurrenceId, "bridge-independent", finalized.recordingHandle); assert.ok(recovery);
    // This rejection is actual Runtime authorization, not a fake-capability peer.
    const forged = second.readRecordingAlignment({ capability: { ...recovery.capability, authorization: "0".repeat(64) } })[Symbol.asyncIterator]();
    await assert.rejects(bounded(forged.next()));
    await assert.rejects(bounded(forged.return!()));
    owner = new RecordingAlignmentOwner({ store, runtime: second });
    stage = "authenticated-alignment"; const selected = await bounded(owner.stage(recovery));
    assert.ok(selected.pageCount >= 2); assert.equal(selected.source.sourceSessionId, firstId);
    let pairs = 0, frames = 0, after = -1;
    for (;;) {
      const page = store.readSelectedAlignmentPage(selected, after); if (!page) break;
      for (const item of page.entries) {
        if (item.kind === "clock_pair") pairs++;
        if (item.kind === "frame") { frames++; assert.equal(item.provenance?.span?.captureUncertaintyNs, null);
          assert.equal(item.provenance?.span?.hostStartNs, 1_000_000_000n); }
      }
      after = Number(page.pageIndex);
    }
    assert.equal(pairs, 70); assert.equal(frames, 1); assert.equal(unexpectedCalls, 0);
    assert.equal(process.env.MEETING_TEST_RUNTIME_KEY, undefined);
  } catch (error) {
    const diagnostic = existsSync(errorPath) && statSync(errorPath).size <= 65536 ? readFileSync(errorPath, "utf8") : "";
    const known = ["execve", "ENOENT", "EACCES", "configuration", "unknown field", "recording", "environment", "HOME", "persona", "language", "provider", "permission", "Invalid", "error", "Error"];
    const categories = known.filter((category) => diagnostic.includes(category));
    primaryFailure = new Error(`Runtime test failed at ${stage}; startupLog=${existsSync(errorPath)}, keyOwnerReached=${existsSync(path.join(runtimeRoot, "runtime-owned.pid"))}; categories: ${categories.join(",")}; ${error instanceof Error ? error.message.replace(/[0-9a-f]{32,}/gi, "[redacted]") : "unknown"}`);
  } finally {
    const cleanupFailures: unknown[] = [];
    const attempt = async (cleanup: () => unknown) => { try { await cleanup(); } catch (error) { cleanupFailures.push(error); } };
    await attempt(() => owner?.close()); await attempt(() => media?.destroy());
    for (const client of clients) await attempt(() => bounded(client.close()));
    for (const transport of transports) await attempt(() => bounded(transport.close()));
    await attempt(() => store.close()); health.closeAllConnections();
    await attempt(() => bounded(new Promise<void>((resolve) => health.close(() => resolve()))));
    if (cleanupFailures.length === 0) rmSync(root, { recursive: true, force: true });
    else primaryFailure ??= new Error("synthetic Runtime cleanup unconfirmed; private fixture retained");
  }
  if (primaryFailure) throw primaryFailure;
});
