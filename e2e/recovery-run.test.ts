import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { StdioGatewayCleanupOutcome } from "@conversation/runtime";

const runner = existsSync(new URL("./recovery-run.mjs", import.meta.url))
  // @ts-expect-error Test-only runner has no public declarations.
  ? await import("./recovery-run.mjs") : {};

test("R1 command admits only one absolute evidence destination and optional keep", () => {
  assert.equal(typeof runner.parseRecoveryArguments, "function");
  assert.deepEqual(runner.parseRecoveryArguments(["--out", "/private/evidence", "--keep"]), { out: "/private/evidence", keep: true, warningCut: "before-file-fsync" });
  for (const args of [[], ["--out"], ["--out", "relative"], ["--out", "/a", "--out", "/b"],
    ["--out", "/a", "--phase", "warning-boundary"], ["--out", "/a", "--keep", "--keep"], ["--out", "/a\0b"]])
    assert.throws(() => runner.parseRecoveryArguments(args));
});

test("crash permission requires actual clean seed, encrypted hash, external failure and no descendants or artifact", () => {
  assert.equal(typeof runner.assertInitialCrashCut, "function");
  const proof = {
    state: { occurrenceId: "occurrence", stopAtMs: 11, expiresAtMs: 14,
      r1Preconditions: { initialFailureRestartReady: true }, pending: { deliveryCount: 0, jobCount: 0 },
      source: { sha256: "a".repeat(64), retention: "retained" } },
    seedEvent: { name: "r1_seed_failed", occurrenceId: "occurrence", stopAtMs: 11, expiresAtMs: 14, sourceSha256: "a".repeat(64), providerArmedFailure: true },
    measuredSha256: "a".repeat(64), readyBundles: [], descendants: [], liveGatewayPids: [],
  };
  runner.assertInitialCrashCut(proof);
  for (const patch of [
    { state: { ...proof.state, r1Preconditions: { initialFailureRestartReady: false } } },
    { state: { ...proof.state, pending: { deliveryCount: 1, jobCount: 0 } } },
    { seedEvent: { ...proof.seedEvent, occurrenceId: "foreign" } },
    { seedEvent: { ...proof.seedEvent, expiresAtMs: 15 } },
    { seedEvent: { ...proof.seedEvent, providerArmedFailure: false } },
    { measuredSha256: "b".repeat(64) }, { readyBundles: ["bundle"] }, { descendants: [{ pid: 23 }] }, { liveGatewayPids: [23] },
  ]) assert.throws(() => runner.assertInitialCrashCut({ ...proof, ...patch }));
});

test("owned child wait settles its actual exit or fails within the cleanup budget", async () => {
  assert.equal(typeof runner.awaitOwnedExit, "function");
  assert.deepEqual(await runner.awaitOwnedExit(Promise.resolve({ code: null, signal: "SIGKILL" }), 50), { code: null, signal: "SIGKILL" });
  await assert.rejects(runner.awaitOwnedExit(new Promise(() => {}), 10), /owned_child_cleanup_timeout/);
});

test("initial tick waits for settled live owner and real SDK successful cleanup status", () => {
  assert.equal(typeof runner.initialRuntimeSettled, "function");
  const cleanupStatuses: StdioGatewayCleanupOutcome["status"][] = ["graceful", "forced", "failed"];
  const outcome = { phase: "settled", finalization: "seeded", runtimeClose: "closed", runtimeCleanup: "graceful" };
  for (const runtimeCleanup of cleanupStatuses)
    assert.equal(runner.initialRuntimeSettled({ ...outcome, runtimeCleanup }), runtimeCleanup !== "failed");
  for (const patch of [{ phase: "live" }, { finalization: "recorded" }, { runtimeClose: "pending" }, { runtimeCleanup: "confirmed" }, { runtimeCleanup: null }])
    assert.equal(runner.initialRuntimeSettled({ ...outcome, ...patch }), false);
});

