import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { Duplex } from "node:stream";
import process from "node:process";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
// @ts-expect-error Test-only connected peer has no public declaration.
import * as media from "./media-client.mjs";

// Byte-speaking synthetic transport. No listener, SDK or Runtime is executed.
export class BytePeer extends Duplex {
  writes: Buffer[] = [];
  held: Array<(error?: Error | null) => void> = [];
  holdKind: number | null = null;
  respond: ((packet: Buffer) => void) | null = null;
  _read() {}
  _write(bytes: Buffer, _encoding: string, done: (error?: Error | null) => void) {
    const packet = Buffer.from(bytes); this.writes.push(packet);
    this.respond?.(packet);
    if (packet[5] === this.holdKind) this.held.push(done); else done();
  }
  receive(bytes: Buffer) { this.push(bytes); }
}
export function auth(session = 41n, bridge = "synthetic-bridge") {
  const id = Buffer.from(bridge), bytes = Buffer.alloc(19 + id.length);
  bytes.write("MED3"); bytes[4] = 3; bytes[5] = 9; bytes.writeUInt32BE(9 + id.length, 6);
  bytes.writeBigUInt64BE(session, 10); bytes[18] = id.length; id.copy(bytes, 19);
  return bytes;
}
export const POSITIVE = Buffer.from("4d454433030a000000290000000000000029000000000000000201000000000000000700000000000003c00000000000000003", "hex");
export const ZERO = Buffer.from("4d454433030a000000290000000000000029000000000000000200000000000000000000000000000000000000000000000003", "hex");
export function ack(packet: Buffer) { const bytes = Buffer.from(packet); bytes[5] = 11; return bytes; }
export function connected(options: Record<string, unknown> = {}) {
  assert.equal(typeof media.createConnectedMediaClient, "function", "connected-stream core must authenticate and finish capture");
  const socket = new BytePeer();
  const client = media.createConnectedMediaClient({ socket, credential: "synthetic", sessionId: 41n,
    bridgeSessionId: "synthetic-bridge", captureEpoch: 2n, authTimeoutMs: 1000, ...options });
  return { socket, client };
}
export async function admitted(options: Record<string, unknown> = {}) {
  const peer = connected(options); peer.socket.receive(auth()); await peer.client.ready; return peer;
}
const kinds = (peer: BytePeer) => peer.writes.map(packet => packet[5]);

test("synthetic peer cannot admit capture from an auth write callback or incomplete auth", async () => {
  const { socket, client } = connected();
  let ready = false; void client.ready.then(() => { ready = true; });
  await setImmediate(); assert.equal(ready, false);
  socket.receive(auth().subarray(0, -1)); await setImmediate(); assert.equal(ready, false);
  socket.receive(auth().subarray(-1)); await client.ready;
  await client.sendEpoch(); socket.respond = packet => { if (packet[5] === 10) socket.receive(ack(packet)); }; await client.close();
});

test("literal shipped nonempty finish vector derives from committed FIFO writes and waits for exact ACK bytes", async () => {
  const { socket, client } = await admitted();
  await client.sendEpoch(); await client.sendClockPair({ sequence: 2n });
  for (let i = 0; i < 7; i++) await client.sendSilentFrame(i === 6 ? 192 : 128);
  const finish = client.finishCapture({ timeoutMs: 1000 });
  let finished = false; void finish.then(() => { finished = true; });
  await setImmediate();
  assert.deepEqual(socket.writes.at(-1), POSITIVE); assert.equal(POSITIVE.length, 51);
  socket.receive(ack(POSITIVE).subarray(0, 50)); await setImmediate(); assert.equal(finished, false);
  socket.receive(ack(POSITIVE).subarray(50));
  assert.deepEqual(await finish, { drain: "confirmed", reason: null, boundary: {
    captureEpoch: "2", lastFrameSequence: "7", outputEndSample: "960", finalClockPairSequence: "3" } });
  assert.deepEqual(kinds(socket), [1, 6, 7, 2, 2, 2, 2, 2, 2, 2, 7, 10]);
});

