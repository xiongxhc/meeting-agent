import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import net from "node:net";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
// @ts-expect-error The test-only JavaScript peer intentionally has no public declaration.
import { connectMediaClient } from "./media-client.mjs";

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("media peer deadline");
    await setTimeout(10);
  }
}

test("fragmented MED3 authentication and MED1 playback require Accepted before Rendered; held audio flushes without rendering", async () => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const connection = once(server, "connection");
  const playback: { held: boolean; afterFlush: boolean }[] = [], flushes: unknown[] = [];
  let held = false;
  const client = await connectMediaClient({ endpoint: `tcp://127.0.0.1:${address.port}`, credential: "synthetic", sessionId: 17n,
    bridgeSessionId: "synthetic-bridge", holdPlayback: () => held,
    onPlayback: (frame: { held: boolean; afterFlush: boolean }) => playback.push(frame), onFlush: (frame: unknown) => flushes.push(frame) });
  const [socket] = await connection as [net.Socket];
  const statuses: number[] = [], flushAcks: string[] = [];
  let incoming = Buffer.alloc(0), authenticated = false;
  socket.on("data", (chunk: Buffer) => {
    incoming = Buffer.concat([incoming, chunk]);
    if (!authenticated) {
      if (incoming.length < 10 || incoming.length < 10 + incoming.readUInt32BE(6)) return;
      incoming = incoming.subarray(10 + incoming.readUInt32BE(6)); authenticated = true;
    }
    while (incoming.length >= 6) {
      const length = incoming[5] === 3 ? 23 : 22;
      if (incoming.length < length) return;
      assert.equal(incoming.subarray(0, 4).toString(), "MED1");
      assert.equal(incoming.readBigUInt64BE(6), 17n);
      if (incoming[5] === 3) statuses.push(incoming[22]!);
      else flushAcks.push(incoming.readBigUInt64BE(14).toString());
      incoming = incoming.subarray(length);
    }
  });
  try {
    const id = Buffer.from("synthetic-bridge"), auth = Buffer.alloc(19 + id.length);
    auth.write("MED3"); auth[4] = 3; auth[5] = 9; auth.writeUInt32BE(9 + id.length, 6);
    auth.writeBigUInt64BE(17n, 10); auth[18] = id.length; id.copy(auth, 19);
    socket.write(auth.subarray(0, 7)); socket.write(auth.subarray(7));
    const frame = Buffer.alloc(68);
    frame.write("MED1"); frame[4] = 1; frame[5] = 2; frame[6] = 2;
    frame.writeBigUInt64BE(17n, 7); frame.writeBigUInt64BE(1n, 15); frame.writeBigUInt64BE(2n, 23);
    frame.writeBigUInt64BE(3n, 31); frame.writeUInt32BE(2, 62);
    socket.write(frame.subarray(0, 65)); socket.write(frame.subarray(65));
    await waitFor(() => statuses.length === 2);
    assert.deepEqual(statuses, [1, 2]);
    held = true; frame.writeBigUInt64BE(2n, 15); frame.writeBigUInt64BE(4n, 31);
    socket.write(frame);
    await waitFor(() => statuses.length === 3);
    assert.deepEqual(statuses, [1, 2, 1]);
    assert.equal(playback.at(-1)?.held, true);
    const flush = Buffer.alloc(22);
    flush.write("MED1"); flush[4] = 1; flush[5] = 4;
    flush.writeBigUInt64BE(17n, 6); flush.writeBigUInt64BE(4n, 14);
    socket.write(flush);
    await waitFor(() => flushAcks.length === 1);
    assert.deepEqual(flushAcks, ["4"]);
    assert.equal(flushes.length, 1);
    assert.deepEqual(statuses, [1, 2, 1], "held generation was never rendered");
  } finally {
    await client.close(); socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
