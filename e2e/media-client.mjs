// Scripted bridge-side media client for the packaged Runtime gateway's
// authenticated media listener (MED3 drainable timed capture, capture-clock/v1).
// D029 §3: the shipped live path starts the DRAINABLE timed session, so the
// Runtime issues a media-v3 lease and a MED2 producer cannot authenticate on
// it. As that decision prescribes for test producers, the v2 bodies below are
// unchanged and only the envelope is retagged.
// Wire layout mirrors apps/runtime-gateway/src/media_server.rs read paths.
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import process from "node:process";
import net from "node:net";
import { clearTimeout, setTimeout } from "node:timers";

const MAX_TOKEN_BYTES = 128;

export function parseMediaTiming(value) {
  if (value === undefined) return "normal";
  if (value === "normal" || value === "invalid2ns" || value === "omit-final-pair" || value === "omit-final-pair-long") return value;
  throw new Error("invalid media timing selector");
}

/** Child admission validates fixed cuts before creating any controls or peers. */
export function parseCaptureMediaTiming({ mediaTiming, captureFrameLimit }) {
  const mode = parseMediaTiming(mediaTiming);
  if (mode !== "normal" && captureFrameLimit !== (mode === "omit-final-pair" ? 49 : mode === "omit-final-pair-long" ? 99 : 51))
    throw new Error("invalid media timing frame limit");
  return mode;
}

export function writePacket(socket, bytes, onWritten = () => {}) {
  return new Promise((resolve, reject) => socket.write(bytes, (error) => {
    if (error) { reject(error); return; }
    try { onWritten(); resolve(); } catch (error) { reject(error); }
  }));
}

/** A test renderer's callback fence, not a Runtime receipt or native renderer. */
export function createPlaybackAcks(sessionId, sendAck, onCallback = () => {}, admits = () => true) {
  const frames = new Map(), flushed = new Set();
  const key = (sequence, generation) => `${generation}:${sequence}`;
  async function render(sequence, generation) {
    const frame = frames.get(key(sequence, generation));
    let status;
    if (!admits()) status = "suppressed_finishing";
    else if (!frame) status = "unknown";
    else if (flushed.has(String(generation))) status = "suppressed_flushed";
    else if (frame.rendered) status = "suppressed_duplicate";
    else {
      frame.rendered = true;
      await sendAck(3, Buffer.concat([u64(sessionId), u64(sequence), Buffer.from([2])]));
      status = "rendered";
    }
    const detail = { sequence: String(sequence), generation: String(generation), status, monotonicNs: process.hrtime.bigint().toString() };
    onCallback(detail);
    return detail;
  }
  return {
    render,
    async accept({ sequence, generation, held }) {
      if (!admits()) return;
      frames.set(key(sequence, generation), { rendered: false });
      await sendAck(3, Buffer.concat([u64(sessionId), u64(sequence), Buffer.from([1])]));
      if (!held) await render(sequence, generation);
    },
    async flush(generation, onWritten) {
      if (!admits()) return;
      flushed.add(String(generation));
      await sendAck(5, Buffer.concat([u64(sessionId), u64(generation)]), onWritten);
    },
    /** Test-only fault: fence the generation like a flush but never send its ACK. */
    withhold(generation) { if (admits()) flushed.add(String(generation)); },
    isFlushed: (generation) => flushed.has(String(generation)),
  };
}

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
  return Buffer.concat([Buffer.from("MED3"), Buffer.from([3, kind]), u32(payload.length), payload]);
}