test("zero-frame finish has a real epoch/final pair and literal zero-frame boundary", async () => {
  const { socket, client } = await admitted(); await client.sendEpoch(); await client.sendClockPair({ sequence: 2n });
  socket.respond = packet => { if (packet[5] === 10) socket.receive(ack(packet)); };
  assert.equal((await client.finishCapture()).drain, "confirmed"); assert.deepEqual(socket.writes.at(-1), ZERO);
});

test("each ACK split and u64 binding is decoded without rounding or prefix completion", async () => {
  for (const split of [1, 4, 5, 6, 9, 10, 18, 26, 27, 35, 43, 50]) {
    const { socket, client } = await admitted({ captureEpoch: 9007199254740993n });
    await client.sendEpoch();
    const finish = client.finishCapture({ timeoutMs: 200 }); await setImmediate();
    const packet = socket.writes.at(-1)!;
    assert.equal(packet.readBigUInt64BE(18), 9007199254740993n);
    let done = false; void finish.then(() => { done = true; });
    socket.receive(ack(packet).subarray(0, split)); await setImmediate(); assert.equal(done, false);
    socket.receive(ack(packet).subarray(split));
    assert.equal((await finish).boundary.captureEpoch, "9007199254740993");
  }
});

test("final frame and final pair callbacks fence kind10; concurrent stop shares exactly one promise", async () => {
  const { socket, client } = await admitted(); await client.sendEpoch();
  socket.holdKind = 2;
  const frame1 = client.sendSilentFrame(), frame2 = client.sendSilentFrame();
  const finish = client.finishCapture({ timeoutMs: 200 });
  assert.equal(client.finishCapture(), finish); await assert.rejects(client.sendSilentFrame(), /admission closed/);
  await assert.rejects(client.sendClockPair(), /admission closed/);
  await setImmediate(); assert.equal(kinds(socket).includes(10), false);
  socket.held.shift()!(); await frame1; await setImmediate();
  assert.deepEqual(client.capturePosition, { captureEpoch: "2", sequence: "1", outputEndSample: "480" });
  socket.holdKind = 7; socket.held.shift()!(); await frame2; await setImmediate();
  assert.equal(kinds(socket).includes(10), false);
  socket.respond = packet => { if (packet[5] === 10) socket.receive(ack(packet)); };
  socket.held.shift()!();
  assert.equal((await finish).boundary.lastFrameSequence, "2");
  assert.equal(kinds(socket).filter(kind => kind === 10).length, 1);
});

test("authentication rejects mixed versions, lengths, identities and duplicate auth", async () => {
  const cases = [
    (p: Buffer) => { p.write("MED1"); p[4] = 1; },
    (p: Buffer) => { p[5] = 11; },
    (p: Buffer) => { p.writeUInt32BE(0xffffffff, 6); },
    (p: Buffer) => { p[18] = 64; },
    (p: Buffer) => { p.writeBigUInt64BE(42n, 10); },
    (p: Buffer) => { p[p.length - 1] = 0; },
  ];
  for (const mutate of cases) {
    const { socket, client } = connected(); const p = auth(); mutate(p); socket.receive(p);
    await assert.rejects(client.ready, /media_/); assert.equal(socket.destroyed, true);
  }
  const { socket, client } = connected(); socket.receive(Buffer.concat([auth(), auth()]));
  await assert.rejects(client.ready, /media_protocol_invalid/);
});

