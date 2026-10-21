import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createConnection, type Socket } from "node:net";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setImmediate as nextTurn } from "node:timers/promises";
import { RuntimeClient, StdioGatewayTransport } from "@conversation/runtime";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import { createCoordinator } from "../src/sessions/coordinator.ts";
import type { CaptureDrain } from "../src/contracts/bridge-session-v1.ts";
// @ts-expect-error Test-only JavaScript setup helper has no public declaration.
import { LAUNCHER_PREFLIGHT_TIMEOUT_MS, preflightLauncher } from "../e2e/launcher-preflight.mjs";
import { pinnedRuntimeGateway } from "./lib/runtime-gateway.ts";

const DEADLINE_MS = 15_000;
// Only the overall case adds the 60s launcher assessment setup budget.
const CASE_TIMEOUT_MS = 60_000 + LAUNCHER_PREFLIGHT_TIMEOUT_MS;
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("synthetic Runtime integration deadline")), DEADLINE_MS);
    })]);
  } finally { clearTimeout(timer); }
}

/** Media v3 reuses every media-v2 body under the `MED3\x03` envelope, so the
 * immutable v2 fixtures are retagged rather than re-cut. */
function med3(bytes: Buffer): Buffer { bytes[3] = 0x33; bytes[4] = 3; return bytes; }
function packet(kind: number, body: Buffer): Buffer {
  const header = Buffer.from([77, 69, 68, 51, 3, kind, 0, 0, 0, 0]);
  header.writeUInt32BE(body.length, 6);
  return Buffer.concat([header, body]);
}
/** The MED2 envelope, which is all a pre-media-v3 producer can speak. */
function packetV2(kind: number, body: Buffer): Buffer {
  const header = Buffer.from([77, 69, 68, 50, 2, kind, 0, 0, 0, 0]);
  header.writeUInt32BE(body.length, 6);
  return Buffer.concat([header, body]);
}
function sourcePacket(hex: string, source: bigint): Buffer {
  const bytes = med3(Buffer.from(hex, "hex")); bytes.writeBigUInt64BE(source, 10); return bytes;
}
function u64(value: bigint): Buffer { const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(value); return bytes; }
/** The exact 41-byte capture-finish body, as the Runtime driver spells it. */
function finishBody(session: bigint, boundary: { captureEpoch: bigint; lastFrameSequence: bigint; outputEndSample: bigint; finalClockPairSequence: bigint }): Buffer {
  return Buffer.concat([u64(session), u64(boundary.captureEpoch), Buffer.from([boundary.lastFrameSequence === 0n ? 0 : 1]),
    u64(boundary.lastFrameSequence), u64(boundary.outputEndSample), u64(boundary.finalClockPairSequence)]);
}
function drainOf(boundary: { captureEpoch: bigint; lastFrameSequence: bigint; outputEndSample: bigint; finalClockPairSequence: bigint }): CaptureDrain {
  return { drain: "confirmed", reason: null, boundary: {
    captureEpoch: String(boundary.captureEpoch), lastFrameSequence: String(boundary.lastFrameSequence),
    outputEndSample: String(boundary.outputEndSample), finalClockPairSequence: String(boundary.finalClockPairSequence) } };
}

/** Counts complete opaque ciphertext chunks; never decrypts or interprets PCM. */
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

/**
 * The same private launcher the accepted restart proof uses: an inherited-env
 * gateway with a loopback language fixture, a local recording key, and nothing
 * else reachable.
 */
