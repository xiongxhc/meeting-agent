// Where the time between a connected Runtime and the bridge `join` goes.
// Meeting phase rows come from the test entry's observer (the composition's
// private `joinTiming` option); the bridge child adds its own start/receipt
// clocks to state.json. Rows hold fixed phase tokens, pids and clocks only.
// Recording is best effort: a write failure disables it once and never fails
// or delays the run.
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";

export const JOIN_TIMING_FILE = "join-timing.ndjson";

// Canonical order of src/sessions/join-timing.ts JOIN_TIMING_PHASES.
export const MEETING_PHASES = Object.freeze([
  "runtime_connected", "create_session_entered", "custody_claimed", "bridge_launch_started", "bridge_launch_returned",
  "session_construct_started", "vault_index_started", "vault_index_built", "session_constructed", "session_created",
  "join_called", "join_entered", "lease_acquired", "reconciliation_started", "timed_control_ready", "subscriptions_ready",
  "join_send_started", "join_send_resolved", "runtime_admission_started", "runtime_admission_resolved",
  "connect_media_send_started", "join_settled",
]);
// Every join reaches these before the bridge `join` is written.
const REQUIRED = MEETING_PHASES.slice(0, MEETING_PHASES.indexOf("join_send_started") + 1).filter(phase => !phase.startsWith("vault_"));
const RANK = new Map(MEETING_PHASES.map((phase, index) => [phase, index]));
const DECIMAL = /^[0-9]{1,20}$/;
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

/** The entry-side observer: timestamp first, buffer in memory, write once when the join settles (or on flush). */
export function createJoinTimingRecorder({ filename, clock = () => process.hrtime.bigint(), wall = () => Date.now(), write = appendFileSync, limit = 256 }) {
  const rows = [];
  let open = true, recorded = 0, settled = false;
  function flush() {
    if (!open || rows.length === 0) return;
    const text = rows.map(row => `${JSON.stringify(row)}\n`).join("");
    rows.length = 0;
    try { write(filename, text, { mode: 0o600 }); } catch { open = false; }
  }
  function observe(phase) {
    const monotonicNs = clock();
    if (!open) return;
    if (recorded >= limit) { open = false; rows.length = 0; return; }
    recorded += 1;
    rows.push({ event: "meeting_phase", phase: RANK.has(phase) ? phase : "unrecognized", pid: process.pid, at: wall(), monotonicNs: String(monotonicNs) });
    // The vault mark can land after the join settles; write it then too, so a
    // later signal kill cannot lose it. Before the join settles, never write.
    if (phase === "join_settled") { settled = true; flush(); } else if (phase === "vault_index_built" && settled) flush();
  }
  return { observe, flush };
}

/** The bridge child's own clocks. `processStartNs` is derived from the
 * process's performance origin, so it includes Node startup. */
export function childStartClocks(hrtime = () => process.hrtime.bigint(), elapsedMs = () => performance.now()) {
  const now = hrtime();
  return { processStartNs: String(now - BigInt(Math.round(elapsedMs() * 1e6))), moduleStartNs: String(now), linesReadyNs: null, joinReceivedNs: null };
}

export function readJoinTimingRows(filename) {
  let text;
  try { text = readFileSync(filename, "utf8"); }
  catch (error) { return { status: error?.code === "ENOENT" ? "absent" : "unreadable", rows: [] }; }
  try { return { status: "present", rows: text.split("\n").filter(Boolean).map(line => JSON.parse(line)) }; }
  catch { return { status: "unreadable", rows: [] }; }
}

const clock = value => typeof value === "string" && DECIMAL.test(value) ? BigInt(value) : null;
const ms = (from, to) => from === null || to === null ? null : Math.round(Number(to - from) / 1000) / 1000;

/** Bundle projection: one row per Meeting phase of the first join attempt, in
 * milliseconds after `runtime_connected`, plus the child and wire anchors.
 * `vault_index_built` marks an asynchronous build settling; it may land at any
 * point (even after the join settles), so it is kept out of the ordered chain. */
