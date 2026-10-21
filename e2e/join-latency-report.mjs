// Offline, read-only join-latency breakdown over retained run roots.
//   node e2e/join-latency-report.mjs [--json] <run-root>...
// Uses whatever a root retained: the entry's monotonic log rows, the new
// join-timing rows, the Runtime observer's wire rows, the harness's voice
// events, the bridge child's clocks and (opened immutable, read-only) the
// orchestration database's join transition and lease. It prints clocks and
// phase tokens only. Database times are wall milliseconds, mapped onto the
// monotonic axis through the entry's own runtime-connected row (±1 ms).
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { JOIN_TIMING_FILE, joinLatencyEvidence } from "./join-latency-evidence.mjs";

const DECIMAL = /^[0-9]{1,20}$/;
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const mono = value => typeof value === "string" && DECIMAL.test(value) ? BigInt(value) : null;
const ms = (from, to) => from === null || to === null ? null : Math.round(Number(to - from) / 1000) / 1000;

/** Pure: one run's anchors in ms after the Meeting process logged `occurrence_runtime_connected`. */
export function analyseRun({ events = [], lifecycle = [], runtimeEvents = [], child = null, meetingPhases = [], db = null } = {}) {
  const connected = events.find(row => isObject(row) && row.name === "log" && row.code === "occurrence_runtime_connected");
  const origin = mono(connected?.monotonicNs);
  if (origin === null) return { usable: false, reason: "no_runtime_connected_row" };
  const connectedWallMs = Date.parse(connected.at);
  const fromWall = wallMs => Number.isFinite(wallMs) && Number.isFinite(connectedWallMs) ? wallMs - connectedWallMs : null;
  const rows = lifecycle.filter(isObject);
  const statusCommand = rows.find(row => row.event === "client_command" && row.type === "status" && row.request_id);
  const statusReply = statusCommand ? rows.find(row => row.event === "gateway_message" && row.request_id === statusCommand.request_id) : undefined;
  const startCommand = rows.find(row => row.event === "client_command" && /^start_/.test(row.type ?? ""));
  const voice = runtimeEvents.find(row => isObject(row) && row.type === "voice_session_started");
  const anchors = {
    statusReplyMs: ms(origin, mono(statusReply?.monotonicNs)),
    joiningMs: fromWall(db?.joiningAtMs), leaseMs: fromWall(db?.leaseAcquiredAtMs),
    startCommandMs: ms(origin, mono(startCommand?.monotonicNs)),
    voiceStartedMs: ms(origin, mono(voice?.monotonicNs)),
    l4OriginMs: isObject(child?.l4?.origin) ? ms(origin, mono(child.l4.origin.hostNs)) : null,
  };
  const instrumented = meetingPhases.length > 0 ? joinLatencyEvidence({ meeting: { status: "present", rows: meetingPhases }, child, lifecycleRows: lifecycle, runtimeEvents }) : null;
  const joinAt = anchors.joiningMs ?? instrumented?.phases.find(row => row.phase === "join_entered")?.ms ?? null;
  const segment = (a, b) => a === null || b === null ? null : Math.round((b - a) * 1000) / 1000;
  return {
    usable: true, anchors,
    segments: {
      statusReplyToConnected: anchors.statusReplyMs === null ? null : -anchors.statusReplyMs,
      connectedToJoining: joinAt,
      joiningToStartCommand: segment(joinAt, anchors.startCommandMs),
      startCommandToVoiceStarted: segment(anchors.startCommandMs, anchors.voiceStartedMs),
      connectedToVoiceStarted: anchors.voiceStartedMs,
    },
    instrumented,
  };
}

function ndjson(filename) {
  try { return readFileSync(filename, "utf8").split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
function json(filename) { try { return JSON.parse(readFileSync(filename, "utf8")); } catch { return null; } }
function stagedRoots(root) {
  const base = path.join(root, "private-tmp");
  try { return readdirSync(base).filter(name => name.startsWith("meeting-e2e-")).map(name => path.join(base, name)); } catch { return []; }
}
async function readDb(filename) {
  try { statSync(filename); } catch { return null; }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(`file:${encodeURI(filename)}?mode=ro&immutable=1`, { readOnly: true });
  try {
    const joining = db.prepare("SELECT min(occurred_at_ms) AS at FROM transitions WHERE to_state = 'joining'").get();
    const lease = db.prepare("SELECT min(acquired_at_ms) AS at FROM bridge_leases").get();
    return { joiningAtMs: typeof joining?.at === "number" ? joining.at : null, leaseAcquiredAtMs: typeof lease?.at === "number" ? lease.at : null };
  } catch { return null; } finally { db.close(); }
}

/** Reads one retained root without writing anything. */
export async function readRunRoot(root) {
  const staged = stagedRoots(root);
  if (staged.length !== 1) return { root, usable: false, reason: staged.length === 0 ? "no_staged_root" : "several_staged_roots" };
  const control = path.join(staged[0], "bridge-control");
  const retainedEvents = path.join(root, "application", "events.ndjson");
  const events = ndjson(retainedEvents).length > 0 ? ndjson(retainedEvents) : ndjson(path.join(control, "events.ndjson"));
  const run = analyseRun({ events, lifecycle: ndjson(path.join(control, "runtime-lifecycle.ndjson")), runtimeEvents: ndjson(path.join(control, "runtime-events.ndjson")),
    child: json(path.join(control, "state.json")), meetingPhases: ndjson(path.join(control, JOIN_TIMING_FILE)), db: await readDb(path.join(staged[0], "state", "orchestration.db")) });
  return { root, ...run };
}

function quantile(sorted, q) { return sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]; }
export function summarise(runs) {
  const usable = runs.filter(run => run.usable);
  const names = ["statusReplyToConnected", "connectedToJoining", "joiningToStartCommand", "startCommandToVoiceStarted", "connectedToVoiceStarted"];
  const segments = Object.fromEntries(names.map(name => {
    const values = usable.map(run => run.segments[name]).filter(value => typeof value === "number").sort((a, b) => a - b);
    return [name, { n: values.length, min: values[0] ?? null, median: quantile(values, 0.5), p90: quantile(values, 0.9), max: values.at(-1) ?? null }];
  }));
  return { runs: runs.length, usable: usable.length, instrumented: usable.filter(run => run.instrumented !== null).length, segments };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2), asJson = args[0] === "--json";
  const roots = asJson ? args.slice(1) : args;
  const runs = [];
  for (const root of roots) runs.push(await readRunRoot(root));
  const summary = summarise(runs);
  if (asJson) process.stdout.write(`${JSON.stringify({ summary, runs }, null, 1)}\n`);
  else {
    const fmt = value => value === null || value === undefined ? "-" : String(value);
    process.stdout.write("root\tstatusReply->connected\tconnected->joining\tjoining->start\tstart->voice\tconnected->voice\tl4Origin\tinstrumented\n");
    for (const run of runs) {
      if (!run.usable) { process.stdout.write(`${path.basename(run.root)}\tunusable:${run.reason}\n`); continue; }
      const s = run.segments;
      process.stdout.write([path.basename(run.root), s.statusReplyToConnected, s.connectedToJoining, s.joiningToStartCommand, s.startCommandToVoiceStarted,
        s.connectedToVoiceStarted, run.anchors.l4OriginMs, run.instrumented ? "yes" : "no"].map(fmt).join("\t") + "\n");
    }
    process.stdout.write(`\n${JSON.stringify(summary, null, 1)}\n`);
  }
}
