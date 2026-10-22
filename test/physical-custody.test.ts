import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import type { CustodyBinding, BridgeProcessOutcome } from "../src/contracts/bridge-process-outcome-v1.ts";
const binding: CustodyBinding = { physicalClientId: "slot", physicalGenerationId: "a".repeat(32), occurrenceId: "meeting@2026-09-02T14:00:00Z", bridgeSessionId: "session" };
const outcome = (value: CustodyBinding = binding): BridgeProcessOutcome => ({ schema: "bridge-process-outcome/v1", ...value, outcome: "departure_confirmed", reason: "departure_observed", observedAt: "2026-09-02T14:01:00.000Z" });

test("migration accepts existing-valid long bindings within the exact private envelope", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "custody-long-binding-")), filename = path.join(dir, "orchestration.db");
  const long = { ...binding, occurrenceId: "会".repeat(400) + "@2026-09-02T14:00:00Z", bridgeSessionId: "话".repeat(200) };
  const store = openSessionStore({ filename });
  try { store.claimPhysicalClient(long, 1); store.recordPhysicalOutcome(long, { reaped: true, exitDiagnostic: null, outcome: outcome(long), failure: null }, 2); }
  finally { store.close(); }
  const reopened = openSessionStore({ filename });
  try { assert.equal(reopened.listPhysicalCustody()[0]?.outcome?.bridgeSessionId, long.bridgeSessionId); }
  finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("logical TTL/release and parent loss of uncommitted confirmation never clear physical custody", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "custody-logical-")), filename = path.join(dir, "orchestration.db");
  const store = openSessionStore({ filename });
  store.createSession({ occurrenceId: binding.occurrenceId, providerMeetingId: "meeting", occurrenceStartedAt: "2026-09-02T14:00:00Z", nowMs: 1 });
  store.claimPhysicalClient(binding, 1);
  const first = store.acquireLease({ occurrenceId: binding.occurrenceId, bridgeId: "bridge", bridgeSessionId: "first", nowMs: 1, ttlMs: 10 });
  const second = store.acquireLease({ occurrenceId: binding.occurrenceId, bridgeId: "bridge", bridgeSessionId: "second", nowMs: 12, ttlMs: 10 });
  assert.equal(store.listLeases(binding.occurrenceId).find((row) => row.leaseId === first.leaseId)?.releaseReason, "stale_recovered");
  store.releaseLease(binding.occurrenceId, second.leaseId, "bridge_failure", 13);
  const receivedButUncommitted = outcome();
  assert.equal(receivedButUncommitted.outcome, "departure_confirmed");
  store.close();
  const reopened = openSessionStore({ filename });
  try {
    assert.equal(reopened.listPhysicalCustody()[0]?.outcome, null);
    assert.equal(reopened.listPhysicalCustody()[0]?.state, "quarantined");
    assert.throws(() => reopened.claimPhysicalClient({ ...binding, physicalGenerationId: "b".repeat(32) }, 999_999), /physical_client_quarantined/);
  } finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("two SQLite handles retain quarantine across reopen and fence later generations", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "custody-store-")), filename = path.join(dir, "orchestration.db");
  const first = openSessionStore({ filename }), second = openSessionStore({ filename });
  try {
    first.claimPhysicalClient(binding, 1);
    assert.deepEqual(second.claimPhysicalClient(binding, 2), first.listPhysicalCustody()[0]);
    const next = { ...binding, physicalGenerationId: "b".repeat(32) };
    assert.throws(() => second.claimPhysicalClient(next, 999_999), /physical_client_quarantined/);
    assert.throws(() => second.claimPhysicalClient({ ...binding, bridgeSessionId: "wrong" }, 2));
    second.recordPhysicalOutcome(binding, { reaped: false, exitDiagnostic: null, outcome: outcome(), failure: "reap_failed" }, 3);
    assert.equal(first.listPhysicalCustody()[0]?.state, "quarantined");
    assert.throws(() => first.clearPhysicalClient({ ...next, operator: "human", assertInspectedIdle: true, nowMs: 4 }));
    first.clearPhysicalClient({ ...binding, operator: "human", assertInspectedIdle: true, nowMs: 4 });
    second.claimPhysicalClient(next, 5);
    assert.throws(() => first.recordPhysicalOutcome(binding, { reaped: true, exitDiagnostic: null, outcome: outcome(), failure: null }, 6));
    assert.equal(first.listPhysicalCustody().find((row) => row.physicalGenerationId === next.physicalGenerationId)?.state, "quarantined");
  } finally { first.close(); second.close(); }
  const reopened = openSessionStore({ filename });
  try {
    assert.equal(reopened.listPhysicalCustody().length, 2);
    assert.equal(reopened.listPhysicalCustody()[0]?.clearOperator, "human");
    assert.throws(() => reopened.claimPhysicalClient({ ...binding, physicalGenerationId: "c".repeat(32) }, 999_999));
    reopened.claimPhysicalClient({ ...binding, physicalClientId: "independent" }, 9);
  } finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("outcome persistence is atomic and only exact reaped confirmation or no-action clears", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "custody-outcome-")), filename = path.join(dir, "orchestration.db");
  const store = openSessionStore({ filename }), raw = new Database(filename);
  try {
    store.claimPhysicalClient(binding, 1);
    raw.exec("CREATE TRIGGER fail_custody BEFORE UPDATE ON physical_client_custody BEGIN SELECT RAISE(FAIL, 'synthetic'); END");
    assert.throws(() => store.recordPhysicalOutcome(binding, { reaped: true, exitDiagnostic: "nonzero_exit", outcome: outcome(), failure: null }, 2));
    assert.equal(store.listPhysicalCustody()[0]?.state, "quarantined");
    assert.equal(store.listPhysicalCustody()[0]?.exitDiagnostic, null);
    raw.exec("DROP TRIGGER fail_custody");
    assert.throws(() => store.recordPhysicalOutcome(binding, { reaped: true, exitDiagnostic: null, outcome: outcome({ ...binding, bridgeSessionId: "wrong" }), failure: null }, 3));
    store.recordPhysicalOutcome(binding, { reaped: true, exitDiagnostic: null, outcome: outcome(), failure: null }, 4);
    assert.equal(store.listPhysicalCustody()[0]?.state, "cleared");
    for (const [id, result, state] of [
      ["b", { reaped: true, exitDiagnostic: null, outcome: null, failure: "outcome_missing" }, "quarantined"],
      ["c", { reaped: true, exitDiagnostic: null, outcome: { outcome: "no_join_action", reason: "join_not_issued" }, failure: null }, "cleared"],
      // The bridge found no client to drive: it exited nonzero after its no-join outcome.
      ["e", { reaped: true, exitDiagnostic: "nonzero_exit", outcome: { outcome: "no_join_action", reason: "client_not_running" }, failure: null }, "cleared"],
      ["d", { reaped: true, exitDiagnostic: null, outcome: { outcome: "departure_unconfirmed", reason: "departure_not_observed" }, failure: null }, "quarantined"],
    ] as const) {
      const own = { ...binding, physicalClientId: id, physicalGenerationId: id.repeat(32) };
      store.claimPhysicalClient(own, 5);
      store.recordPhysicalOutcome(own, { ...result, outcome: result.outcome === null ? null : { ...outcome(own), ...result.outcome } }, 6);
      assert.equal(store.listPhysicalCustody().find((row) => row.physicalClientId === id)?.state, state);
    }
    const missing = store.listPhysicalCustody().find((row) => row.physicalClientId === "e");
    assert.equal(missing?.clearReason, "join_not_issued", "the clear proof is that no join was issued");
    assert.equal(missing?.outcome?.reason, "client_not_running", "the cause stays in the recorded outcome");
  } finally { raw.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