export function joinLatencyEvidence({ meeting = { status: "absent", rows: [] }, child = null, lifecycleRows = [], runtimeEvents = [] } = {}) {
  const all = (Array.isArray(meeting.rows) ? meeting.rows : []).filter(row => isObject(row) && row.event === "meeting_phase");
  const startIndex = all.findIndex(row => row.phase === "runtime_connected");
  const after = startIndex < 0 ? [] : all.slice(startIndex);
  const settledIndex = after.findIndex(row => row.phase === "join_settled");
  const attempt = (settledIndex < 0 ? after : after.slice(0, settledIndex + 1)).filter(row => row.phase !== "vault_index_built");
  const vaultBuilt = attempt.some(row => row.phase === "vault_index_started")
    ? after.find(row => row.phase === "vault_index_built" && row.pid === attempt[0]?.pid) ?? null : null;
  const origin = clock(attempt[0]?.monotonicNs);
  const phases = attempt.map(row => ({ phase: row.phase, ms: ms(origin, clock(row.monotonicNs)) }));
  const seen = attempt.map(row => row.phase);
  let ordered = attempt.length > 0 && new Set(attempt.map(row => row.pid)).size === 1;
  for (let index = 1; ordered && index < attempt.length; index += 1) {
    const previous = attempt[index - 1], current = attempt[index];
    const a = clock(previous.monotonicNs), b = clock(current.monotonicNs);
    if (a === null || b === null || b < a || !RANK.has(current.phase) || RANK.get(current.phase) <= RANK.get(previous.phase)) ordered = false;
  }
  const complete = ordered && REQUIRED.every(phase => seen.includes(phase));
  const builtMs = vaultBuilt === null ? null : ms(origin, clock(vaultBuilt.monotonicNs));
  const at = phase => phase === "vault_index_built" ? builtMs : phases.find(row => row.phase === phase)?.ms ?? null;
  const between = (from, to) => { const a = at(from), b = at(to); return a === null || b === null ? null : Math.round((b - a) * 1000) / 1000; };

  const timing = isObject(child) && isObject(child.joinTiming) ? child.joinTiming : null;
  const childAt = key => ms(origin, clock(timing?.[key]));
  const startCommand = (Array.isArray(lifecycleRows) ? lifecycleRows : []).find(row => isObject(row) && row.event === "client_command" && /^start_/.test(row.type ?? ""));
  const voiceStart = (Array.isArray(runtimeEvents) ? runtimeEvents : []).find(row => isObject(row) && row.type === "voice_session_started");
  return {
    schema: "meeting-join-latency-evidence/v1",
    status: meeting.status, rows: all.length, attempts: all.filter(row => row.phase === "join_entered").length,
    complete, ordered, settled: settledIndex >= 0,
    phases,
    vault: seen.includes("vault_index_started") ? { builtMs, settledBeforeJoinSend: builtMs !== null && at("join_send_started") !== null ? builtMs <= at("join_send_started") : null } : null,
    segments: {
      createSession: between("runtime_connected", "session_created"),
      custodyClaim: between("create_session_entered", "custody_claimed"),
      bridgeLaunch: between("bridge_launch_started", "bridge_launch_returned"),
      sessionConstruct: between("session_construct_started", "session_constructed"),
      vaultIndex: between("vault_index_started", "vault_index_built"),
      joinPrelude: between("join_entered", "join_send_started"),
      leaseAcquire: between("join_entered", "lease_acquired"),
      joinSend: between("join_send_started", "join_send_resolved"),
      runtimeAdmission: between("runtime_admission_started", "runtime_admission_resolved"),
      connectedToJoinSend: at("join_send_started"),
    },
    child: timing === null ? null : {
      processStartMs: childAt("processStartNs"), moduleStartMs: childAt("moduleStartNs"),
      linesReadyMs: childAt("linesReadyNs"), joinReceivedMs: childAt("joinReceivedNs"),
      joinSendToReceiptMs: (() => { const s = at("join_send_started"), r = childAt("joinReceivedNs"); return s === null || r === null ? null : Math.round((r - s) * 1000) / 1000; })(),
      l4OriginMs: isObject(child.l4) && isObject(child.l4.origin) ? ms(origin, clock(child.l4.origin.hostNs)) : null,
    },
    wire: { startCommandMs: ms(origin, clock(startCommand?.monotonicNs)), voiceStartedMs: ms(origin, clock(voiceStart?.monotonicNs)) },
  };
}

function ndjson(filename) {
  try { return readFileSync(filename, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; }
}

/** run.mjs wiring: the bridge control directory plus the child state already read. */
export function joinLatencyFromControl(controlDir, { childState = null } = {}) {
  const valid = typeof controlDir === "string";
  return joinLatencyEvidence({
    meeting: valid ? readJoinTimingRows(path.join(controlDir, JOIN_TIMING_FILE)) : { status: "absent", rows: [] },
    child: childState,
    lifecycleRows: valid ? ndjson(path.join(controlDir, "runtime-lifecycle.ndjson")) : [],
    runtimeEvents: valid ? ndjson(path.join(controlDir, "runtime-events.ndjson")) : [],
  });
}
