// Test-only receipt cut. Real sink completion precedes the barrier; no
// manufactured receipt, store mutation, simulated throw or retry at this seam.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { operatorWarningKey } from "../dist/src/ports/operator-warning.js";

export function createWarningReceiptBarrier({ sink, onDurableReceipt, waitForRelease }) {
  return { async accept(input) {
    const receipt = await sink.accept(input);
    await onDurableReceipt(input, receipt);
    await waitForRelease();
    return receipt;
  } };
}

export function measureWarningFile({ outboxDir, occurrenceId, stopAtMs, expiresAtMs }) {
  const payload = { schema: "meeting-operator-warning/v1", occurrenceId,
    stopAt: new Date(stopAtMs).toISOString(), expiresAt: new Date(expiresAtMs).toISOString(), reason: "backfill_stopped" };
  const name = operatorWarningKey(payload) + ".json", directory = path.join(outboxDir, "operator-warnings");
  const dir = lstatSync(directory);
  assert.ok(dir.isDirectory() && !dir.isSymbolicLink() && dir.uid === process.getuid() && (dir.mode & 0o777) === 0o700);
  assert.deepEqual(readdirSync(directory), [name], "one physical warning file and no staging duplicate required");
  const filename = path.join(directory, name), stat = lstatSync(filename, { bigint: true });
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === BigInt(process.getuid()) && (stat.mode & 0o777n) === 0o600n);
  const bytes = readFileSync(filename);
  assert.deepEqual(bytes, Buffer.from(JSON.stringify(payload) + "\n"), "warning payload bytes mismatch");
  return Object.freeze({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    device: stat.dev.toString(), inode: stat.ino.toString() });
}
