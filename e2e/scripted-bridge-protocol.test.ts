// The scripted e2e bridge child must answer the command protocol the way the
// real Swift bridge does (bridges/mac/Sources/FeishuBridgeSpike/BridgeProcess.swift):
// leave stops media, emits left(removed) and answers ok; release_lease answers
// ok only after departure; a non-join first command is a protocol failure; a
// repeated command ID replays its result. No media endpoint is opened here.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import type { Readable, Writable } from "node:stream";
// @ts-expect-error Test-only harness module has no public declaration.
import { providerFaultOracles } from "./provider-fault-oracles.mjs";
// @ts-expect-error Test-only harness module has no public declaration.
import { readStateFile } from "./state-file.mjs";
// @ts-expect-error Test-only harness module has no public declaration.
import { answerLeaseRenewal, parseLeaseRenewal } from "./fixtures/lease-renewal.mjs";

const CHILD = path.join(import.meta.dirname, "fixtures/e2e-bridge-child.mjs");
const SESSION = "bridge-session-1", OCCURRENCE = "123456789@2026-10-21T00:00:00Z", LEASE = "lease-1";
type Message = Record<string, unknown> & { type: string };

function startChild() {
  const root = mkdtempSync(path.join(os.tmpdir(), "scripted-bridge-protocol-"));
  const controlDir = path.join(root, "control"); mkdirSync(controlDir, { mode: 0o700 });
  const configPath = path.join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({ schema: "feishu-bridge-config/v2", controlDir, captureFrameLimit: 51, participants: [],
    custody: { physicalClientId: "slot-1", physicalGenerationId: "0".repeat(32), occurrenceId: OCCURRENCE, bridgeSessionId: SESSION } }), { mode: 0o600 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_OPTIONS"));
  const child = spawn(process.execPath, [CHILD, "--config", configPath], { stdio: ["pipe", "pipe", "ignore", "pipe"], env });
  const messages: Message[] = [], waiters: Array<() => void> = [];
  createInterface({ input: child.stdout! }).on("line", (line) => { messages.push(JSON.parse(line) as Message); for (const wake of waiters.splice(0)) wake(); });
  let outcome = "";
  (child.stdio[3] as Readable).on("data", (chunk: Buffer) => { outcome += chunk.toString("utf8"); });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  let commandNumber = 0;
  const send = (body: Record<string, unknown>, commandId = `c${++commandNumber}`) => {
    const line = JSON.stringify({ schema: "bridge-session/v2", sessionId: SESSION, commandId, ...body });
    (child.stdin as Writable).write(`${line}\n`); return commandId;
  };
  const resultsFor = (commandId: string) => messages.filter((row) => row.type === "command_result" && row.commandId === commandId);
  async function until(predicate: () => boolean, label: string) {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(messages)}`);
      await new Promise<void>((resolve) => { waiters.push(resolve); setTimeout(resolve, 50); });
    }
  }
  const result = async (commandId: string, count = 1) => { await until(() => resultsFor(commandId).length >= count, commandId); return resultsFor(commandId).at(-1)!; };
  const exit = () => Promise.race([exited, new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 10_000).unref())]);
  const state = () => readStateFile(path.join(controlDir, "state.json"));
  return { child, controlDir, state, messages, send, result, until, exit, outcome: () => outcome, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("leave mirrors the real bridge: media stops, left(removed) precedes an ok result, departure is confirmed", { timeout: 60_000 }, async () => {
  const c = startChild();
  try {
    const join = c.send({ type: "join", meetingOccurrenceId: OCCURRENCE, meetingNo: "123456789", leaseId: LEASE });
    assert.equal((await c.result(join)).outcome, "ok");
    const early = c.send({ type: "release_lease", leaseId: LEASE });
    assert.deepEqual([(await c.result(early)).outcome, (await c.result(early)).detail], ["rejected", "lease_not_releasable"]);
    const leave = c.send({ type: "leave", reason: "coordinator_stop" });
    const answer = await c.result(leave);
    assert.deepEqual([answer.outcome, answer.detail], ["ok", null]);
    const left = c.messages.findIndex((row) => row.type === "left");
    assert.ok(left >= 0 && left < c.messages.indexOf(answer), "left precedes the leave result");
    assert.equal(c.messages[left]!.reason, "removed");
    assert.ok(c.messages.findIndex((row) => row.type === "media_disconnected") < left, "media stops before left");
    // A repeated command ID replays its result without a second departure.
    c.send({ type: "leave", reason: "coordinator_stop" }, leave);
    const replay = await c.result(leave, 2);
    assert.deepEqual([replay.outcome, replay.detail], [answer.outcome, answer.detail]);
    assert.equal(c.messages.filter((row) => row.type === "left").length, 1);
    const media = c.send({ type: "connect_media", mediaLease: {} });
    assert.deepEqual([(await c.result(media)).outcome, (await c.result(media)).detail], ["rejected", "not_joined"]);
    const second = c.send({ type: "leave", reason: "coordinator_stop" });
    assert.deepEqual([(await c.result(second)).outcome, (await c.result(second)).detail], ["rejected", "not_joined"]);
    const wrong = c.send({ type: "release_lease", leaseId: "other" });
    assert.equal((await c.result(wrong)).outcome, "rejected");
    const release = c.send({ type: "release_lease", leaseId: LEASE });
    assert.deepEqual([(await c.result(release)).outcome, (await c.result(release)).detail], ["ok", null]);
    c.child.stdin!.end();
    assert.equal(await c.exit(), 0);
    assert.match(c.outcome(), /"outcome":"departure_confirmed"/);
  } finally { c.child.kill(); c.cleanup(); }
});

test("a non-join first command and a conflicting reused command ID are protocol failures", { timeout: 60_000 }, async () => {
  const first = startChild();
  try {
    first.send({ type: "connect_media", mediaLease: {} });
    assert.equal(await first.exit(), 9);
    assert.equal(first.messages.filter((row) => row.type === "command_result").length, 0);
  } finally { first.child.kill(); first.cleanup(); }
  const conflict = startChild();
  try {
    const join = conflict.send({ type: "join", meetingOccurrenceId: OCCURRENCE, meetingNo: "123456789", leaseId: LEASE });
    await conflict.result(join);
    conflict.send({ type: "leave", reason: "coordinator_stop" }, join);
    assert.equal(await conflict.exit(), 9);
  } finally { conflict.child.kill(); conflict.cleanup(); }
});

test("renew_media_lease is answered like the real bridge and a malformed one is a protocol failure", { timeout: 60_000 }, async () => {
  const c = startChild();
  try {
    const join = c.send({ type: "join", meetingOccurrenceId: OCCURRENCE, meetingNo: "123456789", leaseId: LEASE });
    assert.equal((await c.result(join)).outcome, "ok");
    const early = c.send({ type: "renew_media_lease", leaseRenewal: { sessionId: "41", expiresAtMs: "1120000" } });
    assert.deepEqual([(await c.result(early)).outcome, (await c.result(early)).detail], ["rejected", "media_not_connected"]);
    c.send({ type: "renew_media_lease", leaseRenewal: { sessionId: "41", expiresAtMs: "01" } });
    assert.equal(await c.exit(), 9);
  } finally { c.child.kill(); c.cleanup(); }
  const command = (renewal: unknown) => ({ schema: "bridge-session/v2", sessionId: SESSION, commandId: "r", type: "renew_media_lease", leaseRenewal: renewal });
  assert.equal(parseLeaseRenewal({ ...command({ sessionId: "41", expiresAtMs: "1" }), extra: true }), null);
  for (const renewal of [{ sessionId: "41" }, { sessionId: 41, expiresAtMs: "1" }, { sessionId: "0", expiresAtMs: "1" }, { sessionId: "41", expiresAtMs: "18446744073709551616" }, null]) {
    assert.equal(parseLeaseRenewal(command(renewal)), null, JSON.stringify(renewal));
  }
  const renewal = (expiresAtMs: bigint, sessionId = "41") => ({ sessionId, expiresAtMs });
  const lease = { sessionId: "41", expiresAtMs: 1_060_000n };
  assert.deepEqual(answerLeaseRenewal(null, renewal(2_000_000n), 1_000_000), { outcome: "rejected", detail: "media_not_connected" });
  assert.deepEqual(answerLeaseRenewal(lease, renewal(2_000_000n, "42"), 1_000_000), { outcome: "rejected", detail: "media_session_mismatch" });
  assert.deepEqual(answerLeaseRenewal(lease, renewal(1_050_000n), 1_000_000), { outcome: "rejected", detail: "lease_expiry_regressed" });
  assert.deepEqual(answerLeaseRenewal(lease, renewal(1_100_000n), 1_200_000), { outcome: "rejected", detail: "lease_expired" });
  assert.deepEqual(answerLeaseRenewal(lease, renewal(1_060_000n), 1_060_000), { outcome: "rejected", detail: "lease_expired" },
    "as Swift: an unchanged expiry that has passed is expired, not ok");
  assert.deepEqual(answerLeaseRenewal(lease, renewal(1_060_000n), 1_000_000), { outcome: "ok", detail: null }, "an unchanged live expiry is ok");
  assert.deepEqual(answerLeaseRenewal(lease, renewal(1_120_000n), 1_000_000), { outcome: "ok", detail: null });
  assert.equal(lease.expiresAtMs, 1_120_000n);
  assert.deepEqual(parseLeaseRenewal(command({ sessionId: "41", expiresAtMs: "1120000" })), renewal(1_120_000n));
});

// The provider-fault cuts require the bridge to see the meeting end itself and
// any leave to follow it. Real leave semantics must keep that oracle honest.
function noLeaveOracle(childState: unknown) {
  return providerFaultOracles({ cut: "provider-error", events: [], runtimeEvents: [], lifecycle: { rows: [] }, childState, snapshot: {}, artifact: null, summary: {} })
    .find((row: { name: string }) => row.name === "no_bridge_leave_on_provider_fault") as { status: string; detail: string };
}

test("after the observed meeting end the bridge is left: a later leave is rejected not_joined and the provider-fault leave oracle passes", { timeout: 60_000 }, async () => {
  const c = startChild();
  try {
    const join = c.send({ type: "join", meetingOccurrenceId: OCCURRENCE, meetingNo: "123456789", leaseId: LEASE });
    assert.equal((await c.result(join)).outcome, "ok");
    writeFileSync(path.join(c.controlDir, "end"), "ended");
    await c.until(() => c.messages.some((row) => row.type === "left"), "left(ended)");
    const leave = c.send({ type: "leave", reason: "meeting_ended" });
    assert.deepEqual([(await c.result(leave)).outcome, (await c.result(leave)).detail], ["rejected", "not_joined"]);
    assert.deepEqual(c.messages.filter((row) => row.type === "left").map((row) => row.reason), ["ended"]);
    const state = c.state();
    assert.equal(state.left, "ended");
    const row = noLeaveOracle(state);
    assert.equal(row.status, "pass", row.detail);
  } finally { c.child.kill(); c.cleanup(); }
});

test("a leave before the meeting end fails the provider-fault leave oracle", { timeout: 60_000 }, async () => {
  const c = startChild();
  try {
    const join = c.send({ type: "join", meetingOccurrenceId: OCCURRENCE, meetingNo: "123456789", leaseId: LEASE });
    assert.equal((await c.result(join)).outcome, "ok");
    const leave = c.send({ type: "leave", reason: "coordinator_stop" });
    assert.equal((await c.result(leave)).outcome, "ok");
    writeFileSync(path.join(c.controlDir, "end"), "ended");
    const row = noLeaveOracle(c.state());
    assert.equal(row.status, "fail");
  } finally { c.child.kill(); c.cleanup(); }
});