/** The same connected-stream core used by TCP and byte-only component peers. */
export function createConnectedMediaClient({ socket, credential, sessionId, bridgeSessionId, authTimeoutMs, signal,
  clockDomainId = "e2e-clock", captureEpoch = 1n, mediaTiming, holdPlayback = () => false,
  onPlayback = () => {}, onFlush = () => {}, onRenderCallback = () => {}, withholdFlushAck = () => false, onFlushWithheld = () => {} }) {
  mediaTiming = parseMediaTiming(mediaTiming);
  sessionId = BigInt(sessionId); captureEpoch = BigInt(captureEpoch);
  u64(sessionId); u64(captureEpoch);
  if (sessionId <= 0n || captureEpoch <= 0n) throw new Error("invalid capture identity");
  const token = Buffer.from(credential, "utf8"), id = putId(bridgeSessionId);
  putId(clockDomainId);
  if (token.length === 0 || token.length > MAX_TOKEN_BYTES) throw new Error("media credential out of bounds");
  if (!Number.isFinite(authTimeoutMs) || authTimeoutMs <= 0) throw new Error("authentication deadline required");
  let phase = "authenticating", failure = null, authenticated = false, epochWritten = false;
  let sequence = 0n, outputEnd = 0n, pairSequence = 0n, pending = Buffer.alloc(0), tail = Promise.resolve();
  let longOrigin = null, firstSpan = null, lastSpan = null, longPairCount = 0;
  const longPairs = [];
  let stopPromise = null, expected = null, acknowledged = null, ackResolve, ackReject;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  void ready.catch(() => {});
  const writes = new Set(), inbound = { bytes: 0, packets: 0 };
  const capturePosition = () => ({ captureEpoch: String(captureEpoch), sequence: String(sequence), outputEndSample: String(outputEnd) });
  const boundary = () => ({ captureEpoch: String(captureEpoch), lastFrameSequence: String(sequence),
    outputEndSample: String(outputEnd), finalClockPairSequence: String(pairSequence) });
  function fail(reason) {
    if (failure !== null || phase === "terminal") return;
    failure = reason;
    readyReject(new Error(reason)); ackReject?.(new Error(reason));
    for (const reject of writes) reject(new Error(reason));
    writes.clear(); socket.destroy();
  }
  function write(bytes, onWritten = () => {}) {
    if (failure) return Promise.reject(new Error(failure));
    return new Promise((resolve, reject) => {
      let settled = false;
      const cancel = error => { if (settled) return; settled = true; writes.delete(cancel); reject(error); };
      writes.add(cancel);
      try { socket.write(bytes, error => {
        if (settled) return;
        if (error) { cancel(error); fail("media_write_failed"); return; }
        settled = true; writes.delete(cancel);
        try { onWritten(); resolve(); } catch (error) { reject(error); fail("media_write_failed"); }
      }); } catch (error) { cancel(error); fail("media_write_failed"); }
    });
  }
  function enqueue(work) {
    const result = tail.then(() => { if (failure) throw new Error(failure); return work(); });
    tail = result;
    void result.catch(() => fail("capture_write_failed"));
    return result;
  }
  function admit(work) {
    if (phase !== "running") return Promise.reject(new Error("capture admission closed"));
    return enqueue(work);
  }
  const playback = createPlaybackAcks(sessionId, (kind, body, onWritten) => enqueue(() => write(
    Buffer.concat([Buffer.from("MED1"), Buffer.from([1, kind]), body]), onWritten)), onRenderCallback, () => phase === "running" && !failure);
  const authTimer = setTimeout(() => fail("media_authentication_timeout"), authTimeoutMs);
  function clockPair(requested) {
    const next = requested === undefined ? pairSequence + 1n : BigInt(requested);
    if (next <= pairSequence || next <= 0n) throw new Error("clock pair sequence did not advance");
    const before = process.hrtime.bigint(), unixNs = BigInt(Date.now()) * 1_000_000n, after = process.hrtime.bigint();
    return write(record(7, sessionId, Buffer.concat([putId(clockDomainId), u64(1), u64(next), u64(before), i64(unixNs),
      u64(after), u64(1000), Buffer.from([0]), u64(0)])), () => {
      pairSequence = next;
      if (mediaTiming === "omit-final-pair-long") {
        longPairCount++;
        if (longPairs.length < 2) longPairs.push(Object.freeze({ sequence: next, before, after }));
      }
    });
  }
  socket.on("data", chunk => {
    if (failure || phase === "terminal") return;
    inbound.bytes += chunk.length; inbound.packets += 1;
    pending = Buffer.concat([pending, chunk]);
    try {
      while (pending.length >= 6) {
        const magic = pending.subarray(0, 4).toString(), version = pending[4], kind = pending[5];
        let length;
        if (magic === "MED3" && version === 3) {
          if (kind !== 9 && kind !== 11) throw new Error("media_protocol_invalid");
          if (kind === 9 && authenticated || kind === 11 && (!authenticated || !expected || acknowledged)) throw new Error("media_protocol_invalid");
          if (pending.length < 10) break;
          const bodyLength = pending.readUInt32BE(6);
          if (kind === 9 ? bodyLength < 10 || bodyLength > 73 : bodyLength !== 41) throw new Error("media_protocol_invalid");
          length = 10 + bodyLength;
          if (kind === 9 && pending.length >= 19 && (pending[18] < 1 || pending[18] > 64 || length !== 19 + pending[18])) throw new Error("media_protocol_invalid");
          if (pending.length < length) break;
          const packet = pending.subarray(0, length);
          if (packet.readBigUInt64BE(10) !== sessionId) throw new Error("media_binding_mismatch");
          if (kind === 9) {
            if (packet[18] < 1 || packet[18] > 64 || length !== 19 + packet[18] || !packet.subarray(18).equals(id)) throw new Error("media_binding_mismatch");
            authenticated = true; phase = "running";
          } else {
            const epoch = packet.readBigUInt64BE(18), present = packet[26], last = packet.readBigUInt64BE(27),
              end = packet.readBigUInt64BE(35), pair = packet.readBigUInt64BE(43);
            if (epoch === 0n || pair === 0n || (present !== 0 && present !== 1) ||
              (present === 0 ? last !== 0n || end !== 0n : last === 0n || end === 0n)) throw new Error("media_protocol_invalid");
            const parsed = { captureEpoch: String(epoch), lastFrameSequence: String(last), outputEndSample: String(end), finalClockPairSequence: String(pair) };
            if (JSON.stringify(parsed) !== JSON.stringify(expected)) throw new Error("capture_finish_mismatch");
            acknowledged = parsed;
          }
        } else if (magic === "MED1" && version === 1 && authenticated && (kind === 2 || kind === 4)) {
          if (kind === 2 && pending.length < 66) break;
          const size = kind === 2 ? pending.readUInt32BE(62) : 0;
          if (kind === 2 && (size === 0 || size > 65536 || size % 2 !== 0 || pending[6] !== 2 || pending[55] !== 1 ||
            pending.readUInt32BE(56) !== 24000 || pending.readUInt16BE(60) !== 1)) throw new Error("media_protocol_invalid");
          length = kind === 4 ? 22 : 66 + size;
          if (pending.length < length) break;
          const packet = pending.subarray(0, length);
          if (packet.readBigUInt64BE(kind === 2 ? 7 : 6) !== sessionId) throw new Error("media_binding_mismatch");
          if (phase === "running") {
            if (kind === 2) {
              const seq = packet.readBigUInt64BE(15), generation = packet.readBigUInt64BE(31);
              const detail = { sequence: String(seq), generation: String(generation), turn: String(packet.readBigUInt64BE(23)),
                bytes: size, held: holdPlayback(), afterFlush: playback.isFlushed(generation), at: Date.now() };
              onPlayback(detail);
              if (!detail.afterFlush) void playback.accept({ sequence: seq, generation, held: detail.held }).catch(() => fail("playback_write_failed"));
            } else {
              const generation = packet.readBigUInt64BE(14);
              if (withholdFlushAck()) {
                playback.withhold(generation);
                onFlushWithheld({ generation: String(generation), at: Date.now(), monotonicNs: process.hrtime.bigint().toString(), capturePosition: capturePosition() });
              } else void playback.flush(generation, () => onFlush({ generation: String(generation), at: Date.now(),
                monotonicNs: process.hrtime.bigint().toString(), capturePosition: capturePosition() })).catch(() => fail("playback_write_failed"));
            }
          }
        } else throw new Error("media_protocol_invalid");
        pending = pending.subarray(length);
        // Decode the complete terminal batch before confirming. Valid late
        // playback/flush packets are consumed without new receipts.
      }
      if (authenticated) { clearTimeout(authTimer); readyResolve(); }
      if (acknowledged && pending.length === 0) ackResolve?.();
    } catch (error) { fail(error.message); }
  });
  socket.on("error", () => fail("media_transport_error"));
  socket.on("end", () => { if (pending.length || !acknowledged) fail(pending.length ? "media_partial_eof" : "media_eof"); });
  const cancelled = () => fail("media_cancelled");
  signal?.addEventListener("abort", cancelled, { once: true });
  socket.on("close", () => { clearTimeout(authTimer); signal?.removeEventListener("abort", cancelled); if (!acknowledged && phase !== "terminal") fail("media_closed"); });
  if (signal?.aborted) cancelled();
  if (!failure) void write(record(1, sessionId, Buffer.concat([Buffer.from([token.length]), token, id]))).catch(() => fail("media_write_failed"));
  const started = process.hrtime.bigint();
  const client = {
    socket, inbound, ready,
    get capturePosition() { return capturePosition(); },
    get closedReason() { return failure; },
    get finishEvidence() { return { sessionId: String(sessionId), bridgeSessionId, authenticated,
      requestedBoundary: expected, acknowledgedBoundary: acknowledged, capturePosition: capturePosition() }; },
    releaseRendered: (seq, generation) => playback.render(BigInt(seq), BigInt(generation)),
    sendEpoch() { return admit(() => {
      if (epochWritten) throw new Error("capture epoch duplicated");
      return write(record(6, sessionId, Buffer.concat([id, putId(clockDomainId), u64(captureEpoch), Buffer.from([1])])), () => { epochWritten = true; });
    }); },
    sendClockPair({ sequence: requested } = {}) { return admit(() => {
      if (!epochWritten) throw new Error("capture epoch missing");
      return clockPair(requested);
    }); },
    sendSilentFrame(sampleCount = 480, sampleRateHz = 24000, voiced = false) { return admit(async () => {
      if (!epochWritten || !Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > 32768 || sampleRateHz !== 24000) throw new Error("invalid capture frame");
      if (mediaTiming === "omit-final-pair-long") {
        if (sampleCount !== 480 || longOrigin === null && (longPairCount !== 1 || longPairs[0]?.sequence !== 1n)) throw new Error("invalid capture frame");
        if (longOrigin === null) longOrigin = process.hrtime.bigint();
      }
      const next = sequence + 1n, payload = Buffer.alloc(sampleCount * 2);
      if (voiced) for (let i = 0; i < sampleCount; i++) payload.writeInt16LE(Math.round(20000 * Math.sin(i * 2 * Math.PI * 440 / sampleRateHz)), i * 2);
      const nominalStart = (longOrigin ?? started) + next * 20000000n;
      const hostStartNs = nominalStart - (mediaTiming === "invalid2ns" && next === 26n ? 2n : 0n);
      const timing = encodeTiming({ captureEpoch, sequence: next, outputStartSample: outputEnd, sampleCount, sourceRateHz: sampleRateHz,
        hostStartNs, hostEndNs: nominalStart + 20000000n, roundingEnvelopeNs: 1000 });
      await write(record(2, sessionId, Buffer.concat([Buffer.from([1]), u32(sampleRateHz), Buffer.from([0, 1]), timing, u32(payload.length), payload])),
        () => {
          sequence = next; outputEnd += BigInt(sampleCount);
          if (mediaTiming === "omit-final-pair-long") {
            const span = Object.freeze({ start: hostStartNs, end: nominalStart + 20000000n });
            firstSpan ??= span; lastSpan = span;
          }
        });
      return Number(sequence);
    }); },
    finishCapture({ timeoutMs = 20000, captureWork = Promise.resolve() } = {}) {
      if (stopPromise) return stopPromise;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 20000) throw new Error("invalid capture stop budget");
      phase = "finishing";
      const deadline = process.hrtime.bigint() + BigInt(Math.ceil(timeoutMs * 1000000));
      stopPromise = (async () => {
        const remaining = () => Number(deadline - process.hrtime.bigint()) / 1000000;
        const timer = setTimeout(() => fail("capture_finish_timeout"), Math.max(0, remaining()));
        const aborted = new Promise((_, reject) => { const cancel = error => reject(error); writes.add(cancel); });
        void aborted.catch(() => {});
        try {
          if (failure) throw new Error(failure);
          await Promise.race([Promise.all([captureWork, tail]), aborted]);
          if (failure || !authenticated || !epochWritten) throw new Error(failure ?? "capture_epoch_missing");
          if (mediaTiming === "omit-final-pair" || mediaTiming === "omit-final-pair-long") {
            let reason = "final_clock_pair_omitted";
            if (mediaTiming === "omit-final-pair-long" && !(captureEpoch === 1n && clockDomainId === "e2e-clock" &&
                sequence === 99n && outputEnd === 47520n && longPairCount === 2 &&
                longPairs[0].sequence === 1n && longPairs[1].sequence === 2n && firstSpan && lastSpan &&
                longPairs[0].before + longPairs[0].after <= 2n * firstSpan.start &&
                longPairs[1].before + longPairs[1].after >= 2n * firstSpan.end &&
                longPairs[1].before + longPairs[1].after < 2n * lastSpan.start)) reason = "long_tail_shape_unavailable";
            fail(remaining() <= 0 ? "capture_finish_timeout" : reason);
            throw new Error(failure);
          }
          await clockPair();
          expected = Object.freeze(boundary());
          const acked = new Promise((resolve, reject) => { ackResolve = resolve; ackReject = reject; });
          void acked.catch(() => {});
          await write(record(10, sessionId, Buffer.concat([u64(captureEpoch), Buffer.from([sequence > 0n ? 1 : 0]), u64(sequence), u64(outputEnd), u64(pairSequence)])));
          await acked;
          if (failure) throw new Error(failure);
          await new Promise((resolve, reject) => {
            let settled = false;
            const cancel = error => { if (settled) return; settled = true; writes.delete(cancel); reject(error); };
            writes.add(cancel);
            socket.end(error => {
              if (settled) return;
              settled = true; writes.delete(cancel);
              if (error) reject(error); else resolve();
            });
          });
          if (failure) throw new Error(failure);
          return { drain: "confirmed", reason: null, boundary: acknowledged };
        } catch (error) {
          fail(failure ?? (error.message === "capture_epoch_missing" ? error.message : "capture_finish_failed"));
          return { drain: "unconfirmed", reason: failure, boundary: null };
        } finally {
          clearTimeout(timer); clearTimeout(authTimer); signal?.removeEventListener("abort", cancelled);
          phase = "terminal"; writes.clear(); socket.destroy();
        }
      })();
      return stopPromise;
    },
    close() { return client.finishCapture(); },
  };
  return client;
}

