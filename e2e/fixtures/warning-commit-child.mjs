// Reviewed leaf component fixture: existing DB and built warning worker/sink.
// No spawn/exec, sockets, Runtime, Feishu, admission or descendant operations.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import Database from "better-sqlite3";
import { openSessionStore } from "../../dist/src/adapters/sqlite-session-store.js";
import { createFilesystemOperatorWarningSink } from "../../dist/src/adapters/filesystem-operator-warning.js";
import { createBackfillWarningWorker } from "../../dist/src/delivery/backfill-worker.js";
import { createRecoveryClock, readKnownEndRecoveryState } from "../recovery-state.mjs";
import { createWarningReceiptBarrier, measureWarningFile } from "../warning-commit-cut.mjs";

function emit(value) {
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 8192 && process.send);
  return new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
}
async function main() {
  assert.equal(process.argv.length, 4); assert.equal(process.argv[2], "--plan");
  assert.ok(path.isAbsolute(process.argv[3]));
  const plan = JSON.parse(readFileSync(process.argv[3], "utf8"));
  assert.equal(process.cwd(), plan.root);
  for (const filename of [process.argv[3], plan.databasePath, plan.outboxDir])
    assert.ok(path.isAbsolute(filename) && filename.startsWith(plan.root + path.sep));
  assert.ok(["cut", "replay", "sink-failure"].includes(plan.mode));
  const check = new Database(plan.databasePath, { readonly: true, fileMustExist: true }); check.close();
  const store = openSessionStore({ filename: plan.databasePath });
  const read = () => readKnownEndRecoveryState(plan);
  const clock = createRecoveryClock(plan.mode === "replay" ? plan.claimExpiresAtMs - 1 : plan.stopAtMs);
  const checkpoints = [];
  const real = createFilesystemOperatorWarningSink({ outboxDir: plan.outboxDir, durabilityCheckpoint(step) {
    checkpoints.push(step);
    if (plan.mode === "sink-failure" && step === "file") throw new Error("component_fsync_failure");
  } });
  let hold;
  const sink = plan.mode === "replay" ? real : createWarningReceiptBarrier({ sink: real,
    async onDurableReceipt(input, receipt) {
      assert.equal(receipt.key, input.key);
      const state = read(); assert.equal(state.warning.state, "claimed"); assert.equal(state.warning.acceptedAtMs, null);
      await emit({ name: "durable_receipt_blocked", state, file: measureWarningFile(plan), checkpoints });
    }, waitForRelease() { hold = globalThis.setInterval(() => {}, 1000); return new Promise(() => {}); } });
  const worker = createBackfillWarningWorker({ store, sink, clock, random: () => 0 });
  try {
    if (plan.mode === "replay") {
      assert.equal(read().warning.claimExpiresAtMs, plan.claimExpiresAtMs);
      assert.ok(plan.claimExpiresAtMs < plan.expiresAtMs);
      const poll = await worker.pollOnce();
      const db = new Database(plan.databasePath, { readonly: true, fileMustExist: true });
      let raw;
      try { raw = db.prepare("SELECT state,accepted_at_ms AS acceptedAtMs,claim_expires_at_ms AS claimExpiresAtMs,attempt_count AS attempts,stop_at_ms AS stopAtMs,expires_at_ms AS expiresAtMs FROM backfill_warning_intents").get(); }
      finally { db.close(); }
      await emit({ name: "unexpired_claim_idle", poll, raw, checkpoints: [...checkpoints] });
      clock.advanceTo(plan.claimExpiresAtMs);
      const replay = await worker.pollOnce();
      await emit({ name: "replay_settled", poll: replay, state: read(), checkpoints,
        ...(replay.kind === "accepted" ? { file: measureWarningFile(plan), idle: await worker.pollOnce() } : {}) });
    } else {
      const poll = await worker.pollOnce();
      await emit({ name: "sink_failed", poll, state: read(), checkpoints });
    }
  } finally { globalThis.clearInterval(hold); await worker.close(); store.close(); process.disconnect(); }
}
await main().catch(async () => {
  try { await emit({ name: "fixture_failed", reason: "component_warning_fixture_failed" }); } catch { /* Static failure only. */ }
  process.exitCode = 1; if (process.connected) process.disconnect();
});
