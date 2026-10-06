import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
// @ts-expect-error Test-only peer has no public declaration.
import { createPlaybackAcks, writePacket } from "./media-client.mjs";

test("capture write completion updates its boundary in the actual callback before the promise resumes", async () => {
  let done: ((error?: Error | null) => void) | undefined;
  let committed = false;
  const socket = { write(_bytes: Buffer, callback: (error?: Error | null) => void) { done = callback; } };
  const pending = writePacket(socket, Buffer.alloc(0), () => { committed = true; });
  assert.equal(committed, false, "inflight bytes are not a committed boundary");
  done!();
  assert.equal(committed, true, "a later flush callback must see completed capture before microtasks");
  await pending;
  committed = false;
  const failed = writePacket(socket, Buffer.alloc(0), () => { committed = true; });
  done!(new Error("write failed"));
  await assert.rejects(failed, /write failed/);
  assert.equal(committed, false);
});

test("local render callbacks preserve Accepted order and suppress callbacks after flush or render", async () => {
  const writes: { kind: number; sequence: bigint; status: number | null }[] = [];
  const callbacks: { status: string; sequence: string; generation: string; monotonicNs: string }[] = [];
  const peer = createPlaybackAcks(17n, async (kind: number, bytes: Buffer) => {
    assert.equal(bytes.readBigUInt64BE(0), 17n);
    writes.push({ kind, sequence: bytes.readBigUInt64BE(8), status: kind === 3 ? bytes[16]! : null });
  }, (detail: typeof callbacks[number]) => callbacks.push(detail));
  await peer.accept({ sequence: 1n, generation: 3n, held: false });
  assert.deepEqual(writes.map((entry) => entry.status), [1, 2]);
  assert.equal((await peer.render(1n, 3n)).status, "suppressed_duplicate");
  await peer.accept({ sequence: 2n, generation: 4n, held: true });
  await peer.flush(4n);
  assert.equal((await peer.render(2n, 4n)).status, "suppressed_flushed");
  assert.equal((await peer.render(2n, 5n)).status, "unknown");
  assert.deepEqual(writes.map((entry) => [entry.kind, entry.sequence.toString(), entry.status]), [
    [3, "1", 1], [3, "1", 2], [3, "2", 1], [5, "4", null],
  ]);
  assert.ok(callbacks.every((entry) => /^[0-9]+$/.test(entry.monotonicNs)));
});

test("release of an accepted held generation renders once without a second Accepted wire ACK", async () => {
  const statuses: number[] = [];
  const peer = createPlaybackAcks(17n, async (kind: number, bytes: Buffer) => {
    if (kind === 3) statuses.push(bytes[16]!);
  });
  await peer.accept({ sequence: 2n, generation: 4n, held: true });
  assert.deepEqual(statuses, [1]);
  assert.equal((await peer.render(2n, 4n)).status, "rendered");
  assert.equal((await peer.render(2n, 4n)).status, "suppressed_duplicate");
  assert.deepEqual(statuses, [1, 2]);
});

test("flush snapshot is taken at its actual ACK write callback rather than a later microtask", async () => {
  let done: (() => void) | undefined;
  let completedCapture = "1", snapshot: string | null = null;
  const socket = { write(_bytes: Buffer, callback: () => void) { done = callback; } };
  const peer = createPlaybackAcks(17n, (kind: number, bytes: Buffer, onWritten?: () => void) => {
    assert.equal(kind, 5);
    return writePacket(socket, bytes, onWritten);
  });
  const pending = peer.flush(4n, () => { snapshot = completedCapture; });
  done!();
  completedCapture = "2";
  await pending;
  assert.equal(snapshot, "1");
});