test("ACK malformed fields, wrong exact boundary and duplicate/suffix batches are unconfirmed", async () => {
  for (const mutate of [
    (p: Buffer) => { p[4] = 2; }, (p: Buffer) => { p[5] = 10; },
    (p: Buffer) => { p.writeUInt32BE(40, 6); }, (p: Buffer) => { p[26] = 2; },
    (p: Buffer) => { p[26] = 1; },
    ...[10, 18, 27, 35, 43].map(offset => (p: Buffer) => { p.writeBigUInt64BE(99n, offset); }),
    (p: Buffer) => Buffer.concat([p, p]), (p: Buffer) => Buffer.concat([p, Buffer.from([0])]),
  ]) {
    const { socket, client } = await admitted(); await client.sendEpoch();
    socket.respond = packet => { if (packet[5] === 10) { const p = ack(packet); socket.receive(mutate(p) ?? p); } };
    const result = await client.finishCapture({ timeoutMs: 200 });
    assert.equal(result.drain, "unconfirmed"); assert.equal(result.boundary, null); assert.equal(socket.destroyed, true);
  }
});

test("whole-chain deadline owns stalled frame/final pair/finish/ACK and cannot be promoted by late callbacks", async () => {
  for (const kind of [2, 7, 10, null]) {
    const { socket, client } = await admitted(); await client.sendEpoch(); socket.holdKind = kind;
    const frame = kind === 2 ? client.sendSilentFrame() : Promise.resolve(); void frame.catch(() => {});
    const finish = client.finishCapture({ timeoutMs: 15 });
    const result = await finish;
    assert.equal(result.drain, "unconfirmed"); assert.equal(result.reason, "capture_finish_timeout");
    assert.equal(socket.destroyed, true);
    for (const callback of socket.held) callback();
    await frame.catch(() => {}); await setImmediate();
    assert.equal(client.capturePosition.sequence, "0");
    assert.equal(client.finishCapture(), finish);
    assert.deepEqual(await finish, result);
    if (kind === 2 || kind === 7) assert.equal(kinds(socket).includes(10), false);
  }
});

test("failed capture/final pair/finish writes and partial EOF settle one unconfirmed result", async () => {
  for (const kind of [2, 7, 10]) {
    const { socket, client } = await admitted(); await client.sendEpoch(); socket.holdKind = kind;
    const frame = kind === 2 ? client.sendSilentFrame() : Promise.resolve(); void frame.catch(() => {});
    const finish = client.finishCapture({ timeoutMs: 200 }); await setImmediate();
    socket.held.shift()!(new Error("synthetic write fault"));
    assert.equal((await finish).drain, "unconfirmed"); await frame.catch(() => {});
    if (kind !== 10) assert.equal(kinds(socket).includes(10), false);
  }
  for (const bytes of [Buffer.alloc(0), ack(ZERO).subarray(0, 50)]) {
    const { socket, client } = await admitted(); await client.sendEpoch();
    const finish = client.finishCapture({ timeoutMs: 200 }); await setImmediate();
    socket.receive(bytes); socket.push(null);
    assert.equal((await finish).drain, "unconfirmed");
  }
});

function playbackFrame(sequence = 1n, generation = 3n) {
  const frame = Buffer.alloc(68); frame.write("MED1"); frame[4] = 1; frame[5] = 2; frame[6] = 2;
  frame.writeBigUInt64BE(41n, 7); frame.writeBigUInt64BE(sequence, 15); frame.writeBigUInt64BE(2n, 23);
  frame.writeBigUInt64BE(generation, 31); frame[55] = 1; frame.writeUInt32BE(24000, 56);
  frame.writeUInt16BE(1, 60); frame.writeUInt32BE(2, 62); return frame;
}
function flush(generation = 4n) {
  const packet = Buffer.alloc(22); packet.write("MED1"); packet[4] = 1; packet[5] = 4;
  packet.writeBigUInt64BE(41n, 6); packet.writeBigUInt64BE(generation, 14); return packet;
}
test("running playback preserves Accepted/Rendered/flush ordering and finishing suppresses new/late receipts", async () => {
  let held = false; const flushes: unknown[] = [];
  const { socket, client } = await admitted({ holdPlayback: () => held, onFlush: (value: unknown) => flushes.push(value) });
  await client.sendEpoch(); socket.receive(playbackFrame().subarray(0, 65)); socket.receive(playbackFrame().subarray(65));
  await setImmediate(); await setImmediate();
  assert.deepEqual(socket.writes.filter(p => p[5] === 3).map(p => p[22]), [1, 2]);
  held = true; socket.receive(playbackFrame(2n, 4n)); await setImmediate(); socket.receive(flush());
  await setImmediate(); assert.equal(flushes.length, 1);
  assert.equal((await client.releaseRendered(2, 4)).status, "suppressed_flushed");
  socket.receive(playbackFrame(3n, 5n)); await setImmediate();
  const finish = client.finishCapture({ timeoutMs: 200 }); await setImmediate();
  const receipts = socket.writes.filter(p => p.subarray(0, 4).toString() === "MED1").length;
  socket.receive(Buffer.concat([playbackFrame(4n, 6n), flush(5n)])); await setImmediate();
  assert.equal((await client.releaseRendered(3, 5)).status, "suppressed_finishing");
  assert.equal(socket.writes.filter(p => p.subarray(0, 4).toString() === "MED1").length, receipts);
  socket.receive(ack(socket.writes.at(-1)!)); assert.equal((await finish).drain, "confirmed");
});