test("privacy byte scan refuses plaintext capture or secret leakage in any scanned output", () => {
  assert.equal(typeof runner.assertPrivateOutputs, "function");
  const root = mkdtempSync(path.join(tmpdir(), "r1-output-check-")), file = path.join(root, "output");
  const secret = "synthetic-private-value";
  try {
    writeFileSync(file, "safe metadata"); runner.assertPrivateOutputs([file], [secret]);
    for (const bytes of [Buffer.from(`log ${secret}`), Buffer.alloc(960), Buffer.from("RIFFaudio")]) {
      writeFileSync(file, bytes); assert.throws(() => runner.assertPrivateOutputs([file], [secret]));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unavailable process inventory emits a static refusal and never becomes an empty ownership proof", () => {
  assert.equal(typeof runner.processInventoryRows, "function");
  const stdout = "  101 1 /usr/bin/node\n  102 101 /private/gateway\n";
  assert.deepEqual(runner.processInventoryRows({ exit: 0, stdout }), [
    { pid: 101, ppid: 1, command: "/usr/bin/node" }, { pid: 102, ppid: 101, command: "/private/gateway" },
  ]);
  for (const result of [{ exit: 127, stdout: "", stderr: "Operation not permitted" },
    { exit: 127, stdout, stderr: "sensitive process details" }, { exit: null, stdout, signal: "SIGTERM" }]) {
    assert.throws(() => runner.processInventoryRows(result), error =>
      error instanceof Error && error.message === "process_inventory_unavailable");
  }
});

test("reaped app and empty known PID list cannot certify cleanup when process inventory was unavailable", () => {
  assert.equal(typeof runner.recoveryCleanupEvidence, "function");
  const child = { outcome: { code: null, signal: "SIGTERM" }, trees: [] };
  const input = { children: [child], remainingPids: [], cleanupSucceeded: true, inventoryUnavailable: true };
  assert.deepEqual(runner.recoveryCleanupEvidence(input), { knownOwnedChildrenReaped: true,
    processInventoryVerified: false, cleanupCoverage: "incomplete", cleanupConfirmed: false });
  assert.equal(runner.recoveryCleanupEvidence({ ...input, inventoryUnavailable: false }).cleanupConfirmed, false);
  const inventoried = { ...input, children: [{ ...child, trees: [[]] }], inventoryUnavailable: false };
  assert.equal(runner.recoveryCleanupEvidence(inventoried).cleanupConfirmed, true);
  assert.equal(runner.recoveryCleanupEvidence({ ...inventoried, remainingPids: [102] }).cleanupConfirmed, false);
  assert.equal(runner.recoveryCleanupEvidence({ ...inventoried, cleanupSucceeded: false }).cleanupConfirmed, false);
});

 test("warning crash variant is explicit and duplicate or unsupported cuts refuse", () => {
  assert.deepEqual(runner.parseRecoveryArguments(["--warning-cut", "accepted-before-store-crash", "--out", "/private/evidence"]),
    { out: "/private/evidence", keep: false, warningCut: "accepted-before-store-crash" });
  for (const args of [["--warning-cut"], ["--warning-cut", "store-write-exception"],
    ["--warning-cut", "before-file-fsync", "--warning-cut", "accepted-before-store-crash"]])
    assert.throws(() => runner.parseRecoveryArguments(["--out", "/private/evidence", ...args]));
});

test("durable warning crash permission binds actual owner, claim, original source and physical file with no descendants", () => {
  assert.equal(typeof runner.assertWarningCrashCut, "function");
  const file = { name: "a".repeat(64) + ".json", sha256: "b".repeat(64), device: "1", inode: "2", bytes: 123 };
  const source = { sha256: "c".repeat(64), retention: "retained", handle: "a".repeat(32), path: "/private/source", device: "1", inode: "3" };
  const original = { occurrenceId: "occurrence", stopAtMs: 1100000, expiresAtMs: 1400000, source };
  const state = { ...original, pending: { deliveryCount: 0, jobCount: 0 },
    lifecycle: { owner: "seed", state: "stopped", processCleanupState: null, processOwned: false, buildClaimed: false, cleanupClaimed: false },
    warning: { state: "claimed", claimed: true, acceptedAtMs: null, claimExpiresAtMs: 1130000, attemptCount: 1 } };
  const receiptEvent = { name: "warning_durable_receipt_blocked", occurrenceId: "occurrence", stopAtMs: original.stopAtMs,
    expiresAtMs: original.expiresAtMs, claimExpiresAtMs: 1130000, file };
  const proof = { original, state, receiptEvent, file, measuredSourceSha256: source.sha256,
    admitted: true, ownerRunning: true, descendants: [], liveGatewayPids: [], readyBundles: [] };
  runner.assertWarningCrashCut(proof);
  for (const patch of [
    { admitted: false }, { ownerRunning: false }, { descendants: [{ pid: 2 }] }, { liveGatewayPids: [2] }, { readyBundles: ["artifact"] },
    { measuredSourceSha256: "d".repeat(64) }, { file: { ...file, inode: "different" } },
    { receiptEvent: { ...receiptEvent, claimExpiresAtMs: 1130001 } },
    { state: { ...state, warning: { ...state.warning, acceptedAtMs: 1100000 } } },
    { state: { ...state, warning: { ...state.warning, claimed: false } } },
    { state: { ...state, warning: { ...state.warning, claimExpiresAtMs: 1400000 } } },
    { state: { ...state, source: { ...source, inode: "different" } } },
    { state: { ...state, lifecycle: { ...state.lifecycle, processCleanupState: "failed" } } },
    { state: { ...state, pending: { deliveryCount: 1, jobCount: 0 } } },
  ]) assert.throws(() => runner.assertWarningCrashCut({ ...proof, ...patch }));
});

test("acceptance transaction-abort is an explicit closed warning cut", () => {
  assert.deepEqual(runner.parseRecoveryArguments(["--out", "/private/evidence", "--warning-cut", "acceptance-transaction-abort"]),
    { out: "/private/evidence", keep: false, warningCut: "acceptance-transaction-abort" });
  for (const args of [["--warning-cut", "acceptance-transaction-abort", "--warning-cut", "acceptance-transaction-abort"],
    ["--warning-cut", "commit-fsync-failure"], ["--warning-cut", "acceptance-transaction-abort", "--sql-error", "fake"]])
    assert.throws(() => runner.parseRecoveryArguments(["--out", "/private/evidence", ...args]));
});

test("SQL abort recovery proof requires exact pending retry, installed/cleared fault, file and settled application", () => {
  assert.equal(typeof runner.assertWarningSqlAbortCut, "function");
  const file = { name: "a".repeat(64) + ".json", sha256: "b".repeat(64), device: "1", inode: "2", bytes: 123 };
  const source = { sha256: "c".repeat(64), retention: "retained", handle: "a".repeat(32), path: "/private/source", device: "1", inode: "3" };
  const original = { occurrenceId: "occurrence", stopAtMs: 1100000, expiresAtMs: 1400000, source };
  const state = { ...original, pending: { deliveryCount: 0, jobCount: 0 },
    lifecycle: { owner: "seed", state: "stopped", processCleanupState: null, processOwned: false, buildClaimed: false, cleanupClaimed: false },
    warning: { state: "pending", claimed: false, acceptedAtMs: null, claimExpiresAtMs: null, attemptCount: 1, nextAttemptAtMs: 1101000 } };
  const fault = { triggerName: "e2e_warning_acceptance_abort", templateSha256: "d".repeat(64) };
  const faultEvent = { name: "warning_sql_fault_installed", occurrenceId: "occurrence", stopAtMs: 1100000, expiresAtMs: 1400000, fault };
  const rescheduleEvent = { ...faultEvent, name: "warning_acceptance_abort_rescheduled", nextAttemptAtMs: 1101000,
    attemptCount: 1, file, checkpoints: ["file", "directory"] };
  const clearEvent = { ...faultEvent, name: "warning_sql_fault_cleared" };
  const proof = { original, state, faultEvent, rescheduleEvent, clearEvent, file, measuredSourceSha256: source.sha256,
    outcome: { code: 0, signal: null }, admitted: true, storeClosed: true, faultAbsent: true, descendants: [], liveGatewayPids: [], readyBundles: [] };
  runner.assertWarningSqlAbortCut(proof);
  for (const patch of [
    { faultEvent: undefined }, { clearEvent: undefined }, { faultEvent: { ...faultEvent, occurrenceId: "foreign" } },
    { clearEvent: { ...clearEvent, fault: { ...fault, templateSha256: "e".repeat(64) } } },
    { rescheduleEvent: { ...rescheduleEvent, nextAttemptAtMs: 1101001 } },
    { rescheduleEvent: { ...rescheduleEvent, checkpoints: ["file"] } },
    { file: { ...file, inode: "changed" } }, { measuredSourceSha256: "e".repeat(64) },
    { state: { ...state, warning: { ...state.warning, acceptedAtMs: 1100000 } } },
    { state: { ...state, warning: { ...state.warning, claimed: true } } },
    { state: { ...state, warning: { ...state.warning, claimExpiresAtMs: 1130000 } } },
    { state: { ...state, warning: { ...state.warning, nextAttemptAtMs: 1400000 } } },
    { state: { ...state, source: { ...source, inode: "changed" } } },
    { state: { ...state, lifecycle: { ...state.lifecycle, processOwned: true } } },
    { state: { ...state, pending: { deliveryCount: 0, jobCount: 1 } } },
    { outcome: { code: 1, signal: null } }, { admitted: false }, { storeClosed: false }, { faultAbsent: false },
    { descendants: [{ pid: 23 }] }, { liveGatewayPids: [23] }, { readyBundles: ["artifact"] },
  ]) assert.throws(() => runner.assertWarningSqlAbortCut({ ...proof, ...patch }));
});
