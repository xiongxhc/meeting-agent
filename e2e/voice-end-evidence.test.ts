import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { encodeFrame } from "@conversation/runtime";
// @ts-expect-error Private harness JavaScript has no public declaration.
import { LIFECYCLE_FILE, bridgeLeaveFact, clientCommandRow, gatewayExitRow, gatewayMessageRow, readVoiceEndRows, voiceEndEvidence, voiceEndFromControl } from "./voice-end-evidence.mjs";

type Row = Record<string, unknown> & { event: string; monotonicNs: string; observerPid: number };

const repository = path.resolve(import.meta.dirname, "..");
const SECRET = "lease-credential-must-not-persist";
const MESSAGE = "free-text-failure-message-must-not-persist";

/** Rows as the observer would persist them; one observer process unless stated. */
function rows(spec: readonly (readonly [number, Record<string, unknown>])[], observerPid = 4242): Row[] {
  return spec.map(([ms, row]) => ({ event: "", ...row, observerPid, at: 1_700_000_000_000 + ms, monotonicNs: (1_000_000_000n + BigInt(Math.round(ms * 1000)) * 1000n).toString() }));
}
const command = (type: string, id: number) => ({ event: "client_command", type, request_id: `request-${id}` });
const voice = (type: string, extra: Record<string, unknown> = {}) => ({ event: "voice", type, session_id: "8488863042358018365", ...extra });
const message = (type: string, extra: Record<string, unknown> = {}) => ({ event: "gateway_message", type, ...extra });
const leaveAt = (ms: number) => ({ reason: "coordinator_stop", monotonicNs: (1_000_000_000n + BigInt(Math.round(ms * 1000)) * 1000n).toString() });
const nsAt = (ms: number) => (1_000_000_000n + BigInt(Math.round(ms * 1000)) * 1000n).toString();
const tenSevenBridge = (ms: number) => ({ commands: ["join", "leave"], leave: leaveAt(ms) });

test("client command rows keep only the command type and request id", () => {
  assert.deepEqual(clientCommandRow({ protocol_version: 4, type: "start_drainable_timed_voice_session", request_id: "request-7", bridge_session_id: "b", profile: "online" }),
    { event: "client_command", type: "start_drainable_timed_voice_session", request_id: "request-7" });
  assert.deepEqual(clientCommandRow({ type: "seed_conversation_context", request_id: "request-8", exchanges: [{ user: SECRET }] }),
    { event: "client_command", type: "seed_conversation_context", request_id: "request-8" });
  assert.deepEqual(clientCommandRow({ type: "Not A Token", request_id: "../../x" }), { event: "client_command", type: "unrecognized" });
  assert.deepEqual(clientCommandRow(null), { event: "client_command", type: "unrecognized" });
});

test("gateway rows keep enum failure fields and drop messages, leases and status", () => {
  const failure = { code: "adapter_failure", kind: "adapter", stage: "speech_recognizer", message: MESSAGE };
  assert.deepEqual(gatewayMessageRow({ type: "command_accepted", request_id: "request-3", media_lease: { credential: SECRET, connect_endpoint: "ws://127.0.0.1:1" } }),
    { event: "gateway_message", type: "command_accepted", request_id: "request-3" });
  assert.deepEqual(gatewayMessageRow({ type: "command_rejected", request_id: "request-4", error: failure }),
    { event: "gateway_message", type: "command_rejected", request_id: "request-4", error: { code: "adapter_failure", kind: "adapter", stage: "speech_recognizer" } });
  assert.deepEqual(gatewayMessageRow({ type: "fatal", error: failure }),
    { event: "gateway_message", type: "fatal", error: { code: "adapter_failure", kind: "adapter", stage: "speech_recognizer" } });
  assert.deepEqual(gatewayMessageRow({ type: "ready", status: { privacy_mode: "x", note: SECRET }, current_session_id: "1" }), { event: "gateway_message", type: "ready" });
  assert.deepEqual(gatewayMessageRow({ type: "voice_event", event: { type: "voice_session_failed", session_id: "9", error: failure, recovery: "new_session" } }),
    { event: "voice", type: "voice_session_failed", session_id: "9", recovery: "new_session", error: { code: "adapter_failure", kind: "adapter", stage: "speech_recognizer" } });
  assert.deepEqual(gatewayMessageRow({ type: "voice_event", event: { type: "voice_session_ended", session_id: "9" } }), { event: "voice", type: "voice_session_ended", session_id: "9" });
  assert.equal(gatewayMessageRow({ type: "voice_event", event: { type: "voice_transcript_final", session_id: "9", text: SECRET } }), null);
  assert.deepEqual(gatewayMessageRow({ type: "fatal", error: { code: "Bad Code", kind: 3, stage: null, message: MESSAGE } }),
    { event: "gateway_message", type: "fatal", error: { code: null, kind: null, stage: null } });
  assert.equal(gatewayMessageRow(null), null);
});