test("abort owns pending authentication and finishing work rather than waiting for a later deadline", async () => {
  const abort = new AbortController(), { socket, client } = connected({ signal: abort.signal });
  abort.abort(); await assert.rejects(client.ready, /media_cancelled/);
  assert.equal(socket.destroyed, true);
  const activeAbort = new AbortController(), peer = await admitted({ signal: activeAbort.signal });
  await peer.client.sendEpoch(); peer.socket.holdKind = 10;
  const finish = peer.client.finishCapture({ timeoutMs: 200 }); await setImmediate(); activeAbort.abort();
  assert.deepEqual(await finish, { drain: "unconfirmed", reason: "media_cancelled", boundary: null });
  peer.socket.held.shift()!(); assert.equal(peer.socket.destroyed, true);
});

test("authentication fragmented at each field and oversized playback/auth IDs fail incrementally", async () => {
  for (const split of [1, 4, 5, 6, 9, 10, 18, 19, auth().length - 1]) {
    const { socket, client } = connected(); const finishReady = client.ready; let ready = false;
    void finishReady.then(() => { ready = true; }); socket.receive(auth().subarray(0, split)); await setImmediate(); assert.equal(ready, false);
    socket.receive(auth().subarray(split)); await finishReady; socket.destroy();
  }
  const invalid = connected(); const header = auth().subarray(0, 19); header[18] = 0;
  invalid.socket.receive(header); await assert.rejects(invalid.client.ready, /media_protocol_invalid/);
  const { socket, client } = await admitted(); const frame = playbackFrame().subarray(0, 66); frame.writeUInt32BE(65537, 62);
  socket.receive(frame); await setImmediate(); assert.equal(socket.destroyed, true);
  assert.equal(client.closedReason, "media_protocol_invalid");
});

test("session and final pair u64 above JS safe integer remain exact on the same authenticated stream", async () => {
  const id = 9007199254740993n, { socket, client } = connected({ sessionId: id }); socket.receive(auth(id)); await client.ready;
  await client.sendEpoch(); await client.sendClockPair({ sequence: id });
  socket.respond = packet => { if (packet[5] === 10) socket.receive(ack(packet)); };
  assert.equal((await client.finishCapture()).boundary.finalClockPairSequence, "9007199254740994");
  assert.equal(socket.writes.at(-1)!.readBigUInt64BE(10), id);
});

test("MED1 flush and EOF cannot confirm finish; matching ACK plus normal FIN can", async () => {
  for (const confirm of [false, true]) {
    const { socket, client } = await admitted(); await client.sendEpoch(); const finish = client.finishCapture({ timeoutMs: 100 });
    await setImmediate(); let done = false; void finish.then(() => { done = true; });
    socket.receive(flush()); await setImmediate(); assert.equal(done, false);
    if (confirm) socket.receive(Buffer.concat([flush(), ack(socket.writes.at(-1)!), flush()]));
    socket.push(null); const result = await finish; assert.equal(result.drain, confirm ? "confirmed" : "unconfirmed");
  }
});

