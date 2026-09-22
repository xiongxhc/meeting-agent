// Scripted bridge-side media client for the packaged Runtime gateway's
// authenticated media listener (MED2 timed capture, capture-clock/v1).
// Wire layout mirrors apps/runtime-gateway/src/media_server.rs read paths.
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import process from "node:process";
import net from "node:net";

const MAX_TOKEN_BYTES = 128;

function putId(value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length === 0 || bytes.length > 64) throw new Error("capture identifier out of bounds");
  return Buffer.concat([Buffer.from([bytes.length]), bytes]);
}
function u64(value) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(value)); return b; }
function i64(value) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(value)); return b; }
function u32(value) { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; }

/** FrameProvenance::encode, 88 bytes. Quality 1 requires the nominal span. */
export function encodeTiming({ captureEpoch, sequence, outputStartSample, sampleCount, sourceRateHz, hostStartNs, hostEndNs, roundingEnvelopeNs }) {
  const bytes = Buffer.alloc(88);
  bytes[0] = 1; bytes[1] = 1; bytes[2] = 1; bytes[3] = 0;
  bytes.writeBigUInt64BE(BigInt(captureEpoch), 4);
  bytes.writeBigUInt64BE(BigInt(sequence), 12);
  bytes.writeBigUInt64BE(BigInt(outputStartSample), 20);
  bytes.writeUInt32BE(sampleCount, 28);
  bytes.writeBigUInt64BE(BigInt(outputStartSample) * BigInt(sourceRateHz), 32);
  bytes.writeBigUInt64BE((BigInt(outputStartSample) + BigInt(sampleCount)) * BigInt(sourceRateHz), 40);
  bytes.writeUInt32BE(sourceRateHz, 48);
  bytes.writeUInt32BE(sourceRateHz, 52);
  bytes.writeBigUInt64BE(BigInt(hostStartNs), 56);
  bytes.writeBigUInt64BE(BigInt(hostEndNs), 64);
  bytes.writeBigUInt64BE(BigInt(roundingEnvelopeNs), 72);
  return bytes;
}

function record(kind, sessionId, body) {
  const payload = Buffer.concat([u64(sessionId), body]);
  return Buffer.concat([Buffer.from("MED2"), Buffer.from([2, kind]), u32(payload.length), payload]);
}

export async function connectMediaClient({ endpoint, credential, sessionId, bridgeSessionId, clockDomainId = "e2e-clock", captureEpoch = 1 }) {
  const url = new URL(endpoint);
  if (url.protocol !== "tcp:") throw new Error(`unsupported media endpoint ${url.protocol}`);
  const socket = net.connect({ host: url.hostname, port: Number(url.port) });
  socket.setNoDelay(true);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve); socket.once("error", reject);
  });
  const token = Buffer.from(credential, "utf8");
  if (token.length === 0 || token.length > MAX_TOKEN_BYTES) throw new Error("media credential out of bounds");
  const id = Buffer.from(bridgeSessionId, "utf8");
  const body = Buffer.concat([u64(sessionId), Buffer.from([token.length]), token, Buffer.from([id.length]), id]);
  socket.write(Buffer.concat([Buffer.from("MED2"), Buffer.from([2, 1]), u32(body.length), body]));

  const inbound = { bytes: 0, packets: 0 };
  socket.on("data", (chunk) => { inbound.bytes += chunk.length; inbound.packets += 1; });
  let closedReason = null;
  socket.on("close", () => { closedReason ??= "closed"; });
  socket.on("error", (error) => { closedReason = error.message; });

  const write = (buffer) => new Promise((resolve, reject) => socket.write(buffer, (error) => error ? reject(error) : resolve()));
  let sequence = 0, outputStartSample = 0;
  const started = process.hrtime.bigint();

  return {
    socket, inbound,
    get closedReason() { return closedReason; },
    async sendEpoch() {
      await write(record(6, sessionId, Buffer.concat([putId(bridgeSessionId), putId(clockDomainId), u64(captureEpoch), Buffer.from([1])])));
    },
    async sendClockPair({ sequence: pairSequence = 1 } = {}) {
      const before = process.hrtime.bigint();
      const unixNs = BigInt(Date.now()) * 1_000_000n;
      const after = before + 1000n;
      await write(record(7, sessionId, Buffer.concat([
        putId(clockDomainId), u64(1), u64(pairSequence), u64(before), i64(unixNs), u64(after), u64(1000),
        Buffer.from([0]), u64(0),
      ])));
    },
    /** One 20 ms silent pcm_s16le/24000/1 frame. */
    async sendSilentFrame(sampleCount = 480, sampleRateHz = 24_000) {
      sequence += 1;
      const payload = Buffer.alloc(sampleCount * 2);
      const hostStartNs = started + BigInt(sequence) * 20_000_000n;
      const timing = encodeTiming({ captureEpoch, sequence, outputStartSample, sampleCount, sourceRateHz: sampleRateHz,
        hostStartNs, hostEndNs: hostStartNs + 20_000_000n, roundingEnvelopeNs: 1000 });
      outputStartSample += sampleCount;
      const body = Buffer.concat([Buffer.from([1]), u32(sampleRateHz), Buffer.from([0, 1]), timing, u32(payload.length), payload]);
      await write(record(2, sessionId, body));
      return sequence;
    },
    close() { return new Promise((resolve) => { socket.end(() => resolve()); socket.destroy(); }); },
  };
}
