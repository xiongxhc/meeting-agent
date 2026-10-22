// Provider-fault D2 cuts: the scripted recognition provider fails during
// capture and the run must show that recording never noticed. Binding rule:
// "VAD check gates speech recognition, not encrypted recording. Recording must
// remain independent of provider failures."
// Pure checks over evidence the run already keeps; no audio, key or text.
import { selectedAlignment } from "./durable-oracles.mjs";
import { voiceEndEvidence } from "./voice-end-evidence.mjs";

/** Cut name -> scripted recognition fault. */
export const PROVIDER_FAULT_CUTS = Object.freeze({ "provider-connect": "connect", "provider-error": "error", "provider-stall": "stall",
  "provider-error-speaking": "error", "provider-error-speaking-flush-timeout": "error" });
/** Speaking cuts fail recognition while an authorized answer's playback is held;
 * the flush-timeout cut also withholds every bridge flush ACK. */
export const PROVIDER_FAULT_SPEAKING = Object.freeze({ "provider-error-speaking": false, "provider-error-speaking-flush-timeout": true });

/** Drive-plan fields for a cut; empty for every other mode. */
export function providerFaultPlan(cut) {
  if (!Object.hasOwn(PROVIDER_FAULT_CUTS, cut ?? "")) return {};
  return { providerFault: PROVIDER_FAULT_CUTS[cut],
    ...(Object.hasOwn(PROVIDER_FAULT_SPEAKING, cut) ? { providerFaultSpeaking: true, providerFaultWithholdFlushAck: PROVIDER_FAULT_SPEAKING[cut] } : {}) };
}
/** How far apart the held answer's terminal and the reported failure that interrupted
 * it may be, either way. The Runtime ends the turn first and reports second,
 * microseconds apart; the window stays far below the 2 s cleanup timeout. */
export const FAILURE_AFTER_TERMINAL_NS = 100_000_000n;
/** Recorded frames the cut requires after Runtime reported the failure (2 s). */
export const FRAMES_AFTER_FAILURE = 100n;

function requireFact(value, reason) { if (!value) throw new Error(reason); }
const ns = value => BigInt(value);

/** Voice lifecycle rows of the gateway process that started the voice session. */
function startedSessionRows(lifecycle) {
  const rows = (lifecycle?.rows ?? []).filter(row => row && typeof row === "object");
  const start = rows.find(row => row.event === "voice" && row.type === "voice_session_started");
  requireFact(start && typeof start.session_id === "string", "no started voice session in the Runtime lifecycle");
  return { start, rows: rows.filter(row => row.observerPid === start.observerPid) };
}

