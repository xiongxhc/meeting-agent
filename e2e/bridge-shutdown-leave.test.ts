// A coordinator stop while the scripted bridge is joined must leave the way the
// real Mac bridge does (BridgeProcess.shutdown(), bridges/mac/README.md): EOF,
// SIGTERM and SIGINT stop media and make one bounded recorded leave. A
// confirmed leave clears custody through the shipped adapter and store; the
// fail-shutdown-leave control keeps the quarantine path reachable.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Readable, Writable } from "node:stream";
import { createChildBridgeSlot } from "../src/adapters/child-bridge-process.ts";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";

const CHILD = path.join(import.meta.dirname, "fixtures/e2e-bridge-child.mjs");

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "bridge-shutdown-leave-"));
  const controlDir = path.join(root, "control"); mkdirSync(controlDir, { mode: 0o700 });
  const staticConfigPath = path.join(root, "static.json");
  writeFileSync(staticConfigPath, JSON.stringify({ schema: "feishu-bridge-config/v1", controlDir, captureFrameLimit: 51, participants: [],
    audio: { captureDisplayId: 1, outputDeviceUid: "e2e-scripted-output" } }), { mode: 0o600 });
  const binding = { physicalClientId: "slot-1", physicalGenerationId: randomBytes(16).toString("hex"),
    occurrenceId: "123456789@2026-10-26T00:00:00Z", bridgeSessionId: "bridge-session-1" };
  const store = openSessionStore({ filename: path.join(root, "orchestration.db") });
  const state = () => JSON.parse(readFileSync(path.join(controlDir, "state.json"), "utf8"));
  return { root, controlDir, staticConfigPath, binding, store, state,
    cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

/** Joins through the shipped adapter, then closes it as application close does. */
async function joinThenClose(f: ReturnType<typeof fixture>, beforeClose = () => {}) {
  f.store.claimPhysicalClient(f.binding, 1);
  const owned = await createChildBridgeSlot({ physicalClientId: f.binding.physicalClientId, bridgeId: "bridge-1", executable: process.execPath,
    staticConfigPath: f.staticConfigPath, argv: [CHILD], protocol: "bridge-session/v2", cooperativeGraceMs: 5000 }).launch(f.binding);
  const events: Array<Record<string, unknown>> = [];
  owned.bridge.subscribe((raw) => { events.push(raw as Record<string, unknown>); });
  await owned.bridge.send({ schema: "bridge-session/v2", sessionId: f.binding.bridgeSessionId, commandId: "join-1", type: "join",
    meetingOccurrenceId: f.binding.occurrenceId, meetingNo: "123456789", leaseId: "lease-1" } as never);
  const deadline = Date.now() + 10_000;
  while (!events.some((row) => row.type === "command_result" && row.commandId === "join-1")) {
    if (Date.now() > deadline) throw new Error(`join unanswered: ${JSON.stringify(events)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(events.find((row) => row.type === "command_result")?.outcome, "ok");
  beforeClose();
  const result = await owned.shutdown();
  f.store.recordPhysicalOutcome(f.binding, result, 2);
  return { result, events, custody: f.store.listPhysicalCustody()[0]! };
}

test("a clean close while joined makes the scripted bridge leave once, and custody clears", { timeout: 60_000 }, async () => {
  const f = fixture();
  try {
    const { result, events, custody } = await joinThenClose(f);
    assert.deepEqual([result.reaped, result.failure, result.exitDiagnostic], [true, null, null]);
    assert.deepEqual([custody.state, custody.outcome?.outcome, custody.outcome?.reason], ["cleared", "departure_confirmed", "departure_observed"]);
    const state = f.state();
    assert.equal(state.shutdownLeave?.reason, "coordinator_stop");
    assert.equal(state.shutdownLeave?.outcome, "ok");
    assert.equal(state.left, "removed");
    // The leave is the bridge's own: no parent leave command was received.
    assert.deepEqual(state.commands, ["join"]);
    assert.equal(state.leave, null);
    assert.equal(events.filter((row) => row.type === "left").length, 0, "the shutdown leave is not published as a live meeting end");
  } finally { f.cleanup(); }
});

test("the fail-shutdown-leave control makes the shutdown leave fail, and custody stays quarantined", { timeout: 60_000 }, async () => {
  const f = fixture();
  try {
    const { result, custody } = await joinThenClose(f, () => writeFileSync(path.join(f.controlDir, "fail-shutdown-leave"), "fail"));
    assert.deepEqual([result.reaped, result.failure, result.exitDiagnostic], [true, null, "nonzero_exit"]);
    assert.deepEqual([custody.state, custody.outcome?.outcome, custody.outcome?.reason], ["quarantined", "departure_unconfirmed", "cleanup_failed"]);
    assert.equal(custody.clearedAtMs, null);
    const state = f.state();
    assert.equal(state.shutdownLeave?.outcome, "failed");
    assert.equal(state.left, null);
  } finally { f.cleanup(); }
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`${signal} while joined, with stdin still open, performs the same shutdown leave`, { timeout: 60_000 }, async () => {
    const f = fixture();
    try {
      const configPath = path.join(f.root, "config.json");
      writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(f.staticConfigPath, "utf8")), schema: "feishu-bridge-config/v3", custody: f.binding }), { mode: 0o600 });
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_OPTIONS"));
      const child = spawn(process.execPath, [CHILD, "--config", configPath], { stdio: ["pipe", "pipe", "ignore", "pipe"], env });
      let stdout = "", outcome = "";
      child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      (child.stdio[3] as Readable).on("data", (chunk: Buffer) => { outcome += chunk.toString("utf8"); });
      const exited = new Promise<[number | null, string | null]>((resolve) => child.once("exit", (code, sig) => resolve([code, sig])));
      (child.stdin as Writable).write(`${JSON.stringify({ schema: "bridge-session/v2", sessionId: f.binding.bridgeSessionId, commandId: "join-1", type: "join",
        meetingOccurrenceId: f.binding.occurrenceId, meetingNo: "123456789", leaseId: "lease-1" })}\n`);
      const deadline = Date.now() + 10_000;
      while (!stdout.includes('"commandId":"join-1"')) {
        if (Date.now() > deadline) throw new Error("join unanswered");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      child.kill(signal);
      assert.deepEqual(await exited, [0, null]);
      assert.match(outcome, /"outcome":"departure_confirmed","reason":"departure_observed"/);
      assert.equal(f.state().shutdownLeave?.outcome, "ok");
      child.kill();
    } finally { f.cleanup(); }
  });
}