test("capture/finish require valid authentication and an epoch; late valid ACK preserves an earlier negative", async () => {
  const peer = connected(); await assert.rejects(peer.client.sendEpoch(), /admission closed/);
  peer.socket.receive(auth()); await peer.client.ready;
  assert.equal((await peer.client.finishCapture({ timeoutMs: 100 })).drain, "unconfirmed");
  assert.equal(kinds(peer.socket).includes(10), false);
  const { socket, client } = await admitted(); await client.sendEpoch(); socket.holdKind = 10;
  const finish = client.finishCapture({ timeoutMs: 10 }); await setImmediate(); const packet = socket.writes.at(-1)!;
  assert.equal((await finish).drain, "unconfirmed");
  socket.emit("data", ack(packet)); socket.held.shift()!(); await setImmediate();
  assert.equal((await finish).drain, "unconfirmed"); assert.equal(client.finishEvidence.acknowledgedBoundary, null);
});


for (const [field, mutate] of [
  ["direction", (packet: Buffer) => { packet[6] = 1; }],
  ["encoding", (packet: Buffer) => { packet[55] = 0; }],
  ["sample rate", (packet: Buffer) => { packet.writeUInt32BE(48000, 56); }],
  ["channels", (packet: Buffer) => { packet.writeUInt16BE(2, 60); }],
  ["odd PCM size", (packet: Buffer) => { packet.writeUInt32BE(3, 62); }],
] as const) test(`matching ACK followed by malformed MED1 ${field} stays unconfirmed without receipts`, async () => {
  const { socket, client } = await admitted(); await client.sendEpoch();
  const finish = client.finishCapture({ timeoutMs: 100 }); await setImmediate();
  const packet = Buffer.concat([playbackFrame(), Buffer.alloc(1)]); mutate(packet);
  const length = 66 + packet.readUInt32BE(62);
  socket.receive(Buffer.concat([ack(socket.writes.at(-1)!), packet.subarray(0, length)]));
  assert.deepEqual(await finish, { drain: "unconfirmed", reason: "media_protocol_invalid", boundary: null });
  assert.equal(socket.writes.some(packet => packet.subarray(0, 4).toString() === "MED1"), false);
});

test("malformed MED1 playback is refused at its full header before announced payload arrives", async () => {
  const { socket, client } = await admitted(); await client.sendEpoch();
  const finish = client.finishCapture({ timeoutMs: 100 }); await setImmediate();
  const header = playbackFrame().subarray(0, 66); header[55] = 0;
  socket.receive(Buffer.concat([ack(socket.writes.at(-1)!), header])); await setImmediate();
  assert.equal(socket.destroyed, true, "format must be refused immediately at 66 header bytes");
  assert.equal((await finish).reason, "media_protocol_invalid");
});

test("matching ACK with valid coalesced late playback and flush confirms without new receipts", async () => {
  const { socket, client } = await admitted(); await client.sendEpoch();
  const finish = client.finishCapture({ timeoutMs: 100 }); await setImmediate();
  socket.receive(Buffer.concat([ack(socket.writes.at(-1)!), playbackFrame(), flush()]));
  assert.equal((await finish).drain, "confirmed");
  assert.equal(socket.writes.some(packet => packet.subarray(0, 4).toString() === "MED1"), false);
});

