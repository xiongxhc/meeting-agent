// Reads the bridge child's `<control>/state.json`. The child rewrites it in
// place on every playback, flush and capture change, so a read can land on a
// truncated document; that read is retried, about once a millisecond, until a
// monotonic deadline instead of surfacing as null. A missing file is still
// null at once, and content that stays invalid is null at the deadline.
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const pause = new Int32Array(new SharedArrayBuffer(4));

export function readStateFile(filename, { deadlineMs = 250 } = {}) {
  const deadline = performance.now() + deadlineMs;
  for (;;) {
    let text;
    try { text = readFileSync(filename, "utf8"); } catch { return null; }
    try { return JSON.parse(text); } catch { if (performance.now() >= deadline) return null; }
    Atomics.wait(pause, 0, 0, 1);
  }
}