test("gateway exit rows accept only integer codes and signal names", () => {
  assert.deepEqual(gatewayExitRow(0, null), { event: "gateway_exit", code: 0, signal: null });
  assert.deepEqual(gatewayExitRow(null, "SIGTERM"), { event: "gateway_exit", code: null, signal: "SIGTERM" });
  assert.deepEqual(gatewayExitRow(1.5, "kill -9"), { event: "gateway_exit", code: null, signal: null });
});

test("bridge leave facts keep only the declared reasons", () => {
  assert.deepEqual(bridgeLeaveFact("coordinator_stop", 12n), { reason: "coordinator_stop", monotonicNs: "12" });
  assert.deepEqual(bridgeLeaveFact("meeting_ended", 13n), { reason: "meeting_ended", monotonicNs: "13" });
  assert.deepEqual(bridgeLeaveFact(SECRET, 14n), { reason: "other", monotonicNs: "14" });
});

test("passing run: Meeting stops the session at meeting end", () => {
  const lifecycle = { status: "present", rows: rows([
    [0, message("ready")], [1, command("status", 1)], [2, message("status", { request_id: "request-1" })],
    [700, command("start_drainable_timed_voice_session", 2)], [701, message("command_accepted", { request_id: "request-2" })],
    [702, voice("voice_session_started")], [703, message("timed_voice_session_started", { request_id: "request-2" })],
    [2540, command("stop_voice_session", 9)], [2541, message("command_accepted", { request_id: "request-9" })],
    [2560, voice("voice_session_ended")], [2561, command("finalize_recording", 10)], [2570, message("recording_finalized", { request_id: "request-10" })],
    [2580, { event: "client_eof" }], [2581, { event: "gateway_stdout_end" }], [2590, gatewayExitRow(0, null)],
  ]) };
  const evidence = voiceEndEvidence({ lifecycle, bridge: { commands: ["join", "connect_media", "post_disclosure"], leave: null },
    interactiveConnections: { recognition: 1, http: 9, firstRecognitionMonotonicNs: nsAt(702.5) }, interactiveCalls: [{ route: "language" }, { route: "speech" }, { route: "speech" }] });
  assert.equal(evidence.schema, "meeting-voice-end-evidence/v1");
  assert.deepEqual(evidence.lifecycle, { status: "present", rows: 15, gatewayProcesses: 1, complete: true, clientDecodeFailed: false, gatewayProcessesWithVoice: 1, otherVoiceSessions: 0 });
  assert.equal(evidence.voiceSessionEnded.side, "meeting_stop");
  assert.equal(evidence.voiceSessionEnded.via, "voice_session_ended");
  assert.equal(evidence.voiceSessionEnded.msSinceStart, 1858);
  assert.equal(evidence.voiceSessionEnded.timedStart, "before_end");
  assert.equal(evidence.voiceSessionEnded.stopCommandMsBeforeEnd, 20);
  assert.deepEqual(evidence.voiceSessionEnded.commandsBeforeEnd, ["stop_voice_session"]);
  assert.deepEqual(evidence.runtimeClosed, { cause: "client_eof", code: 0, signal: null, msAfterVoiceEnd: 30 });
  assert.deepEqual(evidence.providerConnectAttempted, { attempted: true, recognitionConnections: 1, httpRequests: 9, languageCalls: 1, speechCalls: 2,
    firstRecognitionMsRelativeToVoiceStart: 0.5, firstRecognitionMsRelativeToVoiceEnd: -1857.5, recognitionConnectedBeforeEnd: true });
  assert.deepEqual(evidence.bridgeLeave, { reason: null, msRelativeToVoiceEnd: null, connectMediaSent: true });
});

