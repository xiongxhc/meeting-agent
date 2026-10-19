import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
// @ts-expect-error Test-only harness module has no public declaration.
import { readChildState } from "./run.mjs";

// The runner reads the bridge child's state.json once after the entry exits.
// A torn file there must yield null (failing the oracles that need it), not
// crash the runner before the bundle is written.
test("post-run child state: torn reads as null, complete parses, missing is null", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "run-child-state-"));
  try {
    assert.equal(readChildState(dir), null);
    writeFileSync(path.join(dir, "state.json"), '{"capturePosition":');
    assert.equal(readChildState(dir), null);
    writeFileSync(path.join(dir, "state.json"), JSON.stringify({ framesSent: 87 }));
    assert.deepEqual(readChildState(dir), { framesSent: 87 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