export function providerFaultOracles({ cut, events, runtimeEvents, lifecycle, childState, snapshot, artifact, summary }) {
  const checks = [];
  const check = (name, work) => {
    try { checks.push({ name, status: "pass", detail: work() }); }
    catch (error) { checks.push({ name, status: "fail", detail: String(error?.message ?? error) }); }
  };
  const mode = PROVIDER_FAULT_CUTS[cut];
  const observed = events.find(row => row.name === "provider_fault_observed");
  const ended = events.find(row => row.name === "meeting_ended_signalled");

  check("provider_fault_injected", () => {
    requireFact(mode !== undefined, "not a provider-fault cut");
    const fault = observed?.fault;
    requireFact(observed?.mode === mode && fault?.mode === mode, "the scripted provider did not inject the selected fault");
    if (mode === "connect") requireFact(fault.refusedConnections >= 1 && fault.appendedBefore === 0 && summary?.interactiveConnections?.recognition === 0,
      "connect fault did not refuse every recognition upgrade");
    else requireFact(fault.appendedBefore > 0 && ns(fault.monotonicNs) >= ns(observed.armedMonotonicNs), "mid-stream fault fired before recognition streamed");
    return mode === "connect" ? `${fault.refusedConnections} recognition upgrades refused with HTTP 503`
      : `${mode} injected after ${fault.appendedBefore} recognition appends; ${fault.refusedConnections} later upgrades refused`;
  });

  check("provider_fault_distinct_event", () => {
    const { start, rows } = startedSessionRows(lifecycle);
    const failures = rows.filter(row => row.event === "voice" && row.type === "voice_session_failed");
    // A withheld flush ACK fails the interrupt of the held answer: the Runtime reports
    // that once as a continue_session playback failure, and only on the withheld cut.
    const withheld = PROVIDER_FAULT_SPEAKING[cut] === true;
    const stageOf = row => row.error?.stage;
    requireFact(failures.some(row => stageOf(row) === "speech_recognizer"), "the recognition failure never reached the client");
    requireFact(failures.every(row => row.session_id === start.session_id && row.recovery === "continue_session" &&
      (stageOf(row) === "speech_recognizer" || (withheld && stageOf(row) === "continuous_audio_output"))),
    "a voice failure was not a continue_session speech_recognizer event of the live session");
    const playbackFailures = failures.filter(row => stageOf(row) === "continuous_audio_output").length;
    requireFact(!withheld || playbackFailures === 1, "the withheld flush was not reported once as a continue_session playback failure");
    const traced = runtimeEvents.filter(row => row.type === "voice_session_failed");
    requireFact(traced.length === failures.length && traced.some(row => row.monotonicNs === observed?.failureMonotonicNs && row.session_id === start.session_id) &&
      ns(observed.failureMonotonicNs) >= ns(observed.armedMonotonicNs), "the observed failure is not the traced Runtime event after the fault");
    return `${failures.length - playbackFailures} speech_recognizer and ${playbackFailures} continuous_audio_output continue_session voice_session_failed event(s) on session ${start.session_id}, kept in the run evidence`;
  });

  check("voice_session_survives_provider_fault", () => {
    requireFact(ended, "the meeting end was never signalled");
    const voice = voiceEndEvidence({ lifecycle, bridge: childState });
    const end = voice.voiceSessionEnded;
    requireFact(end.observed && end.via === "voice_session_ended" && end.side === "meeting_stop" && end.initiatorOutcome === "accepted",
      `the voice session ended by ${end.side} via ${end.via}, not by Meeting's own stop`);
    requireFact(voice.lifecycle.otherVoiceSessions === 0 && voice.lifecycle.gatewayProcessesWithVoice === 1, "the failure replaced the voice session or the gateway");
    const { rows } = startedSessionRows(lifecycle);
    const stops = rows.filter(row => row.event === "client_command" && ["stop_voice_session", "finalize_recording"].includes(row.type));
    requireFact(stops.length > 0 && stops.every(row => ns(row.monotonicNs) > ns(ended.monotonicNs)), "Meeting stopped or finalized before the meeting ended");
    const endRow = rows.find(row => row.event === "voice" && row.type === "voice_session_ended");
    requireFact(endRow && ns(endRow.monotonicNs) > ns(ended.monotonicNs), "the voice session ended before the meeting ended");
    return `one voice session from start to Meeting's stop after the meeting ended; first stop command ${stops[0].type}`;
  });

  check("no_bridge_leave_on_provider_fault", () => {
    requireFact(childState?.left === "ended" && childState.endObservation, "the bridge did not observe the scripted meeting end");
    const leave = childState.leave, endAt = ns(childState.endObservation.observationTiming.hostBeforeNs);
    requireFact(childState.commands.filter(type => type === "leave").length <= 1, "more than one leave command");
    requireFact(leave === null || (leave.reason === "meeting_ended" && ns(leave.monotonicNs) >= endAt), "Meeting told the bridge to leave before the meeting ended");
    return leave === null ? "no leave command" : "the only leave follows the bridge's own meeting end";
  });

  check("recorded_capture_after_provider_fault", () => {
    const { binding, entries } = selectedAlignment(snapshot);
    const boundary = childState?.captureDrain?.boundary, armed = observed?.armedCapture, atFailure = observed?.captureAtFailure;
    requireFact(childState?.captureDrain?.drain === "confirmed" && boundary && armed && atFailure &&
      armed.captureEpoch === boundary.captureEpoch && atFailure.captureEpoch === boundary.captureEpoch, "missing confirmed drain or fault capture positions");
    const begin = ns(armed.sequence), end = ns(boundary.lastFrameSequence);
    requireFact(end >= ns(atFailure.sequence) + FRAMES_AFTER_FAILURE, `fewer than ${FRAMES_AFTER_FAILURE} frames captured after Runtime reported the failure`);
    const frames = entries.filter(row => row.kind === "frame" && row.provenance?.sequence > begin && row.provenance.sequence <= end &&
      row.epoch?.captureEpoch.toString() === boundary.captureEpoch);
    requireFact(BigInt(frames.length) === end - begin, `recorded ${frames.length} of ${end - begin} frames after the fault`);
    let previous = null;
    for (let i = 0; i < frames.length; i += 1) {
      const frame = frames[i], p = frame.provenance;
      requireFact(frame.captureStatus === "available" && frame.epoch.bridgeSessionId === binding.bridge_session_id && p.sequence === begin + BigInt(i + 1) &&
        p.sampleCount === 480 && frame.mediaEndSample - frame.mediaStartSample === 480n && (previous === null || previous === frame.mediaStartSample) &&
        !frame.reasons.includes("audio_missing"), "recorded capture discontinuity after the fault");
      previous = frame.mediaEndSample;
    }
    return `${frames.length} contiguous recorded frames, sequence ${begin + 1n}..${end}; ${end - ns(atFailure.sequence)} after Runtime reported the failure`;
  });

  if (Object.hasOwn(PROVIDER_FAULT_SPEAKING, cut)) check("speaking_turn_ends_once_on_provider_fault", () => {
    const speaking = observed?.speaking, withheld = PROVIDER_FAULT_SPEAKING[cut];
    requireFact(speaking?.turn && speaking.generation && speaking.withholdFlushAck === withheld, "the failure was not injected while an answer was held");
    // The Runtime ends the interrupted answer, then publishes the failure that caused the
    // interrupt: the terminal follows the fault and lies within the window of the failure.
    const terminals = runtimeEvents.filter(row => ["turn_completed", "turn_cancelled", "turn_failed"].includes(row.event?.type) && row.event.turn_id === speaking.turn);
    const terminalNs = terminals.length === 1 ? ns(terminals[0].monotonicNs) : null, failureNs = ns(observed.failureMonotonicNs);
    requireFact(terminalNs !== null && ["turn_cancelled", "turn_failed"].includes(terminals[0].event.type) &&
      terminals[0].session_id === speaking.sessionId && terminalNs >= ns(observed.fault.monotonicNs) &&
      (terminalNs >= failureNs ? terminalNs - failureNs : failureNs - terminalNs) <= FAILURE_AFTER_TERMINAL_NS,
    "the held answer did not end exactly once, on the live session, after the fault and at its reported failure");
    const flushes = withheld ? childState?.withheldFlushes : childState?.flushes;
    requireFact((flushes ?? []).some(row => row.generation === speaking.generation), withheld ? "no flush reached the bridge to withhold" : "the bridge never acknowledged the held answer's flush");
    return `held answer ${speaking.turn} ended by ${terminals[0].event.type}; flush ${withheld ? "withheld" : "acknowledged"} by the bridge`;
  });

  check("provider_fault_not_a_recording_gap", () => {
    requireFact(snapshot.runtimeGaps.length === 0 && !snapshot.gaps.some(row => row.direction === "capture"), "the recording carries a gap");
    requireFact(artifact === null || (Array.isArray(artifact.meeting.recording_gaps) && artifact.meeting.recording_gaps.length === 0), "the artifact reports a recording gap");
    return artifact === null ? "no recording gap; no artifact to read" : "no recording gap in the reopened store or the artifact";
  });
  return checks;
}

/** Bundle block: what was injected and what the evidence kept. Tokens and clocks only. */
export function providerFaultMetadata({ cut, events, lifecycle, artifact }) {
  const observed = events.find(row => row.name === "provider_fault_observed") ?? null;
  let failures = [];
  try { failures = startedSessionRows(lifecycle).rows.filter(row => row.event === "voice" && row.type === "voice_session_failed"); } catch { /* reported by the oracles */ }
  return {
    cut, mode: PROVIDER_FAULT_CUTS[cut] ?? null, speaking: observed?.speaking ?? null,
    providerFault: observed?.fault ?? null, armedCapture: observed?.armedCapture ?? null,
    captureAtFailure: observed?.captureAtFailure ?? null, captureAfterFailure: observed?.captureAfterFailure ?? null,
    runtimeFailures: failures.map(row => ({ session_id: row.session_id ?? null, recovery: row.recovery ?? null, error: row.error ?? null, monotonicNs: row.monotonicNs ?? null })),
    artifactRecordingGaps: artifact ? artifact.meeting.recording_gaps?.length ?? null : null,
    artifactProcessingWarningCodes: artifact ? (artifact.meeting.processing_warnings ?? []).map(row => row.code) : null,
  };
}
