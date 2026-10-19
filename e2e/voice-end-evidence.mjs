// Why a live voice session ended, from control-pipe order the pinned Runtime
// already emits. Rows keep enum tokens, request ids, counters and clocks only:
// never failure messages, media leases, status payloads, text or audio.
import { readFileSync } from "node:fs";
import path from "node:path";

export const LIFECYCLE_FILE = "runtime-lifecycle.ndjson";

const TOKEN = /^[a-z_]{1,64}$/, REQUEST = /^request-[0-9]{1,20}$/, DECIMAL = /^[0-9]{1,20}$/, SIGNAL = /^SIG[A-Z0-9]{1,16}$/;
const VOICE_TYPES = new Set(["voice_session_started", "voice_session_ended", "voice_session_failed"]);
const LEAVE_REASONS = new Set(["meeting_ended", "coordinator_stop"]);
const STOP_COMMANDS = new Set(["stop_voice_session", "finalize_recording"]);
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const token = value => typeof value === "string" && TOKEN.test(value) ? value : null;
const failure = error => isObject(error) ? { code: token(error.code), kind: token(error.kind), stage: token(error.stage) } : null;
const requestId = frame => typeof frame.request_id === "string" && REQUEST.test(frame.request_id) ? { request_id: frame.request_id } : {};

/** One client->gateway frame: its command type and request id. */
export function clientCommandRow(frame) {
  if (!isObject(frame)) return { event: "client_command", type: "unrecognized" };
  return { event: "client_command", type: token(frame.type) ?? "unrecognized", ...requestId(frame) };
}

/** One gateway->client frame, or null for voice events that do not bound a session. */
export function gatewayMessageRow(frame) {
  if (!isObject(frame)) return null;
  if (frame.type === "voice_event") {
    const event = frame.event;
    if (!isObject(event) || !VOICE_TYPES.has(event.type)) return null;
    return { event: "voice", type: event.type,
      ...(typeof event.session_id === "string" && DECIMAL.test(event.session_id) ? { session_id: event.session_id } : {}),
      ...(event.type === "voice_session_failed" ? { recovery: token(event.recovery), error: failure(event.error) } : {}) };
  }
  return { event: "gateway_message", type: token(frame.type) ?? "unrecognized", ...requestId(frame),
    ...(frame.type === "command_rejected" || frame.type === "fatal" ? { error: failure(frame.error) } : {}) };
}

export function gatewayExitRow(code, signal) {
  return { event: "gateway_exit", code: Number.isInteger(code) ? code : null, signal: typeof signal === "string" && SIGNAL.test(signal) ? signal : null };
}

/** The scripted bridge child's first `leave`, with its declared reason only. */
export function bridgeLeaveFact(reason, monotonicNs) {
  return { reason: LEAVE_REASONS.has(reason) ? reason : "other", monotonicNs: String(monotonicNs) };
}

/** Missing or unparseable evidence is a reported status, never a thrown run failure. */
export function readVoiceEndRows(filename) {
  let text;
  try { text = readFileSync(filename, "utf8"); }
  catch (error) { return { status: error?.code === "ENOENT" ? "absent" : "unreadable", rows: [] }; }
  try { return { status: "present", rows: text.split("\n").filter(Boolean).map(line => JSON.parse(line)) }; }
  catch { return { status: "unreadable", rows: [] }; }
}

function clock(row) {
  if (!isObject(row) || typeof row.monotonicNs !== "string" || !DECIMAL.test(row.monotonicNs)) return null;
  return BigInt(row.monotonicNs);
}
function elapsedMs(from, to) {
  const a = clock(from), b = clock(to);
  return a === null || b === null ? null : Math.round(Number(b - a) / 1000) / 1000;
}
const firstIndex = (rows, predicate, from = 0, to = rows.length) => {
  for (let index = from; index < to; index += 1) if (predicate(rows[index])) return index;
  return -1;
};
const lastOf = (rows, predicate) => [...rows].reverse().find(predicate) ?? null;