test("10-07 shape, H1: the Runtime ends the session before the timed start with a recognizer failure", () => {
  const lifecycle = { status: "present", rows: rows([
    [0, message("ready")], [714, command("start_drainable_timed_voice_session", 2)], [714.2, message("command_accepted", { request_id: "request-2" })],
    [714.5, voice("voice_session_started")],
    [717, voice("voice_session_failed", { recovery: "continue_session", error: { code: "adapter_failure", kind: "adapter", stage: "speech_recognizer" } })],
    [719.42, voice("voice_session_ended")], [720, message("timed_voice_session_started", { request_id: "request-2" })],
    [721, { event: "client_eof" }], [725, gatewayExitRow(0, null)],
  ]) };
  const evidence = voiceEndEvidence({ lifecycle, bridge: tenSevenBridge(724), interactiveConnections: { recognition: 1, http: 0 }, interactiveCalls: [] });
  assert.equal(evidence.voiceSessionEnded.side, "runtime");
  assert.equal(evidence.voiceSessionEnded.msSinceStart, 4.92);
  assert.equal(evidence.voiceSessionEnded.timedStart, "after_end");
  assert.deepEqual(evidence.voiceSessionEnded.failure, { code: "adapter_failure", kind: "adapter", stage: "speech_recognizer", recovery: "continue_session" });
  assert.equal(evidence.voiceSessionEnded.stopCommandMsBeforeEnd, null);
  assert.deepEqual(evidence.runtimeClosed, { cause: "client_eof", code: 0, signal: null, msAfterVoiceEnd: 5.58 });
  assert.equal(evidence.providerConnectAttempted.attempted, true);
  assert.deepEqual(evidence.bridgeLeave, { reason: "coordinator_stop", msRelativeToVoiceEnd: 4.58, connectMediaSent: false });
});

test("10-07 shape, H2: Meeting leaves and stops after admission, before connect_media", () => {
  const lifecycle = { status: "present", rows: rows([
    [0, message("ready")], [714, command("start_drainable_timed_voice_session", 2)], [714.2, message("command_accepted", { request_id: "request-2" })],
    [714.5, voice("voice_session_started")], [714.6, message("timed_voice_session_started", { request_id: "request-2" })],
    [717, command("stop_voice_session", 3)], [718, message("command_accepted", { request_id: "request-3" })],
    [719.42, voice("voice_session_ended")], [720, command("finalize_recording", 4)], [722, message("recording_finalized", { request_id: "request-4" })],
    [723, { event: "client_eof" }], [800, { event: "observer_signal", signal: "SIGTERM" }], [801, gatewayExitRow(null, "SIGTERM")],
  ]) };
  const evidence = voiceEndEvidence({ lifecycle, bridge: tenSevenBridge(716), interactiveConnections: { recognition: 0, http: 0 }, interactiveCalls: [] });
  assert.equal(evidence.voiceSessionEnded.side, "meeting_stop");
  assert.equal(evidence.voiceSessionEnded.timedStart, "before_end");
  assert.equal(evidence.voiceSessionEnded.stopCommandMsBeforeEnd, 2.42);
  assert.equal(evidence.voiceSessionEnded.initiatorOutcome, "accepted");
  assert.equal(evidence.bridgeLeave.msRelativeToVoiceEnd, -3.42);
  assert.deepEqual(evidence.runtimeClosed, { cause: "client_eof", code: null, signal: "SIGTERM", msAfterVoiceEnd: 81.58 });
  assert.deepEqual(evidence.providerConnectAttempted, { attempted: false, recognitionConnections: 0, httpRequests: 0, languageCalls: 0, speechCalls: 0,
    firstRecognitionMsRelativeToVoiceStart: null, firstRecognitionMsRelativeToVoiceEnd: null, recognitionConnectedBeforeEnd: null });
});