// Catch a mutable selector, widened overlap, sample loss or changed finish bytes.
test("closed media timing selector rejects before connected peer effects", () => {
  assert.equal(typeof media.parseMediaTiming, "function");
  assert.equal(media.parseMediaTiming(undefined), "normal");
  for (const value of ["normal", "invalid2ns"]) assert.equal(media.parseMediaTiming(value), value);
  for (const value of [null, [], {}, 2, "invalid2NS", "tail", ""]) {
    const socket = new BytePeer();
    assert.throws(() => media.createConnectedMediaClient({ socket, credential: "synthetic", sessionId: 41n,
      bridgeSessionId: "synthetic-bridge", authTimeoutMs: 1000, mediaTiming: value }), /media timing/);
    assert.equal(socket.writes.length, 0); assert.equal(socket.listenerCount("data"), 0);
  }
});
test("actual MED3 bytes preserve 51 silent frames with only frame26 invalid by exactly 2ns", async () => {
  for (const mode of [undefined, "normal", "invalid2ns"]) {
    const options: Record<string, unknown> = { mediaTiming: mode };
    const { socket, client } = await admitted(options); options.mediaTiming = mode === "invalid2ns" ? "normal" : "invalid2ns";
    try {
      await client.sendEpoch(); await client.sendClockPair();
      for (let i = 0; i < 51; i++) { await client.sendSilentFrame(); if (i === 49) await client.sendClockPair(); }
      const frames = socket.writes.filter(p => p[5] === 2), base = frames[0]!.readBigUInt64BE(81) - 20_000_000n;
      assert.equal(frames.length, 51);
      for (let i = 0; i < 51; i++) {
        const p = frames[i]!, sample = BigInt(i * 480), host = base + BigInt(i + 1) * 20_000_000n;
        assert.equal(p.subarray(0, 4).toString(), "MED3"); assert.equal(p[4], 3);
        assert.equal(p.readBigUInt64BE(29), 2n); assert.equal(p.readBigUInt64BE(37), BigInt(i + 1));
        assert.equal(p.readBigUInt64BE(45), sample); assert.equal(p.readUInt32BE(53), 480);
        assert.equal(p.readBigUInt64BE(57), sample * 24000n); assert.equal(p.readBigUInt64BE(65), (sample + 480n) * 24000n);
        assert.equal(p.readUInt32BE(73), 24000); assert.equal(p.readUInt32BE(77), 24000);
        assert.equal(p.readBigUInt64BE(81), host - (mode === "invalid2ns" && i === 25 ? 2n : 0n));
        assert.equal(p.readBigUInt64BE(89), host + 20_000_000n); assert.equal(p.readBigUInt64BE(97), 1000n);
        assert.equal(p.readUInt32BE(113), 960); assert.deepEqual(p.subarray(117), Buffer.alloc(960));
      }
      assert.equal(frames[24]!.readBigUInt64BE(89) - frames[25]!.readBigUInt64BE(81), mode === "invalid2ns" ? 2n : 0n);
      socket.respond = packet => { if (packet[5] === 10) socket.receive(ack(packet)); };
      assert.deepEqual((await client.finishCapture()).boundary, { captureEpoch: "2", lastFrameSequence: "51", outputEndSample: "24480", finalClockPairSequence: "3" });
      assert.deepEqual(client.capturePosition, { captureEpoch: "2", sequence: "51", outputEndSample: "24480" });
    } finally { socket.destroy(); }
  }
});

