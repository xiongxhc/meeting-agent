import assert from "node:assert/strict";
import { test } from "node:test";

// Load inside tests so a missing leaf produces an explicit missing-behavior assertion.
async function leaf() {
  // @ts-expect-error Test-only evidence helper has no public declaration.
  const module = await import("./process-evidence.mjs").catch(() => null);
  assert.ok(module, "the actual process-evidence leaf must be available");
  return module;
}
const absent = () => { throw Object.assign(new Error("absent"), { code: "ESRCH" }); };
const sample = (stdout: string) => ({ exit: 0, stdout });

// Replacing strict inventory with stdout-only parsing would certify these refusals.
test("inventory fails closed for denied, null, spawn-error, empty and malformed listings", async () => {
  const { createProcessEvidence, observeProcessSnapshot, processCleanupProof } = await leaf();
  for (const result of [null, { exit: 127, stdout: "" }, { exit: null, stdout: "" }, { exit: 0, stdout: "1 0 init", error: new Error("private detail") }, sample(""), sample("0 1 cmd"), sample("2 -1 cmd"), sample("2.5 1 cmd"), sample("Infinity 1 cmd"), sample("2 1"), sample("2 1 cmd\n2 3 other"), sample("2 3 cmd\n3 2 cmd")]) {
    const evidence = createProcessEvidence();
    assert.throws(() => observeProcessSnapshot(evidence, { result, rootPid: 10, owner: "app" }), /^Error: process_inventory_unavailable$/);
    assert.equal(processCleanupProof({ evidence, probe: absent }).cleanupConfirmed, false);
    assert.deepEqual(evidence.inventory.failures, ["process_inventory_unavailable"]);
    assert.equal(JSON.stringify(evidence).includes("private detail"), false);
  }
});

// Longest-only retention loses PID 12 and 13 in equal/smaller observations.
test("equal and smaller snapshots retain every observed helper and its origins after reparenting", async () => {
  const { createProcessEvidence, observeProcessSnapshot, processCleanupProof } = await leaf();
  const evidence = createProcessEvidence();
  evidence.children.push({ role: "app", pid: 10, outcome: { code: 0, signal: null, exitObserved: true } });
  observeProcessSnapshot(evidence, { result: sample("10 1 app\n11 10 helper\n14 11 nested"), rootPid: 10, owner: "app" });
  observeProcessSnapshot(evidence, { result: sample("10 1 app\n12 10 helper\n14 12 nested"), rootPid: 10, owner: "app" });
  observeProcessSnapshot(evidence, { result: sample("10 1 app\n13 10 helper"), rootPid: 10, owner: "app" });
  observeProcessSnapshot(evidence, { result: sample("1 0 init\n13 1 reparented"), rootPid: 10, owner: "app" });
  const proof = processCleanupProof({ evidence, knownPids: [{ role: "gateway", pid: 11 }, { role: "bridge_child", pid: 10 }], probe: (pid: number) => { if (pid !== 12) absent(); } });
  assert.deepEqual(proof.pids.map((row: { pid: number }) => row.pid).sort((a: number, b: number) => a - b), [10, 11, 12, 13, 14]);
  assert.deepEqual(proof.pids.find((row: { pid: number }) => row.pid === 11).origins, ["app", "gateway"]);
  assert.deepEqual(proof.orphans.map((row: { pid: number }) => row.pid), [12]);
  assert.equal(proof.cleanupConfirmed, false);
});

test("successful inventory, actual owned exit and every absent PID are all required for cleanup", async () => {
  const { createProcessEvidence, observeProcessSnapshot, processCleanupProof } = await leaf();
  const evidence = createProcessEvidence();
  evidence.children.push({ role: "app", pid: 10, outcome: null });
  assert.equal(processCleanupProof({ evidence, probe: absent }).cleanupConfirmed, false);
  observeProcessSnapshot(evidence, { result: sample("10 1 app"), rootPid: 10, owner: "app" });
  assert.equal(processCleanupProof({ evidence, probe: absent }).knownOwnedChildrenReaped, false);
  evidence.children[0].outcome = { code: 0, signal: null, exitObserved: true };
  const complete = processCleanupProof({ evidence, probe: absent });
  assert.equal(complete.cleanupConfirmed, true);
  assert.equal(complete.probes[0].status, "absent");
  assert.equal(complete.inventoryCoverage, "observed_run");
  const denied = processCleanupProof({ evidence, probe: () => { throw Object.assign(new Error("private"), { code: "EPERM" }); } });
  assert.equal(denied.cleanupConfirmed, false);
  assert.equal(denied.probes[0].status, "unverified");
  assert.equal(JSON.stringify(denied).includes("private"), false);
  assert.throws(() => observeProcessSnapshot(evidence, { result: { exit: 127, stdout: "" }, rootPid: 10, owner: "app" }));
  observeProcessSnapshot(evidence, { result: sample("1 0 init"), rootPid: 10, owner: "app" });
  assert.equal(processCleanupProof({ evidence, probe: absent }).cleanupConfirmed, false);
});

test("invalid known PID values cannot reach the liveness probe", async () => {
  const { createProcessEvidence, observeProcessSnapshot, processCleanupProof } = await leaf();
  const evidence = createProcessEvidence();
  observeProcessSnapshot(evidence, { result: sample("1 0 init"), rootPid: 10, owner: "app" });
  for (const pid of [0, -1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "10"]) {
    const proof = processCleanupProof({ evidence, knownPids: [{ role: "gateway", pid }], probe: () => assert.fail("invalid PID was probed") });
    assert.equal(proof.cleanupConfirmed, false);
    assert.deepEqual(proof.invalidPids, ["gateway"]);
  }
});

test("refusal evidence excludes baseline processes but probes recorded newcomers and requires holder exit", async () => {
  const { createProcessEvidence, observeProcessSnapshot, processCleanupProof } = await leaf();
  const evidence = createProcessEvidence();
  const before = observeProcessSnapshot(evidence, { result: sample("10 1 controller\n11 10 baseline"), rootPid: 10, owner: "refusals", baseline: true });
  evidence.children.push({ role: "refusal_holder", pid: 12, outcome: null });
  observeProcessSnapshot(evidence, { result: sample("10 1 controller\n11 10 baseline\n13 10 newcomer"), rootPid: 10, owner: "refusals", excludePids: before.map((row: { pid: number }) => row.pid) });
  const proof = processCleanupProof({ evidence, probe: (pid: number) => { if (pid === 12) absent(); } });
  assert.deepEqual(proof.pids.map((row: { pid: number }) => row.pid).sort(), [12, 13]);
  assert.equal(proof.cleanupConfirmed, false);
  assert.equal(proof.knownOwnedChildrenReaped, false);
  assert.deepEqual(proof.orphans.map((row: { pid: number }) => row.pid), [13]);
  evidence.children[0].outcome = { code: 0, signal: null, exitObserved: true };
  assert.equal(processCleanupProof({ evidence, probe: absent }).cleanupConfirmed, true);
  for (const phase of ["before", "after"]) {
    const refused = createProcessEvidence();
    assert.throws(() => observeProcessSnapshot(refused, { result: { exit: 127, stdout: "" }, rootPid: 10, owner: phase, baseline: phase === "before" }));
    assert.equal(processCleanupProof({ evidence: refused, probe: absent }).cleanupConfirmed, false);
  }
});