async function gateway(label: string) {
  const binary = pinnedRuntimeGateway();
  const root = mkdtempSync(path.join(os.tmpdir(), `meeting-capture-drain-${label}-`));
  const runtimeRoot = path.join(root, "runtime"), stateRoot = path.join(root, "meeting");
  mkdirSync(runtimeRoot, { mode: 0o700 }); mkdirSync(stateRoot, { mode: 0o700 });
  mkdirSync(path.join(runtimeRoot, "models"), { mode: 0o700 });
  let unexpectedCalls = 0;
  const health = createServer((request, response) => {
    if (request.url !== "/health" || request.method !== "GET") unexpectedCalls++;
    response.end("{}");
  });
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
  writeFileSync(wrapper, `#!/bin/sh\nexec /usr/bin/env -i PATH=${quote(process.env["PATH"] ?? "/usr/bin:/bin")} TMPDIR=${quote(runtimeRoot)} /bin/sh -c ${quote(script)} gateway-exec "$@" 2>${quote(errorPath)}\n`, { mode: 0o700 });
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
  try {
    preflightLauncher(wrapper, { env: {} });
  } catch (error) {
    health.closeAllConnections();
    await new Promise<void>((resolve) => health.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const transport = await StdioGatewayTransport.start({ gatewayPath: wrapper, configPath: config, protocolVersion: 4 });
  const client = await bounded(RuntimeClient.connect(transport, 4));
  /** The gateway's own refusal, so a dead child is diagnosed rather than
   * reported as a bare "stdout ended". */
  const startupLog = () => { try { return readFileSync(errorPath, "utf8"); } catch { return ""; } };
  return {
    client, runtimeRoot, stateRoot,
    recordings: () => readdirSync(path.join(runtimeRoot, "recordings"))
      .map((file) => encryptedChunks(path.join(runtimeRoot, "recordings", file))),
    assertNoProviderCalls: () => assert.equal(unexpectedCalls, 0), startupLog,
    async close() {
      await client.close().catch(() => {});
      // Keep-alive sockets from the gateway would otherwise hold the server
      // handle open and keep the test runner alive after the proof is done.
      health.closeAllConnections();
      await new Promise<void>((resolve) => health.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Reads exactly `length` bytes from the media socket, or fails on the deadline. */
function readExact(socket: Socket, length: number): Promise<Buffer> {
  return bounded(new Promise<Buffer>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      assert.ok(buffer.length <= 4096);
      if (buffer.length < length) return;
      socket.removeListener("data", onData); socket.removeListener("error", reject);
      resolve(buffer.subarray(0, length));
    };
    socket.on("data", onData); socket.once("error", reject);
  }));
}

/**
 * Drives one real media-v3 capture to a finalized Meeting recording. `finish`
 * says whether the producer sends the capture-finish record at all; everything
 * else about the shutdown is identical, because the drain is evidence and not
 * a gate on either stop or finalize.
 */
async function capture(label: string, finish: "send" | "withhold") {
  const boot = await gateway(label);
  let media: Socket | undefined;
  try {
    const sessionId = boot.client.currentSessionId; assert.ok(sessionId);
    const voice = await bounded(boot.client.startDrainableTimedVoiceSession({
      bridgeSessionId: "bridge-independent", profile: "offline", responseMode: "external_gate" }));
    const lease = voice.mediaLease;
    assert.equal(lease.mediaProtocolVersion, 3, "the drainable start issues a media-v3 lease");
    assert.equal(lease.timingContract, "capture-clock/v1");

    const target = new URL(lease.connectEndpoint);
    media = createConnection({ host: target.hostname, port: Number(target.port) });
    await bounded(once(media, "connect"));
    const source = u64(sessionId), bridge = Buffer.from("bridge-independent"), credential = Buffer.from(lease.credential);
    const confirmation = readExact(media, 10 + 8 + 1 + bridge.length);
    media.write(packet(1, Buffer.concat([source, Buffer.from([credential.length]), credential, Buffer.from([bridge.length]), bridge])));
    assert.deepEqual(await confirmation, packet(9, Buffer.concat([source, Buffer.from([bridge.length]), bridge])),
      "a MED3 producer authenticates on the v3 lease");

    const metadata = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../fixtures/runtime-4c97c47/timed-capture-v1/metadata.json"), "utf8")) as Record<string, string>;
    const frame = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../fixtures/runtime-4c97c47/timed-capture-v1/frame.json"), "utf8")) as { frameHex: string };
    media.write(sourcePacket(metadata["epochPacketHex"]!, sessionId));
    const PAIRS = 70;
    for (let sequence = 1; sequence <= PAIRS; sequence++) {
      const pair = sourcePacket(metadata["clockPairPacketHex"]!, sessionId), base = 10 + 8 + 1 + 14;
      const host = 900_000_000n + BigInt(sequence - 1) * 4_000_000n;
      pair.writeBigUInt64BE(BigInt(sequence), base + 8); pair.writeBigUInt64BE(host, base + 16);
      pair.writeBigInt64BE(host + 1_100_000_000n, base + 24); pair.writeBigUInt64BE(host, base + 32);
      media.write(pair);
      if (sequence === 1) media.write(sourcePacket(frame.frameHex, sessionId));
    }
    // Policy + epoch + 70 pairs + one frame = 73 complete sealed records.
    await bounded((async () => { while (!boot.recordings().some((count) => count >= 73)) await nextTurn(); })());
    const chunksBeforeFinish = Math.max(...boot.recordings());

    // The boundary is read back out of the records actually delivered, so the
    // declaration is the producer's own watermark rather than a restated wish.
    const delivered = med3(Buffer.from(frame.frameHex, "hex"));
    const boundary = {
      captureEpoch: delivered.readBigUInt64BE(29),
      lastFrameSequence: delivered.readBigUInt64BE(37),
      outputEndSample: delivered.readBigUInt64BE(45) + BigInt(delivered.readUInt32BE(53)),
      finalClockPairSequence: BigInt(PAIRS),
    };

    let drain: CaptureDrain;
    if (finish === "send") {
      const body = finishBody(sessionId, boundary);
      const acknowledgement = readExact(media, 51);
      media.write(packet(10, body));
      const ack = await acknowledgement;
      assert.equal(ack.length, 51, "the acknowledgement is the 51-byte kind 11 packet");
      assert.deepEqual(ack, packet(11, body), "the recorder echoes the exact declared boundary");
      drain = drainOf(boundary);
    } else {
      // No kind 10 at all: nothing local -- an accepted stop, a completed
      // write, an intact PCM stream -- may be promoted to a confirmation.
      drain = { drain: "unconfirmed", reason: "drain_not_attempted", boundary: null };
    }

    assert.equal(await bounded(voice.stopIfActive()), "stopped");
    const finalized = await bounded(boot.client.finalizeRecording({ sessionId }));

    const store = openSessionStore({ filename: path.join(boot.stateRoot, "state.db") });
    try {
      const identity = buildMeetingIdentity({ providerMeetingId: `drain-${label}`, meetingNo: "000000000",
        occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "Synthetic", organizer: null });
      const coordinator = createCoordinator({ store, clock: { now: () => 1000 }, bridgeLeaseTtlMs: 30_000, maxConcurrentSessions: 1 });
      coordinator.discover(identity);
      coordinator.advance(identity.occurrenceId, "joining");
      coordinator.advance(identity.occurrenceId, "listening");
      store.beginReconciliationGeneration(identity.occurrenceId, "bridge-independent", 1000);
      store.setReconciliationRuntimeSession(identity.occurrenceId, "bridge-independent", sessionId);
      coordinator.finalizeWithRecording(identity.occurrenceId, { kind: "advance", toState: "finalizing" }, {
        handle: finalized.recordingHandle, sha256: finalized.sha256, keyId: finalized.keyId,
        encryptedPath: finalized.encryptedPath, format: finalized.format,
        durationMs: Number(finalized.durationMs), gaps: [], runtimeGaps: [], captureDrain: drain,
        recovery: { bridgeSessionId: "bridge-independent", capability: finalized.recoveryCapability },
      }, "bridge-independent");
      boot.assertNoProviderCalls();
      return { recording: store.getRecording(identity.occurrenceId), boundary, chunksBeforeFinish,
        chunksAfterFinalize: Math.max(...boot.recordings()) };
    } finally { store.close(); }
  } catch (error) {
    const log = boot.startupLog();
    if (log !== "") throw new Error(`${(error as Error).message}\n--- gateway startup log ---\n${log}`, { cause: error });
    throw error;
  } finally {
    media?.destroy();
    await boot.close();
  }
}

test("a confirmed media-v3 drain is persisted with the exact acknowledged boundary", { timeout: CASE_TIMEOUT_MS }, async () => {
  const result = await capture("confirmed", "send");
  assert.equal(result.recording?.captureIntegrity, "confirmed");
  assert.deepEqual(result.recording?.captureDrain, drainOf(result.boundary));
  // The recording is the Runtime's own, not an invented row: its handle and
  // digest come back from finalizeRecording, and the sealed records are there.
  assert.match(result.recording!.handle, /^[a-z0-9]{1,128}$/);
  assert.match(result.recording!.sha256, /^[0-9a-f]{64}$/);
  assert.ok(result.chunksAfterFinalize >= 73, "every delivered record is sealed");
  assert.ok(result.chunksAfterFinalize >= result.chunksBeforeFinish);
});

test("a withheld capture-finish leaves the recording intact and the drain unconfirmed", { timeout: CASE_TIMEOUT_MS }, async () => {
  const result = await capture("withheld", "withhold");
  assert.equal(result.recording?.captureIntegrity, "unconfirmed");
  assert.deepEqual(result.recording?.captureDrain, { drain: "unconfirmed", reason: "drain_not_attempted", boundary: null });
  // Recording is independent of the drain: the same ciphertext is there, the
  // same row is written, and finalization was never gated on an acknowledgement.
  assert.ok(result.chunksAfterFinalize >= 73, "the delivered PCM is intact without any drain claim");
  assert.match(result.recording!.handle, /^[a-z0-9]{1,128}$/);
  assert.match(result.recording!.sha256, /^[0-9a-f]{64}$/);
});

/**
 * The repin step-2 preflight, as an asserted invariant rather than a cited
 * finding. The composition passes the Runtime's declared media version to the
 * child unchanged and never chooses between the two, so a producer that cannot
 * speak the issued version has to fail to authenticate. If the gateway instead
 * accepted MED2 framing on a v3 lease, a stale producer would silently record
 * on a lease whose drain it can never confirm.
 */
test("a MED2 producer cannot authenticate on the v3 lease the drainable start issues", { timeout: CASE_TIMEOUT_MS }, async () => {
  const boot = await gateway("med2-refused");
  let media: Socket | undefined;
  try {
    const sessionId = boot.client.currentSessionId; assert.ok(sessionId);
    const voice = await bounded(boot.client.startDrainableTimedVoiceSession({
      bridgeSessionId: "bridge-independent", profile: "offline", responseMode: "external_gate" }));
    assert.equal(voice.mediaLease.mediaProtocolVersion, 3);

    const target = new URL(voice.mediaLease.connectEndpoint);
    media = createConnection({ host: target.hostname, port: Number(target.port) });
    await bounded(once(media, "connect"));
    let received = 0;
    media.on("data", (chunk: Buffer) => { received += chunk.length; });
    const closed = once(media, "close");

    const source = u64(sessionId), bridge = Buffer.from("bridge-independent"), credential = Buffer.from(voice.mediaLease.credential);
    media.write(packetV2(1, Buffer.concat([source, Buffer.from([credential.length]), credential, Buffer.from([bridge.length]), bridge])));

    await bounded(closed);
    assert.equal(received, 0, "no acknowledgement of any kind is written to a MED2 producer on a v3 lease");
    // The gateway refused this producer specifically; it did not fall over. A
    // dead gateway would close the socket too, and would make the assertion
    // above pass while proving nothing.
    assert.equal(await bounded(voice.stopIfActive()), "stopped");
  } finally {
    media?.destroy();
    await boot.close();
  }
});