test("10-07 shape, H3: the client closes the transport first; fatal and rejections are attributed", () => {
  const lifecycle = { status: "present", rows: rows([
    [0, message("ready")], [714, command("start_drainable_timed_voice_session", 2)], [714.1, command("status", 3)],
    [714.2, message("command_rejected", { request_id: "request-3", error: { code: "invalid_state", kind: "invalid_state", stage: "runtime" } })],
    [714.5, voice("voice_session_started")], [715, message("fatal", { error: { code: "adapter_failure", kind: "adapter", stage: "audio_capture" } })],
    [716, { event: "client_eof" }], [719.42, voice("voice_session_ended")], [720, { event: "gateway_stdout_end" }], [721, gatewayExitRow(3, null)],
  ]) };
  const evidence = voiceEndEvidence({ lifecycle, bridge: null, interactiveConnections: null, interactiveCalls: [] });
  assert.equal(evidence.voiceSessionEnded.side, "meeting_transport_close");
  assert.deepEqual(evidence.voiceSessionEnded.gatewayMessagesBeforeInitiator, ["ready", "command_rejected", "voice_session_started", "fatal"]);
  assert.equal(evidence.voiceSessionEnded.timedStart, "absent");
  assert.deepEqual(evidence.voiceSessionEnded.fatal, { code: "adapter_failure", kind: "adapter", stage: "audio_capture" });
  assert.deepEqual(evidence.voiceSessionEnded.rejections, [{ command: "status", code: "invalid_state", kind: "invalid_state", stage: "runtime", afterEnd: false }]);
  assert.equal(evidence.runtimeClosed.cause, "client_eof");
  assert.equal(evidence.runtimeClosed.code, 3);
  assert.equal(evidence.providerConnectAttempted, null);
  assert.equal(evidence.bridgeLeave, null);
});

test("gateway exit before any client close is an unprompted Runtime close; a failed new-session voice event is terminal", () => {
  const lifecycle = { status: "present", rows: rows([
    [0, voice("voice_session_started")],
    [5, voice("voice_session_failed", { recovery: "new_session", error: { code: "adapter_failure", kind: "adapter", stage: "voice_sidecar" } })],
    [6, { event: "gateway_stdout_end" }], [7, gatewayExitRow(70, null)], [9, { event: "client_eof" }],
  ]) };
  const evidence = voiceEndEvidence({ lifecycle });
  assert.equal(evidence.voiceSessionEnded.via, "voice_session_failed");
  assert.equal(evidence.voiceSessionEnded.side, "runtime");
  assert.equal(evidence.voiceSessionEnded.failure.stage, "voice_sidecar");
  assert.equal(evidence.runtimeClosed.cause, "gateway_exited_first");
  assert.equal(evidence.runtimeClosed.code, 70);
});

test("a stop that loses the race to a Runtime end is not credited to Meeting", () => {
  const lifecycle = { status: "present", rows: rows([
    [0, voice("voice_session_started")], [3, command("stop_voice_session", 7)],
    [3.2, voice("voice_session_failed", { recovery: "continue_session", error: { code: "adapter_failure", kind: "adapter", stage: "speech_recognizer" } })],
    [4, voice("voice_session_ended")],
    [4.5, message("command_rejected", { request_id: "request-7", error: { code: "invalid_state", kind: "invalid_state", stage: "runtime" } })],
    [5, command("finalize_recording", 8)], [6, message("recording_finalized", { request_id: "request-8" })], [7, { event: "client_eof" }], [8, gatewayExitRow(0, null)],
  ]) };
  const evidence = voiceEndEvidence({ lifecycle });
  assert.equal(evidence.voiceSessionEnded.side, "runtime_raced_stop");
  assert.equal(evidence.voiceSessionEnded.initiatorOutcome, "rejected");
  assert.equal(evidence.voiceSessionEnded.failure.stage, "speech_recognizer");
  assert.deepEqual(evidence.voiceSessionEnded.rejections, [{ command: "stop_voice_session", code: "invalid_state", kind: "invalid_state", stage: "runtime", afterEnd: true }]);
  assert.deepEqual(evidence.voiceSessionEnded.gatewayMessagesBeforeInitiator, ["voice_session_started"]);
  const unanswered = voiceEndEvidence({ lifecycle: { status: "present", rows: rows([[0, voice("voice_session_started")], [1, command("stop_voice_session", 2)], [2, voice("voice_session_ended")]]) } });
  assert.equal(unanswered.voiceSessionEnded.side, "meeting_stop");
  assert.equal(unanswered.voiceSessionEnded.initiatorOutcome, "none");
});