// A restored final-pair branch must fail this byte-level contract.
test("selected omission retains 49 authentic PCM frames and never requests or acknowledges finish", async () => {
  const options: Record<string, unknown> = { mediaTiming: "omit-final-pair", captureEpoch: 1n };
  const { socket, client } = await admitted(options); options.mediaTiming = "normal";
  await client.sendEpoch(); await client.sendClockPair();
  for (let i = 0; i < 49; i++) await client.sendSilentFrame();
  const stop = client.finishCapture({ timeoutMs: 200 }); assert.equal(client.close(), stop);
  await assert.rejects(client.sendSilentFrame(), /admission closed/);
  assert.deepEqual(await stop, { drain: "unconfirmed", reason: "final_clock_pair_omitted", boundary: null });
  const frames = socket.writes.filter(p => p[5] === 2), base = frames[0]!.readBigUInt64BE(81);
  assert.equal(frames.length, 49); assert.equal(kinds(socket).filter(k => k === 7).length, 1);
  assert.equal(kinds(socket).includes(10), false); assert.equal(socket.destroyed, true);
  for (let i = 0; i < frames.length; i++) {
    const p = frames[i]!, start = BigInt(i * 480);
    assert.equal(p.subarray(0, 4).toString(), "MED3"); assert.equal(p[4], 3);
    assert.deepEqual([...p.subarray(25, 29)], [1, 1, 1, 0]);
    assert.equal(p.readBigUInt64BE(29), 1n); assert.equal(p.readBigUInt64BE(37), BigInt(i + 1));
    assert.equal(p.readBigUInt64BE(45), start); assert.equal(p.readUInt32BE(53), 480);
    assert.equal(p.readBigUInt64BE(57), start * 24000n); assert.equal(p.readBigUInt64BE(65), (start + 480n) * 24000n);
    assert.equal(p.readUInt32BE(73), 24000); assert.equal(p.readUInt32BE(77), 24000);
    assert.equal(p.readBigUInt64BE(81), base + BigInt(i) * 20_000_000n);
    assert.equal(p.readBigUInt64BE(89), base + BigInt(i + 1) * 20_000_000n);
    assert.equal(p.readBigUInt64BE(97), 1000n); assert.equal(p.readUInt32BE(113), 960);
    assert.deepEqual(p.subarray(117), Buffer.alloc(960));
  }
  assert.deepEqual(client.finishEvidence, { sessionId: "41", bridgeSessionId: "synthetic-bridge", authenticated: true,
    requestedBoundary: null, acknowledgedBoundary: null, capturePosition: { captureEpoch: "1", sequence: "49", outputEndSample: "23520" } });
  socket.emit("data", ack(POSITIVE)); socket.emit("end");
  assert.deepEqual(await client.close(), { drain: "unconfirmed", reason: "final_clock_pair_omitted", boundary: null });
});
test("normal 49-frame byte control still emits final pair and requires exact synthetic ACK", async () => {
  const { socket, client } = await admitted({ captureEpoch: 1n }); await client.sendEpoch(); await client.sendClockPair();
  for (let i = 0; i < 49; i++) await client.sendSilentFrame();
  const stop = client.finishCapture({ timeoutMs: 200 }); await setImmediate();
  assert.equal(kinds(socket).filter(k => k === 7).length, 2);
  assert.equal(socket.writes.at(-1)![5], 10); socket.receive(ack(socket.writes.at(-1)!));
  assert.deepEqual(await stop, { drain: "confirmed", reason: null, boundary: { captureEpoch: "1", lastFrameSequence: "49",
    outputEndSample: "23520", finalClockPairSequence: "2" } });
});
test("omission fences pending writes and capture work with original deadline and primary failure", async () => {
  for (const fault of ["write", "deadline", "capture", "transport", "epoch"] as const) {
    const { socket, client } = await admitted({ mediaTiming: "omit-final-pair" });
    if (fault !== "epoch") { await client.sendEpoch(); await client.sendClockPair(); }
    if (["write", "deadline"].includes(fault)) socket.holdKind = 2;
    const frame = ["write", "deadline"].includes(fault) ? client.sendSilentFrame() : Promise.resolve(); void frame.catch(() => {});
    const work = fault === "capture" ? Promise.reject(new Error("synthetic capture failure")) : Promise.resolve();
    if (fault === "transport") socket.emit("error", new Error("synthetic transport failure"));
    const stop = client.finishCapture({ timeoutMs: 20, captureWork: work }); await setImmediate();
    if (fault === "write") socket.held.shift()!(new Error("synthetic write failure"));
    const result = await stop;
    assert.equal(result.reason, ({ write: "media_write_failed", deadline: "capture_finish_timeout", capture: "capture_finish_failed",
      transport: "media_transport_error", epoch: "capture_epoch_missing" } as const)[fault]);
    assert.equal(result.drain, "unconfirmed"); assert.equal(result.boundary, null);
    assert.equal(kinds(socket).includes(10), false);
    for (const callback of socket.held) callback(); await frame.catch(() => {});
    assert.equal(client.finishCapture(), stop); assert.deepEqual(await stop, result);
  }
  const { socket, client } = await admitted({ mediaTiming: "omit-final-pair" }); await client.sendEpoch(); await client.sendClockPair();
  const stop = client.finishCapture({ timeoutMs: 10, captureWork: new Promise(() => {}) });
  assert.equal((await stop).reason, "capture_finish_timeout"); assert.equal(kinds(socket).filter(k => k === 7).length, 1);
});
test("child media selection rejects incompatible fixed counts before connected effects", () => {
  assert.equal(typeof media.parseCaptureMediaTiming, "function");
  assert.equal(media.parseCaptureMediaTiming({ mediaTiming: "omit-final-pair", captureFrameLimit: 49 }), "omit-final-pair");
  assert.equal(media.parseCaptureMediaTiming({ mediaTiming: "invalid2ns", captureFrameLimit: 51 }), "invalid2ns");
  assert.equal(media.parseCaptureMediaTiming({ captureFrameLimit: 3000 }), "normal");
  for (const mediaTiming of ["invalid2ns", "omit-final-pair"]) for (const captureFrameLimit of [undefined, 0, 48, 50, 52, "49", 3000])
    assert.throws(() => media.parseCaptureMediaTiming({ mediaTiming, captureFrameLimit }), /frame limit/);
});