export async function connectMediaClient(options) {
  const mediaTiming = parseMediaTiming(options.mediaTiming);
  const url = new URL(options.endpoint);
  if (url.protocol !== "tcp:") throw new Error(`unsupported media endpoint ${url.protocol}`);
  if (!Number.isFinite(options.authTimeoutMs) || options.authTimeoutMs <= 0) throw new Error("authentication deadline required");
  if (options.signal?.aborted) throw new Error("media_cancelled");
  const started = process.hrtime.bigint();
  const socket = net.connect({ host: url.hostname, port: Number(url.port) });
  socket.setNoDelay(true);
  await new Promise((resolve, reject) => {
    const complete = error => {
      clearTimeout(timer); socket.off("connect", connected); socket.off("error", failed);
      options.signal?.removeEventListener("abort", cancelled);
      if (error) { socket.destroy(); reject(error); } else resolve();
    };
    const connected = () => complete();
    const failed = error => complete(error);
    const cancelled = () => complete(new Error("media_cancelled"));
    const timer = setTimeout(() => complete(new Error("media connection timeout")), options.authTimeoutMs);
    socket.once("connect", connected); socket.once("error", failed);
    options.signal?.addEventListener("abort", cancelled, { once: true });
    if (options.signal?.aborted) cancelled();
  });
  try {
    const remaining = options.authTimeoutMs - Number(process.hrtime.bigint() - started) / 1000000;
    const client = createConnectedMediaClient({ ...options, mediaTiming, socket, authTimeoutMs: remaining });
    await client.ready;
    return client;
  } catch (error) { socket.destroy(); throw error; }
}
