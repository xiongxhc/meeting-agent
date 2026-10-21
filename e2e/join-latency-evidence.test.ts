import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JOIN_TIMING_PHASES } from "../src/sessions/join-timing.ts";
// @ts-expect-error Private harness JavaScript has no public declaration.
import { JOIN_TIMING_FILE, MEETING_PHASES, childStartClocks, createJoinTimingRecorder, joinLatencyEvidence, joinLatencyFromControl } from "./join-latency-evidence.mjs";
// @ts-expect-error Private harness JavaScript has no public declaration.
import { analyseRun, readRunRoot, summarise } from "./join-latency-report.mjs";

type Row = { event: string; phase: string; pid: number; at: number; monotonicNs: string };
const row = (phase: string, ns: bigint, pid = 7): Row => ({ event: "meeting_phase", phase, pid, at: 0, monotonicNs: ns.toString() });
const fullRows = (start = 1_000_000_000n, step = 1_000_000n): Row[] => (MEETING_PHASES as string[]).map((phase, index) => row(phase, start + BigInt(index) * step));

test("the e2e phase list is exactly the src phase list in canonical order", () => {
  assert.deepEqual([...MEETING_PHASES], [...JOIN_TIMING_PHASES]);
});

test("the recorder timestamps before anything else, buffers, and writes once when the join settles", () => {
  const writes: string[] = []; let now = 10n;
  const recorder = createJoinTimingRecorder({ filename: "/synthetic", clock: () => (now += 5n), wall: () => 1, write: (_file: string, text: string) => { writes.push(text); } });
  recorder.observe("runtime_connected"); recorder.observe("join_entered"); recorder.observe("not-a-phase");
  assert.equal(writes.length, 0, "no I/O on the join path before it settles");
  recorder.observe("join_settled");
  assert.equal(writes.length, 1);
  const rows = writes[0]!.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(rows.map(r => r.phase), ["runtime_connected", "join_entered", "unrecognized", "join_settled"]);
  assert.deepEqual(rows.map(r => r.monotonicNs), ["15", "20", "25", "30"]);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["at", "event", "monotonicNs", "phase", "pid"]);
  recorder.flush(); assert.equal(writes.length, 1, "nothing left to flush");
});

test("a recorder write failure disables recording once and never throws; the row limit closes it", () => {
  let attempts = 0;
  const failing = createJoinTimingRecorder({ filename: "/synthetic", write: () => { attempts += 1; throw new Error("disk"); } });
  failing.observe("runtime_connected"); assert.doesNotThrow(() => failing.observe("join_settled"));
  failing.observe("runtime_connected"); failing.observe("join_settled"); assert.equal(attempts, 1);
  const writes: string[] = [];
  const limited = createJoinTimingRecorder({ filename: "/synthetic", limit: 2, write: (_f: string, text: string) => { writes.push(text); } });
  limited.observe("runtime_connected"); limited.observe("join_entered"); limited.observe("join_settled"); limited.flush();
  assert.deepEqual(writes, [], "an over-limit attempt is dropped whole, never written truncated");
});

test("the child clocks derive process start from the performance origin", () => {
  const clocks = childStartClocks(() => 5_000_000_000n, () => 250.5);
  assert.deepEqual(clocks, { processStartNs: "4749500000", moduleStartNs: "5000000000", linesReadyNs: null, joinReceivedNs: null });
});