test("omission waits for queued frame49 and capture work before selecting one unconfirmed terminal", async () => {
  const { socket, client } = await admitted({ mediaTiming: "omit-final-pair", captureEpoch: 1n });
  await client.sendEpoch(); await client.sendClockPair();
  for (let i = 0; i < 48; i++) await client.sendSilentFrame();
  socket.holdKind = 2; const last = client.sendSilentFrame();
  let settleCapture: () => void = () => {};
  const captureWork = new Promise<void>(resolve => { settleCapture = resolve; });
  const stop = client.finishCapture({ timeoutMs: 200, captureWork }); let done = false; void stop.then(() => { done = true; });
  await setImmediate(); assert.equal(done, false); assert.equal(client.capturePosition.sequence, "48");
  socket.held.shift()!(); await last; await setImmediate(); assert.equal(done, false);
  assert.deepEqual(client.capturePosition, { captureEpoch: "1", sequence: "49", outputEndSample: "23520" });
  settleCapture(); assert.deepEqual(await stop, { drain: "unconfirmed", reason: "final_clock_pair_omitted", boundary: null });
  assert.equal(kinds(socket).filter(k => k === 7).length, 1); assert.equal(kinds(socket).includes(10), false);
});

// An elapsed absolute budget wins even while synchronous work starves its timer callback.
for (const blocker of ["capture work", "FIFO write callback"]) test(`omission deadline wins after blocking ${blocker} before timer dispatch`, async () => {
  const { socket, client } = await admitted({ mediaTiming: "omit-final-pair", captureEpoch: 1n });
  await client.sendEpoch(); await client.sendClockPair();
  const block = () => { const end = process.hrtime.bigint() + 30_000_000n; while (process.hrtime.bigint() < end) { /* synthetic starvation */ } };
  let frame = Promise.resolve();
  if (blocker === "FIFO write callback") { socket.respond = packet => { if (packet[5] === 2) block(); }; frame = client.sendSilentFrame().then(() => {}); }
  const captureWork = blocker === "capture work" ? Promise.resolve().then(block) : Promise.resolve();
  const stop = client.finishCapture({ timeoutMs: 10, captureWork });
  assert.deepEqual(await stop, { drain: "unconfirmed", reason: "capture_finish_timeout", boundary: null });
  await frame; assert.equal(client.closedReason, "capture_finish_timeout");
  assert.equal(kinds(socket).filter(k => k === 7).length, 1); assert.equal(kinds(socket).includes(10), false);
});