/** Bundle projection: which side ended the live voice session, how the Runtime closed,
 * whether the online provider was contacted and how the bridge left. */
export function voiceEndEvidence({ lifecycle = { status: "absent", rows: [] }, bridge = null, interactiveConnections = null, interactiveCalls = [] } = {}) {
  const all = (Array.isArray(lifecycle.rows) ? lifecycle.rows : []).filter(isObject);
  const pids = [...new Set(all.map(row => row.observerPid))];
  const isStart = row => row.event === "voice" && row.type === "voice_session_started";
  const selected = pids.find(pid => all.some(row => row.observerPid === pid && isStart(row))) ?? pids[0];
  const rows = all.filter(row => row.observerPid === selected);

  const startIndex = firstIndex(rows, isStart);
  const start = rows[startIndex] ?? null;
  // End and failure rows must belong to the started session when it named one.
  const session = start?.session_id;
  const sameSession = row => session === undefined || row.session_id === session;
  const endIndex = firstIndex(rows, row => row.event === "voice" && sameSession(row) &&
    (row.type === "voice_session_ended" || row.type === "voice_session_failed" && row.recovery === "new_session"), startIndex + 1);
  const end = rows[endIndex] ?? null;
  const beforeEnd = end === null ? rows : rows.slice(0, endIndex);
  const live = end === null ? [] : rows.slice(startIndex + 1, endIndex);
  const commands = new Map(rows.filter(row => row.event === "client_command" && row.request_id).map(row => [row.request_id, row.type]));

  const initiator = live.find(row => row.event === "client_command" && STOP_COMMANDS.has(row.type) || row.event === "client_eof" || row.event === "observer_signal") ?? null;
  // A stop that loses the race to a Runtime end is rejected (SDK: already_terminal); its reply may follow the end.
  const reply = initiator?.event === "client_command" && initiator.request_id
    ? rows.find(row => row.event === "gateway_message" && row.request_id === initiator.request_id &&
      ["command_accepted", "recording_finalized", "command_rejected"].includes(row.type)) ?? null : null;
  const initiatorOutcome = reply === null ? "none" : reply.type === "command_rejected" ? "rejected" : "accepted";
  const decodeFailedBeforeEnd = end !== null && beforeEnd.some(row => row.event === "client_decode_failed");
  const side = end === null ? "not_observed" : decodeFailedBeforeEnd ? "unknown" : initiator === null ? "runtime"
    : initiator.event === "client_command" ? (initiatorOutcome === "rejected" ? "runtime_raced_stop" : "meeting_stop")
      : initiator.event === "client_eof" ? "meeting_transport_close" : "observer_signal";
  const failed = lastOf(end?.type === "voice_session_failed" ? [...beforeEnd, end] : beforeEnd, row => row.event === "voice" && row.type === "voice_session_failed" && sameSession(row));
  const fatal = lastOf(beforeEnd, row => row.event === "gateway_message" && row.type === "fatal");
  const timedIndex = firstIndex(rows, row => row.event === "gateway_message" && row.type === "timed_voice_session_started");
  const boundary = initiator === null ? (end === null ? rows.length : endIndex) : rows.indexOf(initiator);
  const voiceSessions = new Set(all.filter(row => row.event === "voice" && typeof row.session_id === "string").map(row => row.session_id));
  if (session !== undefined) voiceSessions.delete(session);

  const exitIndex = firstIndex(rows, row => row.event === "gateway_exit");
  const closer = firstIndex(rows, row => ["client_eof", "observer_signal", "gateway_stdout_end", "gateway_exit"].includes(row.event));
  const exit = rows[exitIndex] ?? null;
  const cause = exit === null ? "not_observed" : rows[closer].event === "client_eof" ? "client_eof"
    : rows[closer].event === "observer_signal" ? "observer_signal" : "gateway_exited_first";

  const calls = Array.isArray(interactiveCalls) ? interactiveCalls : [];
  const count = route => calls.filter(call => call?.route === route).length;
  const connections = isObject(interactiveConnections) ? {
    recognitionConnections: Number.isInteger(interactiveConnections.recognition) ? interactiveConnections.recognition : 0,
    httpRequests: Number.isInteger(interactiveConnections.http) ? interactiveConnections.http : 0,
    languageCalls: count("language"), speechCalls: count("speech"),
  } : null;
  const firstRecognition = isObject(interactiveConnections) && typeof interactiveConnections.firstRecognitionMonotonicNs === "string"
    ? { monotonicNs: interactiveConnections.firstRecognitionMonotonicNs } : null;
  const toEnd = elapsedMs(end, firstRecognition);
  const leave = isObject(bridge) && isObject(bridge.leave) ? bridge.leave : null;

  return {
    schema: "meeting-voice-end-evidence/v1",
    lifecycle: { status: lifecycle.status, rows: all.length, gatewayProcesses: pids.length, complete: exit !== null,
      clientDecodeFailed: rows.some(row => row.event === "client_decode_failed"),
      gatewayProcessesWithVoice: pids.filter(pid => all.some(row => row.observerPid === pid && row.event === "voice")).length,
      otherVoiceSessions: voiceSessions.size },
    voiceSessionEnded: {
      observed: end !== null,
      via: end?.type ?? null,
      side,
      initiatorOutcome,
      msSinceStart: elapsedMs(start, end),
      failure: failed === null ? null : { ...(failed.error ?? { code: null, kind: null, stage: null }), recovery: failed.recovery ?? null },
      fatal: fatal?.error ?? null,
      rejections: rows.filter(row => row.event === "gateway_message" && row.type === "command_rejected")
        .map(row => ({ command: commands.get(row.request_id) ?? null, ...(row.error ?? { code: null, kind: null, stage: null }),
          afterEnd: end !== null && rows.indexOf(row) > endIndex })),
      timedStart: timedIndex < 0 ? "absent" : end === null ? "observed" : timedIndex < endIndex ? "before_end" : "after_end",
      stopCommandMsBeforeEnd: initiator?.event === "client_command" ? elapsedMs(initiator, end) : null,
      commandsBeforeEnd: live.filter(row => row.event === "client_command").map(row => row.type).slice(0, 64),
      gatewayMessagesBeforeInitiator: rows.slice(0, boundary).filter(row => row.event === "gateway_message" || row.event === "voice").map(row => row.type).slice(-8),
    },
    runtimeClosed: { cause, code: exit?.code ?? null, signal: exit?.signal ?? null, msAfterVoiceEnd: elapsedMs(end, exit) },
    providerConnectAttempted: connections === null ? null : {
      attempted: Object.values(connections).some(value => value > 0), ...connections,
      firstRecognitionMsRelativeToVoiceStart: elapsedMs(start, firstRecognition),
      firstRecognitionMsRelativeToVoiceEnd: toEnd,
      recognitionConnectedBeforeEnd: toEnd === null ? null : toEnd < 0,
    },
    bridgeLeave: isObject(bridge) ? { reason: leave?.reason ?? null, msRelativeToVoiceEnd: elapsedMs(end, leave),
      connectMediaSent: Array.isArray(bridge.commands) && bridge.commands.includes("connect_media") } : null,
  };
}

/** run.mjs wiring: the observer's file in the bridge control directory plus the entry summary. */
export function voiceEndFromControl(controlDir, { childState = null, summary = null } = {}) {
  return voiceEndEvidence({
    lifecycle: typeof controlDir === "string" ? readVoiceEndRows(path.join(controlDir, LIFECYCLE_FILE)) : { status: "absent", rows: [] },
    bridge: childState, interactiveConnections: summary?.interactiveConnections ?? null, interactiveCalls: summary?.interactiveCalls ?? [],
  });
}