test("an unframeable client stream before the end makes the side unknown", () => {
  const evidence = voiceEndEvidence({ lifecycle: { status: "present", rows: rows([
    [0, voice("voice_session_started")], [1, { event: "client_decode_failed" }], [2, voice("voice_session_ended")], [3, gatewayExitRow(0, null)],
  ]) } });
  assert.equal(evidence.voiceSessionEnded.side, "unknown");
  assert.equal(evidence.lifecycle.clientDecodeFailed, true);
});

test("end and failure rows must match the started session; other sessions and voice gateways are counted", () => {
  const live = rows([
    [0, voice("voice_session_started")],
    [1, { ...voice("voice_session_failed", { recovery: "new_session", error: { code: "adapter_failure", kind: "adapter", stage: "voice_sidecar" } }), session_id: "77" }],
    [2, { ...voice("voice_session_ended"), session_id: "77" }],
    [3, command("stop_voice_session", 4)], [4, message("command_accepted", { request_id: "request-4" })], [5, voice("voice_session_ended")],
  ], 21);
  const other = rows([[0, { ...voice("voice_session_started"), session_id: "88" }]], 22);
  const evidence = voiceEndEvidence({ lifecycle: { status: "present", rows: [...live, ...other] } });
  assert.equal(evidence.voiceSessionEnded.side, "meeting_stop");
  assert.equal(evidence.voiceSessionEnded.failure, null);
  assert.equal(evidence.voiceSessionEnded.msSinceStart, 5);
  assert.equal(evidence.lifecycle.otherVoiceSessions, 2);
  assert.equal(evidence.lifecycle.gatewayProcessesWithVoice, 2);
});

test("a recognition connection after the end is not counted as connected before it", () => {
  const evidence = voiceEndEvidence({ lifecycle: { status: "present", rows: rows([[0, voice("voice_session_started")], [5, voice("voice_session_ended")]]) },
    interactiveConnections: { recognition: 1, http: 0, firstRecognitionMonotonicNs: nsAt(9) }, interactiveCalls: [] });
  assert.equal(evidence.providerConnectAttempted.firstRecognitionMsRelativeToVoiceEnd, 4);
  assert.equal(evidence.providerConnectAttempted.recognitionConnectedBeforeEnd, false);
});

test("several gateway processes: the live voice process is selected and counted", () => {
  const live = rows([[0, voice("voice_session_started")], [1, command("stop_voice_session", 5)], [2, voice("voice_session_ended")], [3, { event: "client_eof" }], [4, gatewayExitRow(0, null)]], 11);
  const post = rows([[10, message("ready")], [11, command("status", 1)], [12, { event: "client_eof" }], [13, gatewayExitRow(0, null)]], 12);
  const evidence = voiceEndEvidence({ lifecycle: { status: "present", rows: [...post, ...live] } });
  assert.equal(evidence.lifecycle.gatewayProcesses, 2);
  assert.equal(evidence.voiceSessionEnded.side, "meeting_stop");
  assert.equal(evidence.runtimeClosed.msAfterVoiceEnd, 2);
});