test("a full ordered first attempt is complete and segments are measured from runtime_connected", () => {
  const rows = [...fullRows(), row("join_entered", 9_000_000_000n)]; // a later recovery attempt is not part of the first join
  const child = { joinTiming: { processStartNs: "1002000000", moduleStartNs: "1040000000", linesReadyNs: "1060000000", joinReceivedNs: "1017500000" }, l4: { origin: { hostNs: "1041000000" } } };
  const evidence = joinLatencyEvidence({ meeting: { status: "present", rows }, child,
    lifecycleRows: [{ event: "client_command", type: "start_drainable_timed_voice_session", monotonicNs: "1018000000" }],
    runtimeEvents: [{ type: "voice_session_started", monotonicNs: "1019500000" }] });
  assert.equal(evidence.complete, true); assert.equal(evidence.ordered, true); assert.equal(evidence.settled, true);
  assert.equal(evidence.attempts, 2);
  assert.deepEqual(evidence.phases.map((p: { phase: string }) => p.phase), [...MEETING_PHASES]);
  assert.equal(evidence.segments.connectedToJoinSend, MEETING_PHASES.indexOf("join_send_started"));
  assert.equal(evidence.segments.vaultIndex, 1);
  assert.equal(evidence.child?.joinSendToReceiptMs, 1.5);
  assert.equal(evidence.child?.processStartMs, 2); assert.equal(evidence.child?.l4OriginMs, 41);
  assert.deepEqual(evidence.wire, { startCommandMs: 18, voiceStartedMs: 19.5 });
});

test("a missing required phase, a lone vault mark, a clock regression, a phase regression or a second pid is not complete", () => {
  const full = fullRows();
  const without = (phase: string) => full.filter(r => r.phase !== phase);
  assert.equal(joinLatencyEvidence({ meeting: { status: "present", rows: without("lease_acquired") } }).complete, false);
  assert.equal(joinLatencyEvidence({ meeting: { status: "present", rows: without("vault_index_built") } }).complete, false);
  assert.equal(joinLatencyEvidence({ meeting: { status: "present", rows: without("vault_index_built").filter(r => r.phase !== "vault_index_started") } }).complete, true);
  const clockBack = full.map((r, i) => i === 5 ? { ...r, monotonicNs: "1" } : r);
  assert.equal(joinLatencyEvidence({ meeting: { status: "present", rows: clockBack } }).ordered, false);
  const swapped = [...full]; [swapped[3], swapped[4]] = [swapped[4]!, swapped[3]!];
  assert.equal(joinLatencyEvidence({ meeting: { status: "present", rows: swapped } }).ordered, false);
  // Clocks still increase but two phases arrive out of canonical order.
  const phaseBack = full.map((r, i) => i === 3 ? { ...r, phase: full[4]!.phase } : i === 4 ? { ...r, phase: full[3]!.phase } : r);
  assert.equal(joinLatencyEvidence({ meeting: { status: "present", rows: phaseBack } }).ordered, false);
  const repeated = full.map((r, i) => i === 4 ? { ...r, phase: full[3]!.phase } : r);
  assert.equal(joinLatencyEvidence({ meeting: { status: "present", rows: repeated } }).ordered, false);
  assert.equal(joinLatencyEvidence({ meeting: { status: "present", rows: full.map((r, i) => i === 2 ? { ...r, pid: 8 } : r) } }).complete, false);
  const absent = joinLatencyFromControl(undefined);
  assert.equal(absent.status, "absent"); assert.equal(absent.complete, false); assert.equal(absent.child, null);
});

