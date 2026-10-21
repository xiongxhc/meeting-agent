// R1 maintenance-only re-entry: shipped admission, store, workers and Runtime.
import assert from "node:assert/strict";
import { appendFileSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { Agent as HttpAgent } from "node:http";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { defaultHttpInstance } from "@larksuiteoapi/node-sdk";
import { createFeishuSdkHttp } from "../dist/src/adapters/feishu-sdk-http.js";
import { createFeishuSocketOwner } from "../dist/src/adapters/feishu-sdk-connection.js";
import { acquireApplicationOwnerLock } from "../dist/src/adapters/application-owner-lock.js";
import { createFilesystemOperatorWarningSink } from "../dist/src/adapters/filesystem-operator-warning.js";
import { composeApplication } from "../dist/src/application-composition.js";
import { runStandalone } from "../dist/src/main.js";
import { inspectStateRoot, readStandaloneConfig } from "../dist/src/standalone-config.js";
import { runExposedComposition } from "./composition-lifecycle.mjs";
import { startFeishuPeer } from "./feishu-peer.mjs";
import { startFixtureProvider } from "./fixture-provider.mjs";
import { postmeetingOnlineGatewayToml } from "./gateway-config.mjs";
import { startInteractiveProvider } from "./interactive-provider.mjs";
import { createRecoveryClock, readKnownEndRecoveryState } from "./recovery-state.mjs";
import { sha256File } from "./pins.mjs";
import { createWarningReceiptBarrier, measureWarningFile } from "./warning-commit-cut.mjs";
import { installWarningStoreFault, warningSqlReplayBoundary } from "./warning-store-fault.mjs";

const plan = JSON.parse(readFileSync(process.argv[process.argv.indexOf("--plan") + 1], "utf8"));
assert.ok(["warning-boundary", "warning-replay", "expiry-boundary"].includes(plan.recoveryPhase));
assert.ok(["before-file-fsync", "accepted-before-store-crash", "acceptance-transaction-abort"].includes(plan.warningCut));
const config = JSON.parse(readFileSync(plan.standaloneConfigPath, "utf8"));
const databasePath = path.join(config.stateRoot, "orchestration.db");
const read = () => readKnownEndRecoveryState({ databasePath, occurrenceId: plan.occurrenceId });
const eventFile = path.join(plan.controlDir, `${plan.recoveryPhase}.ndjson`);
const event = (name, detail = {}) => appendFileSync(eventFile, JSON.stringify({ name, monotonicNs: process.hrtime.bigint().toString(), ...detail }) + "\n");

async function main() {
  event("entry_environment", { keys: Object.keys(process.env).sort() });
  const original = read();
  assert.equal(original.stopAtMs, plan.stopAtMs); assert.equal(original.expiresAtMs, plan.expiresAtMs);
  assert.equal(original.source.sha256, plan.sourceSha256);
  const replayAtMs = plan.recoveryPhase === "warning-replay" ? (plan.warningCut === "acceptance-transaction-abort"
    ? warningSqlReplayBoundary({ state: original, plan }) : original.warning.claimExpiresAtMs) : null;
  // The worker reserves 7s for actual child cleanup. A 1ms allowance cannot
  // launch Runtime. Fail it earlier, then observe both exact deadline cuts.
  const clock = createRecoveryClock(plan.recoveryPhase === "warning-boundary" ? original.stopAtMs - 60000 :
    plan.recoveryPhase === "warning-replay" ? replayAtMs - 1 : original.expiresAtMs - 1);
  const shutdown = new globalThis.AbortController();
  let provider, idleVoice, peer, app, runPromise, admissionExit = null;
  const trace = [];
  let warningFaults = 0, driveFailure = null;
  const warningCheckpoints = [];
  const measure = () => measureWarningFile({ outboxDir: config.dataPaths.outboxDir, occurrenceId: plan.occurrenceId,
    stopAtMs: original.stopAtMs, expiresAtMs: original.expiresAtMs });
  try {
    provider = await startFixtureProvider(); idleVoice = await startInteractiveProvider(); peer = await startFeishuPeer({ meeting: plan.meeting });
    // The seed's pinned profile is online; post-meeting work must run in it.
    writeFileSync(plan.gatewayConfigPath, postmeetingOnlineGatewayToml({ recordingsDir: plan.runtimeRecordingsDir,
      keyEnv: plan.recordingKeyEnv, credentialEnv: plan.providerCredentialEnv, languageEndpoint: `${provider.endpoint}/v1`,
      recognitionEndpoint: idleVoice.recognitionEndpoint, speechEndpoint: idleVoice.endpoint }), { mode: 0o600 });
    if (plan.recoveryPhase === "warning-boundary") provider.armNextChatFailure();
    const realWarningSink = createFilesystemOperatorWarningSink({ outboxDir: config.dataPaths.outboxDir, durabilityCheckpoint: step => {
      warningCheckpoints.push(step);
      if (plan.warningCut === "before-file-fsync" && plan.recoveryPhase === "warning-boundary" && step === "file" && warningFaults === 0) {
        warningFaults += 1; event("warning_fsync_fault"); throw new Error("scripted_warning_fsync_failure");
      }
    } });
    const warningSink = plan.warningCut === "accepted-before-store-crash" && plan.recoveryPhase === "warning-boundary"
      ? createWarningReceiptBarrier({ sink: realWarningSink, onDurableReceipt(input, receipt) {
        assert.equal(receipt.key, input.key);
        const claimed = read(); assert.equal(claimed.warning.state, "claimed"); assert.equal(claimed.warning.acceptedAtMs, null);
        event("warning_durable_receipt_blocked", { occurrenceId: plan.occurrenceId, stopAtMs: original.stopAtMs,
          expiresAtMs: original.expiresAtMs, claimExpiresAtMs: claimed.warning.claimExpiresAtMs, file: measure(),
          checkpoints: [...warningCheckpoints] });
      }, waitForRelease: () => new Promise(() => {}) }) : realWarningSink;
    const options = {
      clock,
      feishu: { http: createFeishuSdkHttp({ request: peer.rewriteRequest(defaultHttpInstance.request), connection: createFeishuSocketOwner(HttpAgent) }),
        connection: createFeishuSocketOwner(HttpAgent), readyTimeoutMs: 15000, handshakeTimeoutMs: 5000, closeTimeoutMs: 7000 },
      maintenance: { intervalsMs: { backfill: 3600000, warning: 3600000, outbox: 3600000, notification: 3600000, discovery: 3600000, custody: 3600000 }, random: () => 0,
        warningSink },
      log: code => { trace.push(code); event("log", { code }); },
    };
    runPromise = runStandalone(["--standalone-config", plan.standaloneConfigPath], {
      readConfig: readStandaloneConfig, inspectStateRoot, acquireOwnerLock: acquireApplicationOwnerLock,
      composeAfterAdmission: (admitted, owner) => runExposedComposition(composeApplication, admitted, owner, options, handle => { app = handle; }, shutdown),
      report: (_channel, line) => event("admission_report", { code: /^meeting-agent: [a-z_ ]+$/.test(line) ? line : "admission_report_unclassified" }),
    });
    void runPromise.then(exit => { admissionExit = exit; });
    const end = Date.now() + 60000;
    while ((!app || !trace.includes("composition_started")) && admissionExit === null && Date.now() < end) await delay(25);
    assert.ok(app?.maintenanceStatus().started && trace.includes("composition_started"), "shipped maintenance owner did not start");
    const tick = async (lane, expected) => {
      assert.equal(await app.maintenanceTick(lane), expected);
      const status = app.maintenanceStatus();
      assert.deepEqual(status.codes, []); assert.ok(status.lanes.every(row => !row.inFlight));
      event("maintenance_tick", { lane, outcome: expected, status });
    };
    event("maintenance_reopened", { phase: plan.recoveryPhase, nowMs: clock.now() });
    if (plan.recoveryPhase === "warning-boundary") {
      await tick("backfill", "backfill_rescheduled");
      const before = read(); assert.equal(before.lifecycle.state, "pending"); assert.equal(before.warning, null);
      assert.equal(before.lifecycle.processCleanupState, null); assert.equal(before.lifecycle.processOwned, false);
      assert.ok(before.lifecycle.initialBuildAttempts > original.lifecycle.initialBuildAttempts);
      assert.ok(provider.calls.some(call => call.route === "chat" && call.outcome === "armed_failure"));
      assert.equal(await sha256File(before.source.path), plan.sourceSha256);
      event("recovered_build_failed_cleanly", { nowMs: clock.now(), providerCalls: provider.calls });
      clock.advanceTo(original.stopAtMs - 1);
      await tick("warning", "warning_idle");
      assert.equal(read().warning, null);
      event("before_stop_boundary", { nowMs: clock.now() });
      clock.advanceTo(original.stopAtMs);
      await tick("backfill", "backfill_stopped");
      if (plan.warningCut === "accepted-before-store-crash") {
        // Deliberately unresolved real warning operation until the controller
        // kills this admitted owner. No exception/failBackfillWarning path.
        await tick("warning", "warning_accepted");
        throw new Error("warning_crash_barrier_returned");
      }
      if (plan.warningCut === "acceptance-transaction-abort") {
        const fault = installWarningStoreFault({ root: plan.privateRoot, databasePath, occurrenceId: plan.occurrenceId,
          stopAtMs: original.stopAtMs, expiresAtMs: original.expiresAtMs });
        const faultBinding = { occurrenceId: plan.occurrenceId, stopAtMs: original.stopAtMs, expiresAtMs: original.expiresAtMs,
          fault: { triggerName: fault.triggerName, templateSha256: fault.templateSha256 } };
        event("warning_sql_fault_installed", faultBinding);
        await tick("warning", "warning_rescheduled");
        const failed = read();
        warningSqlReplayBoundary({ state: failed, plan: { ...plan, nextAttemptAtMs: failed.warning?.nextAttemptAtMs } });
        assert.equal(failed.lifecycle.state, "stopped"); assert.equal(failed.lifecycle.owner, "seed");
        assert.equal(failed.lifecycle.processOwned, false); assert.equal(failed.lifecycle.processCleanupState, null);
        assert.deepEqual(failed.pending, { deliveryCount: 0, jobCount: 0 }); assert.deepEqual(failed.source, original.source);
        assert.equal(await sha256File(failed.source.path), plan.sourceSha256);
        assert.deepEqual(warningCheckpoints, ["file", "directory"]);
        event("warning_acceptance_abort_rescheduled", { ...faultBinding, nextAttemptAtMs: failed.warning.nextAttemptAtMs,
          attemptCount: failed.warning.attemptCount, file: measure(), checkpoints: [...warningCheckpoints] });
        // Clear only after the actual persisted reschedule/file evidence was
        // recorded. Failure preserves the private fault for inspection.
        fault.clear(); event("warning_sql_fault_cleared", faultBinding);
      } else {
        await tick("warning", "warning_rescheduled");
        const failed = read(); assert.equal(failed.lifecycle.state, "stopped"); assert.equal(failed.warning?.state, "pending");
        assert.equal(warningFaults, 1); assert.ok(failed.warning.attemptCount >= 1);
        assert.equal(failed.warning.acceptedAtMs, null); assert.equal(failed.warning.claimed, false);
        const warningDir = path.join(config.dataPaths.outboxDir, "operator-warnings");
        assert.deepEqual(readdirSync(warningDir), [], "failed fsync must not publish a visible warning");
        assert.ok(failed.warning.nextAttemptAtMs >= original.stopAtMs && failed.warning.nextAttemptAtMs < original.expiresAtMs);
        event("warning_failure_persisted", { attempts: failed.warning.attemptCount });
        clock.advanceTo(failed.warning.nextAttemptAtMs);
        await tick("warning", "warning_accepted");
        const accepted = read(); assert.equal(accepted.warning?.state, "accepted");
        assert.equal(accepted.warning.acceptedAtMs, clock.now());
        const warningNames = readdirSync(warningDir); assert.equal(warningNames.length, 1);
        assert.match(warningNames[0], /^[0-9a-f]{64}\.json$/);
        const warningPath = path.join(warningDir, warningNames[0]);
        const stat = lstatSync(warningPath); assert.ok(stat.isFile() && !stat.isSymbolicLink()); assert.equal(stat.mode & 0o777, 0o600);
        const warning = JSON.parse(readFileSync(warningPath, "utf8"));
        assert.equal(warning.occurrenceId, plan.occurrenceId); assert.equal(Date.parse(warning.stopAt), original.stopAtMs);
        assert.equal(Date.parse(warning.expiresAt), original.expiresAtMs); assert.equal(warning.reason, "backfill_stopped");
        const warningSha256 = await sha256File(warningPath);
        await tick("warning", "warning_idle");
        assert.equal(read().warning?.attemptCount, accepted.warning.attemptCount);
        assert.deepEqual(readdirSync(warningDir), warningNames); assert.equal(await sha256File(warningPath), warningSha256);
        event("warning_worker_replay_idle", { acceptedAtMs: accepted.warning.acceptedAtMs, warningSha256, visibleFiles: 1 });
      }
    } else if (plan.recoveryPhase === "warning-replay") {
      if (plan.warningCut === "acceptance-transaction-abort") {
        assert.equal(original.warning.nextAttemptAtMs, replayAtMs);
      } else {
        assert.equal(plan.warningCut, "accepted-before-store-crash");
        assert.equal(original.warning.state, "claimed"); assert.equal(original.warning.acceptedAtMs, null);
        assert.equal(original.warning.claimExpiresAtMs, plan.claimExpiresAtMs);
        assert.ok(plan.claimExpiresAtMs < original.expiresAtMs);
      }
      assert.deepEqual(measure(), plan.expectedWarningFile);
      assert.equal(await sha256File(original.source.path), plan.sourceSha256);
      await tick("warning", "warning_idle");
      assert.deepEqual(read().warning, original.warning); assert.deepEqual(measure(), plan.expectedWarningFile);
      assert.deepEqual(warningCheckpoints, []);
      event(plan.warningCut === "acceptance-transaction-abort" ? "before_warning_retry_idle" : "unexpired_warning_claim_idle",
        { nowMs: clock.now(), ...(plan.warningCut === "acceptance-transaction-abort" ? { nextAttemptAtMs: replayAtMs } : { claimExpiresAtMs: plan.claimExpiresAtMs }) });
      clock.advanceTo(replayAtMs); await tick("warning", "warning_accepted");
      const accepted = read();
      assert.equal(accepted.warning.state, "accepted"); assert.equal(accepted.warning.acceptedAtMs, replayAtMs);
      assert.equal(accepted.warning.attemptCount, original.warning.attemptCount + 1);
      assert.equal(accepted.warning.claimed, false); assert.equal(accepted.warning.claimExpiresAtMs, null);
      assert.deepEqual(warningCheckpoints, ["directory"], "actual sink replay must use existing-file path");
      assert.deepEqual(measure(), plan.expectedWarningFile);
      await tick("warning", "warning_idle"); assert.deepEqual(read().warning, accepted.warning);
      event("warning_worker_replay_idle", { acceptedAtMs: accepted.warning.acceptedAtMs,
        warningSha256: plan.expectedWarningFile.sha256, file: measure(), checkpoints: warningCheckpoints, visibleFiles: 1 });
    } else {
      const warningBefore = original.warning;
      const warningDir = path.join(config.dataPaths.outboxDir, "operator-warnings");
      const warningNames = readdirSync(warningDir); assert.equal(warningNames.length, 1);
      const warningPath = path.join(warningDir, warningNames[0]);
      const warningSha256 = await sha256File(warningPath);
      assert.equal(warningSha256, plan.expectedWarningSha256, "accepted warning bytes changed across actual reopen");
      if (plan.expectedWarningFile) assert.deepEqual(measure(), plan.expectedWarningFile);
      assert.equal(await sha256File(original.source.path), plan.sourceSha256);
      await tick("outbox", "outbox_reconciled");
      const before = read(); assert.notEqual(before.lifecycle.state, "deleted"); assert.equal(before.source.retention, "retained");
      assert.equal(await sha256File(before.source.path), plan.sourceSha256);
      event("before_expiry_boundary", { nowMs: clock.now() });
      clock.advanceTo(original.expiresAtMs); await tick("outbox", "outbox_reconciled");
      const expired = read(); assert.equal(expired.lifecycle.state, "deleted"); assert.equal(expired.source.retention, "deleted");
      assert.equal(expired.lifecycle.deletedAtMs, original.expiresAtMs);
      assert.deepEqual(expired.warning, warningBefore);
      assert.deepEqual(readdirSync(warningDir), warningNames); assert.equal(await sha256File(warningPath), warningSha256);
      if (plan.expectedWarningFile) assert.deepEqual(measure(), plan.expectedWarningFile);
      event("expiry_cleanup_settled", { originalExpiresAtMs: original.expiresAtMs });
    }
  } catch { driveFailure = "recovery_phase_failed"; event("drive_failed", { reason: driveFailure }); }
  finally {
    if (runPromise) {
      if (admissionExit === null) shutdown.abort();
      let timeout;
      const exit = await Promise.race([runPromise, new Promise((_, reject) => {
        timeout = globalThis.setTimeout(() => reject(new Error("recovery_cleanup_timeout")), 30000);
      })]).finally(() => globalThis.clearTimeout(timeout));
      event("standalone_closed", { exit });
      if (exit !== 0) driveFailure ??= "recovery_admission_or_cleanup_failed";
    }
    await provider?.close(); await idleVoice?.close(); await peer?.close();
  }
  if (driveFailure) process.exitCode = 1;
}
await main().catch(() => { event("entry_failed", { reason: "recovery_entry_failed" }); process.exitCode = 1; });