test("missing, unreadable, incomplete and empty lifecycle evidence is reported, never thrown", () => {
  const root = mkdtempSync(path.join(tmpdir(), "meeting-voice-end-test-"));
  try {
    assert.deepEqual(readVoiceEndRows(path.join(root, "absent.ndjson")), { status: "absent", rows: [] });
    assert.deepEqual(readVoiceEndRows(root), { status: "unreadable", rows: [] });
    writeFileSync(path.join(root, "bad.ndjson"), "{\"event\":\"client_eof\"}\nnot-json\n");
    assert.deepEqual(readVoiceEndRows(path.join(root, "bad.ndjson")), { status: "unreadable", rows: [] });
    writeFileSync(path.join(root, "good.ndjson"), "{\"event\":\"client_eof\",\"observerPid\":1,\"monotonicNs\":\"5\"}\n");
    assert.deepEqual(readVoiceEndRows(path.join(root, "good.ndjson")).rows, [{ event: "client_eof", observerPid: 1, monotonicNs: "5" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
  const empty = voiceEndEvidence({ lifecycle: { status: "absent", rows: [] } });
  assert.deepEqual(empty.lifecycle, { status: "absent", rows: 0, gatewayProcesses: 0, complete: false, clientDecodeFailed: false, gatewayProcessesWithVoice: 0, otherVoiceSessions: 0 });
  assert.equal(empty.voiceSessionEnded.observed, false);
  assert.equal(empty.voiceSessionEnded.side, "not_observed");
  assert.equal(empty.runtimeClosed.cause, "not_observed");
  const incomplete = voiceEndEvidence({ lifecycle: { status: "present", rows: rows([[0, voice("voice_session_started")], [1, { event: "client_decode_failed" }], [2, { event: "monotonicNs-bad", monotonicNs: "x" }]]) } });
  assert.equal(incomplete.lifecycle.complete, false);
  assert.equal(incomplete.voiceSessionEnded.side, "not_observed");
  assert.equal(incomplete.lifecycle.clientDecodeFailed, true);
  const garbage = voiceEndEvidence({ lifecycle: { status: "present", rows: [null, 3, "x", { event: "voice", type: "voice_session_ended", monotonicNs: "nope" }] }, bridge: { commands: "x", leave: 5 } });
  assert.equal(garbage.voiceSessionEnded.msSinceStart, null);
});

test("projection serialises to plain JSON without private keys", () => {
  const lifecycle = { status: "present", rows: rows([[0, voice("voice_session_started")], [1, voice("voice_session_ended")], [2, gatewayExitRow(0, null)]]) };
  const evidence = voiceEndEvidence({ lifecycle, bridge: tenSevenBridge(1), interactiveConnections: { recognition: 0, http: 0 }, interactiveCalls: [] });
  const text = JSON.stringify(evidence);
  assert.deepEqual(JSON.parse(text), evidence);
  for (const key of ["message", "credential", "media_lease", "mediaLease"]) assert.ok(!text.includes(`"${key}"`), key);
});

test("bundle wiring reads the control directory and the entry summary", () => {
  const root = mkdtempSync(path.join(tmpdir(), "meeting-voice-end-control-"));
  try {
    const lifecycle = rows([[0, voice("voice_session_started")], [4.92, voice("voice_session_ended")], [6, { event: "client_eof" }], [7, gatewayExitRow(0, null)]]);
    writeFileSync(path.join(root, LIFECYCLE_FILE), lifecycle.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const evidence = voiceEndFromControl(root, { childState: tenSevenBridge(5), summary: { interactiveConnections: { recognition: 0, http: 0 }, interactiveCalls: [] } });
    assert.equal(evidence.lifecycle.status, "present");
    assert.equal(evidence.voiceSessionEnded.side, "runtime");
    assert.equal(evidence.voiceSessionEnded.msSinceStart, 4.92);
    assert.equal(evidence.bridgeLeave.reason, "coordinator_stop");
    assert.equal(evidence.providerConnectAttempted.attempted, false);
    const none = voiceEndFromControl(undefined, { childState: null, summary: null });
    assert.equal(none.lifecycle.status, "absent");
    assert.equal(none.providerConnectAttempted, null);
    assert.equal(none.bridgeLeave, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** Synthetic gateway: echoes its stdin bytes to a file, answers with fixed frames, exits 3 on EOF. */
function syntheticGateway(root: string, frames: readonly Buffer[]) {
  const gateway = path.join(root, "gateway"), received = path.join(root, "received");
  writeFileSync(gateway, `#!${process.execPath}\nconst fs = require('node:fs');\nconst out = Buffer.from(${JSON.stringify(Buffer.concat(frames).toString("base64"))}, 'base64');\nprocess.stdin.on('data', (chunk) => fs.appendFileSync(${JSON.stringify(received)}, chunk));\nprocess.stdin.on('end', () => { process.stdout.write(out.subarray(3), () => process.exit(3)); });\nprocess.stdout.write(out.subarray(0, 3));\n`, { mode: 0o700 });
  return { gateway, received };
}
const wire = (value: unknown) => Buffer.from(encodeFrame(Buffer.from(JSON.stringify(value))));

test("observer records lifecycle in both directions, forwards bytes unchanged and keeps the gateway exit code", { timeout: 8000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "meeting-voice-end-observer-"));
  const failure = { code: "adapter_failure", kind: "adapter", stage: "speech_recognizer", message: MESSAGE };
  const gatewayFrames = [
    wire({ protocol_version: 4, type: "command_accepted", request_id: "request-2", media_lease: { credential: SECRET } }),
    wire({ protocol_version: 4, type: "voice_event", event: { type: "voice_session_started", session_id: "42", privacy: { note: SECRET } } }),
    wire({ protocol_version: 4, type: "voice_event", event: { type: "voice_session_failed", session_id: "42", error: failure, recovery: "continue_session" } }),
    wire({ protocol_version: 4, type: "voice_event", event: { type: "voice_session_ended", session_id: "42" } }),
    wire({ protocol_version: 4, type: "fatal", error: failure }),
  ];
  const clientFrames = Buffer.concat([
    wire({ protocol_version: 4, type: "start_drainable_timed_voice_session", request_id: "request-2", bridge_session_id: "b", profile: "online", response_mode: "external_gate" }),
    wire({ protocol_version: 4, type: "seed_conversation_context", request_id: "request-3", operation_id: "o", exchanges: [{ text: SECRET }] }),
  ]);
  const { gateway, received } = syntheticGateway(root, gatewayFrames);
  writeFileSync(path.join(root, "key"), `${"a".repeat(64)}\n`, { mode: 0o600 });
  const events = path.join(root, "runtime-events.ndjson"), pids = path.join(root, "pids");
  const observer = spawn(process.execPath, [path.join(repository, "e2e/gateway-observer.mjs"), gateway, path.join(root, "key"), events, pids], { cwd: repository, stdio: ["pipe", "pipe", "pipe"] });
  const output: Buffer[] = []; let stderr = "";
  observer.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  observer.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    observer.stdin.write(clientFrames.subarray(0, 5));
    setTimeout(() => { observer.stdin.write(clientFrames.subarray(5)); observer.stdin.end(); }, 50);
    const code = await new Promise<number | null>((resolve) => observer.on("close", resolve));
    assert.equal(code, 3, stderr);
    assert.equal(stderr, "");
    assert.deepEqual(Buffer.concat(output), Buffer.concat(gatewayFrames));
    assert.deepEqual(readFileSync(received), clientFrames);
    const lifecyclePath = path.join(root, LIFECYCLE_FILE);
    const text = readFileSync(lifecyclePath, "utf8");
    assert.equal(statSync(lifecyclePath).mode & 0o777, 0o600);
    for (const secret of [SECRET, MESSAGE, "a".repeat(64)]) assert.ok(!text.includes(secret));
    const recorded = text.trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(recorded.every((row) => row.observerPid === observer.pid && BigInt(row.monotonicNs) > 0n && typeof row.at === "number"));
    const shape = recorded.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !["observerPid", "at", "monotonicNs"].includes(key))));
    const position = (predicate: (row: Record<string, unknown>) => boolean) => shape.findIndex(predicate);
    assert.ok(position((row) => row.type === "start_drainable_timed_voice_session" && row.request_id === "request-2") >= 0);
    assert.ok(position((row) => row.type === "seed_conversation_context" && Object.keys(row).length === 3) >= 0);
    assert.deepEqual(shape.filter((row) => row.event !== "client_command" && row.event !== "client_eof"), [
      { event: "gateway_message", type: "command_accepted", request_id: "request-2" },
      { event: "voice", type: "voice_session_started", session_id: "42" },
      { event: "voice", type: "voice_session_failed", session_id: "42", recovery: "continue_session", error: { code: "adapter_failure", kind: "adapter", stage: "speech_recognizer" } },
      { event: "voice", type: "voice_session_ended", session_id: "42" },
      { event: "gateway_message", type: "fatal", error: { code: "adapter_failure", kind: "adapter", stage: "speech_recognizer" } },
      { event: "gateway_stdout_end" },
      { event: "gateway_exit", code: 3, signal: null },
    ]);
    assert.ok(position((row) => row.event === "client_eof") > position((row) => row.type === "seed_conversation_context"));
    assert.ok(position((row) => row.event === "client_eof") < position((row) => row.event === "gateway_exit"));
    // The existing voice-event file keeps its exact pre-existing shape.
    const voiceRows = readFileSync(events, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(voiceRows.map((row) => Object.keys(row).sort()), [["at", "monotonicNs", "session_id", "type"], ["at", "monotonicNs", "session_id", "type"], ["at", "monotonicNs", "session_id", "type"]]);
  } finally {
    observer.kill("SIGKILL"); rmSync(root, { recursive: true, force: true });
  }
});

test("observer lifecycle write failure never terminates or recodes the gateway", { timeout: 8000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "meeting-voice-end-observer-fail-"));
  const frames = [wire({ protocol_version: 4, type: "voice_event", event: { type: "voice_session_ended", session_id: "42" } })];
  const { gateway, received } = syntheticGateway(root, frames);
  writeFileSync(path.join(root, "key"), `${"a".repeat(64)}\n`, { mode: 0o600 });
  mkdirSync(path.join(root, LIFECYCLE_FILE)); // appendFileSync on a directory fails.
  const clientFrame = wire({ protocol_version: 4, type: "status", request_id: "request-1" });
  const observer = spawn(process.execPath, [path.join(repository, "e2e/gateway-observer.mjs"), gateway, path.join(root, "key"), path.join(root, "runtime-events.ndjson"), path.join(root, "pids")], { cwd: repository, stdio: ["pipe", "pipe", "pipe"] });
  const output: Buffer[] = []; let stderr = "";
  observer.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  observer.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    observer.stdin.end(clientFrame);
    const code = await new Promise<number | null>((resolve) => observer.on("close", resolve));
    assert.equal(code, 3);
    assert.equal(stderr, "gateway_observer_lifecycle_unavailable\n");
    assert.deepEqual(Buffer.concat(output), Buffer.concat(frames));
    assert.deepEqual(readFileSync(received), clientFrame);
    assert.equal(readFileSync(path.join(root, "runtime-events.ndjson"), "utf8").trim().split("\n").length, 1);
  } finally {
    observer.kill("SIGKILL"); rmSync(root, { recursive: true, force: true });
  }
});

test("observer stops observing an unframeable client stream but keeps forwarding it", { timeout: 8000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "meeting-voice-end-observer-decode-"));
  const { gateway, received } = syntheticGateway(root, [wire({ protocol_version: 4, type: "ready" })]);
  writeFileSync(path.join(root, "key"), `${"a".repeat(64)}\n`, { mode: 0o600 });
  const garbage = Buffer.from([255, 255, 255, 255, 1, 2, 3]);
  const observer = spawn(process.execPath, [path.join(repository, "e2e/gateway-observer.mjs"), gateway, path.join(root, "key"), path.join(root, "runtime-events.ndjson"), path.join(root, "pids")], { cwd: repository, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  observer.stdout.resume();
  observer.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    observer.stdin.end(garbage);
    const code = await new Promise<number | null>((resolve) => observer.on("close", resolve));
    assert.equal(code, 3, stderr);
    assert.deepEqual(readFileSync(received), garbage);
    const events = readFileSync(path.join(root, LIFECYCLE_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line).event);
    assert.equal(events.filter((event) => event === "client_decode_failed").length, 1);
    assert.ok(!events.includes("client_command"));
    assert.equal(events.at(-1), "gateway_exit");
  } finally {
    observer.kill("SIGKILL"); rmSync(root, { recursive: true, force: true });
  }
});