function syntheticRoot(withPhases: boolean) {
  const root = mkdtempSync(path.join(os.tmpdir(), "join-latency-root-"));
  const staged = path.join(root, "private-tmp", "meeting-e2e-abc123"), control = path.join(staged, "bridge-control");
  mkdirSync(control, { recursive: true }); mkdirSync(path.join(staged, "state")); mkdirSync(path.join(root, "application"));
  writeFileSync(path.join(root, "application", "events.ndjson"),
    `${JSON.stringify({ at: "2026-10-07T13:56:07.834Z", monotonicNs: "5000000000", name: "log", code: "occurrence_runtime_connected" })}\n`);
  writeFileSync(path.join(control, "runtime-lifecycle.ndjson"), [
    { event: "client_command", type: "status", request_id: "request-2", monotonicNs: "4999700000" },
    { event: "gateway_message", type: "status", request_id: "request-2", monotonicNs: "4999800000" },
    { event: "client_command", type: "start_drainable_timed_voice_session", request_id: "request-3", monotonicNs: "5503000000" },
  ].map(r => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(path.join(control, "runtime-events.ndjson"), `${JSON.stringify({ type: "voice_session_started", monotonicNs: "5504500000" })}\n`);
  writeFileSync(path.join(control, "state.json"), JSON.stringify({ joined: true }));
  if (withPhases) writeFileSync(path.join(control, JOIN_TIMING_FILE), fullRows(5_000_000_000n).map(r => JSON.stringify(r)).join("\n") + "\n");
  const db = new DatabaseSync(path.join(staged, "state", "orchestration.db"));
  db.exec("CREATE TABLE transitions (to_state TEXT, occurred_at_ms INTEGER); CREATE TABLE bridge_leases (acquired_at_ms INTEGER);");
  const wall = Date.parse("2026-10-07T13:56:07.834Z");
  db.prepare("INSERT INTO transitions VALUES ('joining', ?)").run(wall + 500); db.prepare("INSERT INTO bridge_leases VALUES (?)").run(wall + 500);
  db.close();
  return root;
}

test("the analyser reads a retained root read-only and splits the window with whatever anchors exist", async () => {
  const root = syntheticRoot(false);
  try {
    const db = path.join(root, "private-tmp", "meeting-e2e-abc123", "state", "orchestration.db");
    chmodSync(db, 0o400); const before = readFileSync(db);
    const run = await readRunRoot(root);
    assert.equal(run.usable, true);
    assert.deepEqual(run.segments, { statusReplyToConnected: 0.2, connectedToJoining: 500, joiningToStartCommand: 3, startCommandToVoiceStarted: 1.5, connectedToVoiceStarted: 504.5 });
    assert.equal(run.instrumented, null);
    assert.deepEqual(readFileSync(db), before, "database bytes unchanged");
    const summary = summarise([run, { root: "x", usable: false, reason: "no_staged_root" }]);
    assert.equal(summary.usable, 1); assert.equal(summary.segments.connectedToJoining.median, 500);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the analyser prefers the instrumented join_entered when present and reports the per-phase projection", async () => {
  const root = syntheticRoot(true);
  try {
    const run = await readRunRoot(root);
    assert.equal(run.instrumented?.complete, true);
    assert.equal(run.segments.connectedToJoining, 500, "the database join wins when both exist");
    const noDb = analyseRun({ events: [{ name: "log", code: "occurrence_runtime_connected", at: "2026-10-07T13:56:07.834Z", monotonicNs: "5000000000" }],
      meetingPhases: fullRows(5_000_000_000n) });
    assert.equal(noDb.segments.connectedToJoining, MEETING_PHASES.indexOf("join_entered"));
    assert.deepEqual(analyseRun({ events: [] }), { usable: false, reason: "no_runtime_connected_row" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the real bridge child records ordered start, readiness and join-receipt clocks in state.json", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "join-latency-child-"));
  try {
    const control = path.join(root, "control"); mkdirSync(control, { mode: 0o700 });
    const configPath = path.join(root, "config.json");
    const custody = { physicalClientId: "mac", physicalGenerationId: "0".repeat(32), occurrenceId: "occ", bridgeSessionId: "b".repeat(32) };
    writeFileSync(configPath, JSON.stringify({ controlDir: control, custody, participants: [] }), { mode: 0o600 });
    const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/e2e-bridge-child.mjs", import.meta.url)), "--config", configPath],
      { stdio: ["pipe", "pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });
    child.stdout.resume(); child.stderr.resume(); (child.stdio[3] as NodeJS.ReadableStream).resume();
    const exited = new Promise<number | null>(resolve => child.on("close", code => resolve(code)));
    child.stdin.write(`${JSON.stringify({ schema: "bridge-session/v2", sessionId: custody.bridgeSessionId, type: "join", commandId: "c1", meetingOccurrenceId: "occ", meetingNo: "1", leaseId: "l" })}\n`);
    const deadline = Date.now() + 10_000;
    let state: { joined?: boolean; joinTiming?: Record<string, string | null> } | null = null;
    while (Date.now() < deadline) {
      try { state = JSON.parse(readFileSync(path.join(control, "state.json"), "utf8")); } catch { state = null; }
      if (state?.joined) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    child.stdin.end(); await exited;
    assert.equal(state?.joined, true);
    const t = state!.joinTiming!;
    const [start, module, ready, received] = [t.processStartNs, t.moduleStartNs, t.linesReadyNs, t.joinReceivedNs].map(v => BigInt(v!));
    assert.ok(start! <= module! && module! <= ready! && ready! <= received!, JSON.stringify(t));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// F2: the event the campaign exists to catch. An L4 child whose first scripted
// row is already due refuses the join (prepareJoin throws, exit 10); the
// dispose -> onState -> persist path must still leave joinReceivedNs on disk.
async function l4Child(delayBeforeJoinMs: number) {
  const root = mkdtempSync(path.join(os.tmpdir(), "join-latency-l4-child-"));
  try {
    const control = path.join(root, "control"); mkdirSync(control, { mode: 0o700 });
    const configPath = path.join(root, "config.json");
    const custody = { physicalClientId: "mac", physicalGenerationId: "0".repeat(32), occurrenceId: "occ", bridgeSessionId: "b".repeat(32) };
    writeFileSync(configPath, JSON.stringify({ controlDir: control, custody, l4Case: "sent-drop" }), { mode: 0o600 });
    const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/e2e-bridge-child.mjs", import.meta.url)), "--config", configPath],
      { stdio: ["pipe", "pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });
    child.stdout.resume(); child.stderr.resume(); (child.stdio[3] as NodeJS.ReadableStream).resume();
    const exited = new Promise<number | null>(resolve => child.on("close", code => resolve(code)));
    await new Promise(resolve => setTimeout(resolve, delayBeforeJoinMs));
    child.stdin.write(`${JSON.stringify({ schema: "bridge-session/v2", sessionId: custody.bridgeSessionId, type: "join", commandId: "c1", meetingOccurrenceId: "occ", meetingNo: "1", leaseId: "l" })}\n`);
    const deadline = Date.now() + 10_000;
    let state: { joined?: boolean } | null = null;
    while (Date.now() < deadline && child.exitCode === null) {
      try { state = JSON.parse(readFileSync(path.join(control, "state.json"), "utf8")); } catch { state = null; }
      if (state?.joined) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    child.stdin.end();
    const code = await exited;
    return { code, state: JSON.parse(readFileSync(path.join(control, "state.json"), "utf8")) };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("a refused late L4 join still persists its join-receipt clock through the dispose path", async () => {
  const late = await l4Child(1500);
  assert.equal(late.code, 10);
  assert.equal(late.state.joined, false);
  assert.deepEqual(late.state.commands, ["join"]);
  assert.deepEqual(late.state.physicalOutcomeScenario, { mode: "normal", phase: "closed_missing", cause: "disposed" });
  const t = late.state.joinTiming;
  assert.equal(typeof t.joinReceivedNs, "string");
  assert.ok(BigInt(t.linesReadyNs) <= BigInt(t.joinReceivedNs));
  assert.ok(BigInt(t.joinReceivedNs) - BigInt(late.state.l4.origin.hostNs) >= 1_000_000_000n, "received after the first scripted row was due");
  const timely = await l4Child(0); // same config, prompt join: admitted, so the refusal above is lateness alone
  assert.equal(timely.state.joined, true);
  assert.ok(BigInt(timely.state.joinTiming.joinReceivedNs) - BigInt(timely.state.l4.origin.hostNs) < 1_000_000_000n);
});
