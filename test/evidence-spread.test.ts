import assert from "node:assert/strict";
import { test } from "node:test";

import { spreadEvidence } from "../src/delivery/artifact-builder.ts";

// A merged item whose windows together cite more than 100 evidence IDs keeps
// 100 of them, spread across its windows (D047). Windows are given in time
// order, each with its cited IDs in transcript order.

const ids = (window: number, count: number) => Array.from({ length: count }, (_, index) => `w${window}-${index}`);
const shape = (counts: readonly number[]) => counts.map((count, window) => ids(window + 1, count));
const keptPerWindow = (kept: readonly string[], windows: number) =>
  Array.from({ length: windows }, (_, window) => kept.filter((id) => id.startsWith(`w${window + 1}-`)).length);
const without = (window: number, count: number, dropped: readonly number[]) => ids(window, count).filter((_, index) => !dropped.includes(index));

test("17 windows of 7 IDs: 15 windows keep 6 and the last two keep 5", () => {
  const kept = spreadEvidence(shape(Array(17).fill(7)), 100);
  assert.deepEqual(kept, [
    ...Array.from({ length: 15 }, (_, window) => ["0", "1", "2", "4", "5", "6"].map((index) => `w${window + 1}-${index}`)).flat(),
    ...[16, 17].flatMap((window) => ["0", "2", "3", "4", "6"].map((index) => `w${window}-${index}`)),
  ]);
});

test("uneven windows: the small ones keep everything and the largest takes what is left", () => {
  const kept = spreadEvidence(shape([1, 2, 30, 3, 80]), 100);
  assert.deepEqual(keptPerWindow(kept, 5), [1, 2, 30, 3, 64]);
  assert.deepEqual(kept, [...ids(1, 1), ...ids(2, 2), ...ids(3, 30), ...ids(4, 3),
    ...without(5, 80, [2, 7, 12, 17, 22, 27, 32, 37, 42, 47, 52, 57, 62, 67, 72, 77])]);
});

test("one window dominating keeps all but the slots the others need", () => {
  const kept = spreadEvidence(shape([3, 100, 2, 4]), 100);
  assert.deepEqual(kept, [...ids(1, 3), ...without(2, 100, [5, 16, 27, 38, 49, 61, 72, 83, 94]), ...ids(3, 2), ...ids(4, 4)]);
});

test("exactly 100 cited IDs are all kept", () => {
  const windows = shape(Array(10).fill(10));
  assert.deepEqual(spreadEvidence(windows, 100), windows.flat());
});

test("101 cited IDs: one is dropped, from the earliest window the remainder does not reach", () => {
  // 16 windows of 6 and one of 5: the window of 5 keeps all; the other 95
  // slots give 5 to each of 16 windows and the 15 left over to the first 15.
  const kept = spreadEvidence(shape([...Array(16).fill(6), 5]), 100);
  assert.equal(kept.length, 100);
  assert.deepEqual(keptPerWindow(kept, 17), [...Array(15).fill(6), 5, 5]);
  assert.deepEqual(kept, [...shape(Array(15).fill(6)).flat(), ...without(16, 6, [2]), ...ids(17, 5)]);
});

test("42 windows of 3 IDs, the most windows that build: the first 16 keep 3, the rest keep their first and last", () => {
  const kept = spreadEvidence(shape(Array(42).fill(3)), 100);
  assert.deepEqual(keptPerWindow(kept, 42), [...Array(16).fill(3), ...Array(26).fill(2)]);
  assert.deepEqual(kept.slice(48), Array.from({ length: 26 }, (_, window) => [`w${window + 17}-0`, `w${window + 17}-2`]).flat());
});

test("more citing windows than slots cannot keep one ID from each and fails", () => {
  assert.throws(() => spreadEvidence(shape(Array(101).fill(1)), 100), /an item cited in 101 windows cannot keep an evidence segment ID from each within 100/);
  assert.equal(spreadEvidence(shape(Array(100).fill(2)), 100).length, 100);
});

test("any shape: exactly the limit kept, in order, every window at least one, shares as even as the windows allow", () => {
  let seed = 7;
  const next = (bound: number) => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return 1 + (seed % bound); };
  for (let round = 0; round < 500; round += 1) {
    const windows = shape(Array.from({ length: next(42) }, () => next(round % 2 === 0 ? 100 : 12)));
    const total = windows.flat().length, kept = spreadEvidence(windows, 100);
    assert.equal(kept.length, Math.min(100, total));
    const all = windows.flat();
    assert.deepEqual(kept, all.filter((id) => kept.includes(id)), "a subsequence of the cited IDs, in order, with no repeat");
    const slots = keptPerWindow(kept, windows.length);
    for (const [index, slot] of slots.entries()) assert.ok(slot >= 1 && slot <= windows[index]!.length);
    // Max-min fair: a window keeping fewer than it cites keeps at least as
    // many as any other window, less one, and no fewer than any later one.
    const short = slots.flatMap((slot, index) => slot < windows[index]!.length ? [index] : []);
    for (const index of short) {
      assert.ok(slots.every((other) => other <= slots[index]! + 1), `round ${round}: window ${index + 1}`);
      for (const later of short.filter((other) => other > index)) assert.ok(slots[later]! <= slots[index]!);
    }
  }
});
