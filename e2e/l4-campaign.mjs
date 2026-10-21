// Private finite campaign inputs. Production codecs/reconciliation own durable facts.
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import process from "node:process";

export const L4_TEXT = "The synthetic budget is seven.";
export const L4_A = "ou_l4_speaker", L4_S = "ou_l4_silent";
export const L4_B = "ou_l4_candidate_b";
const CASES = ["sent-named", "unavailable-missing", "sent-drop", "sent-conflict"];
const requireFact = (value, code) => { if (!value) throw new Error(code); };
function plainData(value, array = false) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === (array ? Array.prototype : Object.prototype) &&
    Reflect.ownKeys(value).every(key => typeof key === "string" && (!array || key === "length" || /^(0|[1-9][0-9]*)$/.test(key)) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"));
}
export function l4Configuration(options) {
  requireFact(plainData(options), "l4_selection_refused");
  if (options.l4Case === undefined) return {};
  requireFact(CASES.includes(options.l4Case) && options.interactive === true &&
    options.mediaTiming === undefined && !options.r2Baseline && !options.d2Cut && !options.onlyRefusals && !options.packageRefusals &&
    options.observationPlan === undefined && (options.participants === undefined || Array.isArray(options.participants) && options.participants.length === 0), "l4_selection_refused");
  return { l4Case: options.l4Case };
}
export const l4PlanHash = plan => createHash("sha256").update(JSON.stringify(plan)).digest("hex");
export function compileL4Plan(l4Case, origin) {
  l4Configuration({ l4Case, interactive: true });
  requireFact(plainData(origin) && typeof origin?.hostNs === "string" && /^(0|[1-9][0-9]{0,19})$/.test(origin.hostNs) &&
    Number.isSafeInteger(origin.wallMs) && origin.wallMs >= 0, "l4_origin_refused");
  const base = BigInt(origin.hostNs), events = [];
  requireFact(base + 4900000000n <= 18446744073709551615n, "l4_origin_refused");
  if (l4Case === "sent-conflict") {
    const addNs = (offset, payload) => {
      const due = base + offset;
      events.push({ emitAtHostNs: due.toString(), event: { ...payload, observedAt: new Date(origin.wallMs + Number(offset / 1000000n)).toISOString(),
        observationTiming: { clockDomainId: "e2e-clock", hostBeforeNs: (due - 1n).toString(), hostAfterNs: due.toString() },
        ...(payload.type === "ui_snapshot" ? {} : { observationTimingReason: null }) } });
    };
    addNs(1000000000n, { type: "participant_joined", feishuUserId: L4_A, displayName: "Speaker A" });
    addNs(1010000000n, { type: "participant_joined", feishuUserId: L4_B, displayName: "Candidate B" });
    for (let k = 0; k < 30; k++) for (let j = 0; j < 2; j++) addNs(1450000000n + BigInt(k) * 20000000n + BigInt(j), {
      type: "ui_snapshot", snapshotSequence: 2 * k + j + 1, state: "ui_exact", feishuUserId: j === 0 ? L4_A : L4_B, reason: null,
      barrierBefore: k === 0 && j === 0 ? "stream_start" : null });
    addNs(4500000000n, { type: "participant_left", feishuUserId: L4_A });
    addNs(4900000000n, { type: "participant_left", feishuUserId: L4_B });
    return { schema: "e2e-bridge-observations/v1", disclosure: "sent", events };
  }
  function add(ms, payload) {
    const due = base + BigInt(ms) * 1000000n;
    events.push({ emitAtHostNs: due.toString(), event: { ...payload, observedAt: new Date(origin.wallMs + ms).toISOString(),
      observationTiming: { clockDomainId: "e2e-clock", hostBeforeNs: (due - 1n).toString(), hostAfterNs: due.toString() },
      ...(payload.type !== "ui_snapshot" ? { observationTimingReason: null } : {}) } });
  }
  add(1000, { type: "participant_joined", feishuUserId: L4_A, displayName: "Speaker A" });
  add(1010, { type: "participant_joined", feishuUserId: L4_S, displayName: "Silent S" });
  add(1100, { type: "ui_snapshot", snapshotSequence: 1, state: "unknown", feishuUserId: null, reason: "no_highlight", barrierBefore: "stream_start" });
  let ordinal = 1;
  for (let ms = 1200; ms <= 4200; ms += 100) {
    const drop = l4Case === "sent-drop" && ms === 1300, missing = l4Case === "unavailable-missing";
    ordinal += drop ? 2 : 1;
    add(ms, { type: "ui_snapshot", snapshotSequence: ordinal, state: missing ? "unknown" : "ui_exact", feishuUserId: missing ? null : L4_A,
      reason: missing ? "identity_unavailable" : null, barrierBefore: drop ? "observation_drop" : null });
  }
  add(4500, { type: "participant_left", feishuUserId: L4_A });
  add(4700, { type: "participant_joined", feishuUserId: L4_A, displayName: "Speaker A" });
  add(4800, { type: "participant_left", feishuUserId: L4_A });
  add(4900, { type: "participant_left", feishuUserId: L4_S });
  return { schema: "e2e-bridge-observations/v1", disclosure: l4Case === "unavailable-missing" ? "unavailable" : "sent", events };
}

/** Only bounded counters are retained; payload bytes are checked then discarded. */
export function createSubmittedFrameTracker() {
  let connection = null, appended = 0, valid = true, ready = false;
  return {
    connect(id) { if (connection !== null || typeof id !== "string" || !id) valid = false; connection = id; ready = false; },
    update(id, session) {
      if (connection !== id || ready || !plainData(session) || session.type !== "transcription" || !plainData(session.audio) ||
        !plainData(session.audio.input) || !plainData(session.audio.input.format) || session.audio.input.format.type !== "audio/pcm" || session.audio.input.format.rate !== 24000) valid = false;
      ready = true;
    },
    append(id, audio) {
      if (connection !== id || !ready || typeof audio !== "string" || audio.length !== 1280 ||
        Buffer.from(audio, "base64").length !== 960 || appended >= 3000) valid = false;
      appended += 1;
    },
    close(id) { if (connection === id) { ready = false; valid = false; } },
    snapshot() { return { connection, appended, valid, ready }; },
  };
}
export function submittedTranscriptEvents({ tracker, range, item, previous, text }) {
  requireFact(plainData(tracker) && plainData(range) && tracker.valid && tracker.ready && typeof range?.connection === "string" && range.connection === tracker.connection &&
    Number.isSafeInteger(range.startFrame) && Number.isSafeInteger(range.endFrame) && range.startFrame >= 1 &&
    range.endFrame >= range.startFrame && range.endFrame <= tracker.appended && range.endFrame - range.startFrame + 1 <= 50 &&
    typeof text === "string" && text.length > 0 && text.length <= 200 && typeof item === "string" && item.length > 0, "l4_submitted_range_refused");
  return [
    { type: "input_audio_buffer.speech_started", item_id: item, audio_start_ms: (range.startFrame - 1) * 20 },
    { type: "input_audio_buffer.speech_stopped", item_id: item, audio_end_ms: range.endFrame * 20 },
    { type: "input_audio_buffer.committed", item_id: item, previous_item_id: previous },
    { type: "conversation.item.input_audio_transcription.completed", item_id: item, content_index: 0, transcript: text },
  ];
}
/** Pinned Runtime voice wrappers distinguish input diagnostics from reply output. */
export function l4HasLiveOutput(events) {
  if (!plainData(events, true) || events.length > 20000) return true;
  const replies = ["turn_started", "transcript_final", "quality_resolved", "memory_retrieved", "text_delta", "text_completed", "speech_started", "speech_completed", "timing", "turn_completed", "turn_cancelled", "turn_failed"];
  return events.some(row => !plainData(row) || ["response_authorized", "voice_playback", "voice_turn_event", "voice_barge_in", "playback", "turn_audio", ...replies].includes(row.type) ||
    row.turn_id != null || row.turnId != null || row.event != null && (!plainData(row.event) || replies.includes(row.event.type) || row.event.turn_id != null || row.event.turnId != null) ||
    row.type === "voice_timing" && !["audio_received", "speech_end", "transcript_final", "cleanup"].includes(row.milestone));
}
export async function driveL4Capture({ l4Case, provider, child, runtimeEvents, waitFor, budgetMs, nowHostNs = () => process.hrtime.bigint() }) {
  l4Configuration({ l4Case, interactive: true });
  const conflict = l4Case === "sent-conflict", rows = conflict ? 64 : 38;
  requireFact(Number.isFinite(budgetMs) && budgetMs > 0, "l4_budget_refused");
  const wait = async (check, name) => {
    let failure = null;
    const value = await waitFor(() => { try { return check(); } catch (error) { failure = error; return true; } },
      { budgetMs, name, ...(conflict && name === "l4_observed_readiness" ? { pollMs: 5 } : {}) });
    if (failure) throw failure;
    return value;
  };
  await wait(() => {
    requireFact(!l4HasLiveOutput(runtimeEvents()), "l4_runtime_decision_refused");
    const state = child();
    if (state?.l4?.origin) requireFact(nowHostNs() <= BigInt(state.l4.origin.hostNs) + (conflict ? 1500000000n : 2100000000n), "l4_fixed_window_missed");
    return state?.joined && state.mediaConnected && provider.submitted.ready && provider.submitted.valid && state.observationPlan?.emitted >= 6 &&
      (!conflict || nowHostNs() >= BigInt(state.l4.origin.hostNs) + 1480000000n);
  }, "l4_observed_readiness");
  const state = child(), plan = compileL4Plan(l4Case, state.l4?.origin);
  requireFact(state.l4?.case === l4Case && state.l4.planSha256 === l4PlanHash(plan) &&
    state.observationPlan.planned === rows && state.observationPlan.phase === "running", "l4_plan_binding_refused");
  const now = nowHostNs(), base = BigInt(state.l4.origin.hostNs);
  requireFact(now >= base + (conflict ? 1480000000n : 1400000000n) && now <= base + (conflict ? 1500000000n : 2100000000n), "l4_fixed_window_missed");
  const observed = provider.submitted;
  const range = { connection: observed.connection, startFrame: observed.appended + 1, endFrame: observed.appended + 50 };
  const before = runtimeEvents().length;
  await wait(() => { const current = provider.submitted;
    requireFact(current.valid && current.ready && current.connection === range.connection, "l4_recognition_connection_changed");
    requireFact(nowHostNs() <= base + 3200000000n, "l4_fixed_window_missed");
    return current.appended >= range.endFrame;
  }, "l4_submitted_window");
  await wait(() => child()?.observationPlan?.emitted >= 18, "l4_following_confirmation");
  requireFact(nowHostNs() <= base + 3300000000n, "l4_fixed_window_missed");
  provider.transcript(L4_TEXT, range);
  const final = await wait(() => runtimeEvents().slice(before).find(row => row.type === "voice_transcript_final"), "l4_runtime_final");
  await wait(() => runtimeEvents().slice(before).some(row => row.type === "response_skipped" && row.segment_id === final.segment_id && row.session_id === final.session_id), "l4_runtime_skip");
  await wait(() => child()?.observationPlan?.phase === "completed" && child()?.observationPlan?.emitted === rows, "l4_observations_complete");
  const decisions = runtimeEvents().slice(before);
  requireFact(decisions.filter(row => row.type === "voice_transcript_final").length === 1 && decisions.filter(row => row.type === "response_skipped").length === 1 &&
    !l4HasLiveOutput(runtimeEvents()) &&
    !(provider.calls ?? []).some(row => row.route === "language" || row.route === "speech"), "l4_runtime_decision_refused");
  return { case: l4Case, origin: state.l4.origin, planSha256: state.l4.planSha256, range, segmentId: final.segment_id, runtimeSessionId: final.session_id, rawRows: rows };
}

/** The caller always releases the existing composition controller, including failures. */
export async function closeL4Composition({ getApplication, controller }) {
  try { const app = getApplication(); if (app) await app.close(); }
  finally { controller.abort(); }
}

/** The ONLY identity input is a named segment in the actual canonical transcript. */
export function l4PersonSummaries(messages, l4Case) {
  requireFact(plainData(messages, true) && messages.length <= 32 && messages.every(message => plainData(message)), "l4_synthesis_input_refused");
  const canonical = messages.filter(message => typeof message.content === "string").flatMap(message => {
    // The synthesis input is { known_projects, transcript }; its transcript is the canonical array.
    try {
      const parsed = JSON.parse(message.content);
      return plainData(parsed) && Object.keys(parsed).sort().join() === "known_projects,transcript" && Array.isArray(parsed.transcript) ? [parsed.transcript] : [];
    } catch { return []; }
  });
  if (canonical.length !== 1 || canonical[0].length > 256 || canonical[0].some(row => !plainData(row) ||
    Object.keys(row).length !== 6 || !["segment_id", "text", "speaker", "started_at", "ended_at", "provenance"].every(key => Object.hasOwn(row, key)) ||
    typeof row.segment_id !== "string" || typeof row.text !== "string" || typeof row.started_at !== "string" || typeof row.ended_at !== "string" ||
    !Number.isFinite(Date.parse(row.started_at)) || !Number.isFinite(Date.parse(row.ended_at)) || !plainData(row.speaker) || !plainData(row.provenance) ||
    !["live_stream", "final_batch"].includes(row.provenance.stage) || typeof row.provenance.model !== "string")) return [];
  const named = canonical[0].filter(row => typeof row?.segment_id === "string" && typeof row.text === "string" && row.text.trim() &&
    row.speaker?.kind === "person" && row.speaker.reconciled === true && (row.speaker.person_id === L4_A || l4Case === "sent-conflict" && row.speaker.person_id === L4_B) && typeof row.speaker.display_name === "string" && row.speaker.display_name.length > 0);
  const selected = l4Case === "sent-conflict" ? named.filter((row, index) => named.findIndex(other => other.speaker.person_id === row.speaker.person_id) === index) : named.slice(0, 1);
  return selected.map(row => ({ person_id: row.speaker.person_id, display_name: row.speaker.display_name, text: "Synthetic summary of the named transcript contribution." }));
}

async function productionCodecs() {
  const modules = await Promise.all([
    import("../dist/src/contracts/bridge-session-v2.js"), import("../dist/src/sessions/live-evidence-codec.js"),
    import("../dist/src/sessions/recording-alignment.js"), import("../dist/src/sessions/timed-evidence-merge.js"),
    import("../dist/src/domain/participants.js"), import("../dist/src/contracts/teammem-meeting-v2.js"), import("../dist/src/contracts/teammem-meeting-v1.js"),
  ]);
  return Object.assign({}, ...modules);
}
const one = (rows, code) => { requireFact(rows?.length === 1, code); return rows[0]; };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** Read-only SQL projection; executable never creates or updates a table. */
export async function readL4Evidence(filename, occurrence) {
  const [{ default: Database }, { readDurableEvidence }] = await Promise.all([import("better-sqlite3"), import("./durable-oracles.mjs")]);
  const snapshot = readDurableEvidence(filename, occurrence), db = new Database(filename, { readonly: true });
  try {
    const query = sql => db.prepare(sql).all(occurrence);
    return { ...snapshot,
      owners: query(`SELECT o.*,g.occurrence_id,g.bridge_session_id,g.runtime_session_id FROM timed_evidence_owners o
        JOIN reconciliation_generations g USING(generation_id) WHERE g.occurrence_id=?`),
      ui: query(`SELECT u.* FROM timed_ui_evidence u JOIN reconciliation_generations g USING(generation_id)
        WHERE g.occurrence_id=? ORDER BY u.sequence`),
      deliveries: query("SELECT occurrence_id,revision,artifact_hash,bundle_path,transcript_complete FROM delivery_journal WHERE occurrence_id=?"),
    };
  } finally { db.close(); }
}

/** Source/component callers may supply the same production source functions. */
export function assertL4ReconciledIdentity(unit, l4Case) {
  requireFact(l4Case === "sent-named" ? unit.speaker.kind === "named" && unit.speaker.feishuUserId === L4_A : unit.speaker.kind === (l4Case === "sent-conflict" ? "ambiguous" : "anonymous"), "l4_reconciled_identity");
}
/** Union of authenticated wording-clipped frame samples; point counts confer no duration. */
export function l4ConflictingSamples({ entries, ui, bridgeSessionId, capture, range }, Cursor) {
  const cursor = new Cursor(ui, bridgeSessionId), intervals = [];
  try {
    for (const frame of entries) {
      if (frame.kind !== "frame") continue;
      const observed = cursor.read(frame), p = frame.provenance;
      if (frame.epoch?.captureEpoch !== capture.captureEpoch || frame.epoch.clockDomainId !== capture.clockDomainId ||
        !p || p.sequence < capture.firstFrameSequence || p.sequence > capture.lastFrameSequence ||
        !observed.observedIdentities.includes(L4_A) || !observed.observedIdentities.includes(L4_B)) continue;
      const start = frame.mediaStartSample > range.startSampleInclusive ? frame.mediaStartSample : range.startSampleInclusive;
      const end = frame.mediaEndSample < range.endSampleExclusive ? frame.mediaEndSample : range.endSampleExclusive;
      if (end > start) intervals.push({ start, end });
    }
  } finally { cursor.close(); }
  intervals.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
  let end = range.startSampleInclusive, total = 0n;
  for (const interval of intervals) if (interval.end > end) {
    total += interval.end - (interval.start > end ? interval.start : end); end = interval.end;
  }
  return total;
}
export async function verifyL4Evidence(input, codecs) {
  const c = codecs ?? await productionCodecs(), { snapshot: s, drive, artifact, runtimeEvents, l4Case } = input;
  l4Configuration({ l4Case, interactive: true });
  const conflict = l4Case === "sent-conflict", rows = conflict ? 64 : 38;
  requireFact(input.closed === true, "l4_owner_closure_unavailable");
  const plan = compileL4Plan(l4Case, drive?.origin);
  requireFact(drive.case === l4Case && drive.planSha256 === l4PlanHash(plan) && drive.rawRows === rows, "l4_plan_binding_refused");
  const owner = one(s.owners, "l4_owner_binding"), live = one(s.live, "l4_live_count"), binding = one(s.bindings, "l4_recording_binding");
  requireFact(owner.state === "closed" && owner.live_rows === 1 && live.owner_state === "closed" && live.result !== null &&
    live.capture_complete === 1 && live.incomplete_reason === null && owner.wording_loss_reason === null && live.wording_loss_reason === null, "l4_owner_retention");
  requireFact(owner.generation_id === binding.generation_id && live.generation_id === binding.generation_id &&
    [owner, live, binding].every(row => row.occurrence_id === s.occurrence && row.bridge_session_id === drive.bridgeSessionId) &&
    owner.runtime_session_id === drive.runtimeSessionId && live.runtime_session_id === drive.runtimeSessionId && binding.source_session_id === drive.runtimeSessionId &&
    live.segment_id === drive.segmentId && binding.recording_kind === "final", "l4_source_binding");
  const raw = s.ui.map(row => {
    requireFact(row.generation_id === binding.generation_id, "l4_ui_binding");
    const event = c.parseEventV2(JSON.parse(row.payload));
    requireFact(event.sequence === row.sequence && event.sessionId === drive.bridgeSessionId, "l4_ui_binding"); return event;
  });
  requireFact(raw.length === owner.ui_rows && raw.every((row, i) => i === 0 || row.sequence === raw[i - 1].sequence + 1), "l4_raw_sequence");
  const planned = raw.filter(row => ["participant_joined", "participant_left", "ui_snapshot"].includes(row.type));
  requireFact(planned.length === rows && planned.every((row, i) => {
    const payload = { ...row }; delete payload.schema; delete payload.sessionId; delete payload.sequence;
    return same(Object.entries(payload).sort(), Object.entries(plan.events[i].event).sort());
  }), "l4_raw_plan_mismatch");
  const disclosure = one(raw.filter(row => row.type === "chat_disclosure"), "l4_disclosure_count");
  const result = one(raw.filter(row => row.type === "command_result" && row.commandId === drive.disclosureCommandId), "l4_disclosure_command");
  requireFact(disclosure.outcome === plan.disclosure && result.outcome === (plan.disclosure === "sent" ? "ok" : "failed") &&
    result.sequence === disclosure.sequence + 1, "l4_disclosure_outcome");
  const expectedLoss = l4Case === "sent-drop" ? "ui_sequence_gap" : null;
  requireFact(owner.ui_loss_reason === expectedLoss && live.ui_loss_reason === expectedLoss, "l4_selected_ui_loss");
  const final = one(runtimeEvents.filter(row => row.type === "voice_transcript_final"), "l4_actual_final_count");
  const skip = one(runtimeEvents.filter(row => row.type === "response_skipped"), "l4_actual_skip_count");
  requireFact([final, skip].every(row => row.segment_id === drive.segmentId && row.session_id === drive.runtimeSessionId), "l4_runtime_binding");
  requireFact(!l4HasLiveOutput(runtimeEvents) &&
    !(input.providerCalls ?? []).some(row => row.route === "speech" || row.route === "language") &&
    input.child?.playback?.length === 0 && input.child?.flushes?.length === 0, "l4_unexpected_speech");
  const evidence = c.decodeLiveEvidence(live.evidence, live.text); c.decodeProvisionalResult(live.result);
  requireFact(evidence.sessionId.toString() === drive.runtimeSessionId && evidence.segmentId === drive.segmentId && live.text === L4_TEXT &&
    evidence.turnId === null && evidence.capture && evidence.liveCoverage && evidence.captureUnavailableReason === undefined, "l4_capture_unavailable");
  const capture = evidence.capture, selected = one(s.selected, "l4_selected_count"), attempt = one(s.attempts.filter(row => row.attempt_id === selected.attempt_id), "l4_selected_attempt");
  const recording = one(s.recordings, "l4_recording_count");
  requireFact(selected.generation_id === binding.generation_id && attempt.generation_id === binding.generation_id &&
    attempt.state === "complete" && attempt.timing_contract === "capture-clock/v1" && ["available", "partial"].includes(attempt.coverage_status), "l4_selected_incomplete");
  requireFact(recording.occurrence_id === s.occurrence && recording.format === "pcm_s16le/24000/1" &&
    recording.handle === binding.recording_handle && recording.sha256 === binding.sha256 && recording.key_id === binding.key_id &&
    attempt.recording_handle === binding.recording_handle && attempt.sha256 === binding.sha256 && attempt.key_id === binding.key_id &&
    attempt.source_session_id === binding.source_session_id, "l4_selected_source_binding");
  const pages = s.pages.filter(row => row.attempt_id === selected.attempt_id).sort((a, b) => a.page_index - b.page_index);
  requireFact(pages.length === attempt.page_count && pages.length > 0 && pages.reduce((n, row) => n + row.entry_count, 0) === attempt.entry_count &&
    pages.reduce((n, row) => n + Buffer.byteLength(row.payload), 0) === attempt.stored_bytes, "l4_selected_totals");
  const decoded = pages.map((row, i) => { const page = c.decodeAlignmentPage(row.payload);
    requireFact(row.page_index === i && page.pageIndex === BigInt(i) && row.entry_count === page.entries.length &&
      page.source.sourceSessionId.toString() === drive.runtimeSessionId && page.source.recordingHandle === recording.handle && page.source.sha256 === recording.sha256,
    "l4_selected_page_binding"); return page; });
  const warnings = JSON.parse(attempt.warnings_json);
  requireFact(same([...new Set(decoded.flatMap(c.pageWarnings))].sort(), [...warnings].sort()), "l4_selected_warnings");
  const entries = decoded.flatMap(page => page.entries), allFrames = entries.filter(row => row.kind === "frame");
  requireFact(allFrames.length && allFrames.every(frame => frame.sampleRateHz === 24000 && frame.epoch?.bridgeSessionId === drive.bridgeSessionId) &&
    BigInt(recording.duration_ms) === allFrames.at(-1).mediaEndSample * 1000n / 24000n + allFrames.at(-1).gapOffsetMs, "l4_recording_timeline");
  const frames = allFrames.filter(frame => frame.epoch?.captureEpoch === capture.captureEpoch && frame.provenance?.sequence >= capture.firstFrameSequence && frame.provenance.sequence <= capture.lastFrameSequence);
  requireFact(drive.range?.endFrame - drive.range?.startFrame + 1 === 50 && capture.sourceEndSample - capture.sourceStartSample === 24000n &&
    capture.lastFrameSequence - capture.firstFrameSequence + 1n === 50n && frames.length === 50 && capture.clockDomainId === "e2e-clock", "l4_capture_intersection");
  let sourceEnd = capture.sourceStartSample;
  const base = BigInt(drive.origin.hostNs);
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i], p = frame.provenance;
    requireFact(frame.captureStatus === "available" && frame.wall && p.span && frame.epoch.clockDomainId === capture.clockDomainId &&
      p.captureEpoch === capture.captureEpoch && p.sequence === capture.firstFrameSequence + BigInt(i) && p.outputStartSample === sourceEnd && p.sampleCount === 480 &&
      frame.mediaEndSample - frame.mediaStartSample === 480n && p.span.hostStartNs >= base + 1400000000n && p.span.hostEndNs <= base + 3300000000n,
    "l4_capture_window");
    sourceEnd += 480n;
  }
  requireFact(sourceEnd === capture.sourceEndSample && !entries.some(row => row.kind === "audio_gap") && s.gaps.length === 0 && s.runtimeGaps.length === 0, "l4_audio_loss");
  if (conflict) requireFact(frames[0].provenance.span.hostStartNs >= base + 1460000000n && frames[0].provenance.span.hostStartNs <= base + 1500000000n, "l4_conflict_frame_phase");
  const merged = await c.mergeTimedRecordingEvidence({ source: decoded[0].source, bridgeSessionId: drive.bridgeSessionId, entries, ui: raw,
    live: [evidence], final: { unavailable: true }, uiLossReason: expectedLoss, wordingLossReason: null });
  const unit = one(merged.segments, "l4_reconciled_count");
  requireFact(unit.range && unit.range.endSampleExclusive - unit.range.startSampleInclusive === 24000n && unit.wall &&
    unit.liveSegmentIds.length === 1 && unit.liveSegmentIds[0] === drive.segmentId && unit.wording === "live", "l4_reconciled_capture");
  assertL4ReconciledIdentity(unit, l4Case);
  const conflictingSamples = conflict ? l4ConflictingSamples({ entries, ui: raw, bridgeSessionId: drive.bridgeSessionId, capture, range: unit.range }, c.FrameUiCursor) : null;
  if (conflict) requireFact(conflictingSamples > 12000n && conflictingSamples <= 24000n, "l4_conflict_sample_threshold");
  requireFact(artifact?.files && ["READY", "audio.enc", "manifest.json", "meeting.json"].every(name => artifact.files.includes(name)), "l4_ready_bundle_missing");
  const meeting = c.parseSupportedTeamMemMeetingArtifact(artifact.meeting);
  requireFact(meeting.schema === "teammem-meeting/v2" && meeting.occurrence_id === s.occurrence && artifact.occurrenceId === s.occurrence &&
    artifact.revision === meeting.revision && artifact.hash === c.canonicalArtifactHash(meeting) && meeting.audio.sha256 === `sha256:${recording.sha256}`, "l4_artifact_hash_binding");
  const delivery = one(s.deliveries.filter(row => row.revision === artifact.revision), "l4_delivery_missing");
  requireFact(delivery.occurrence_id === s.occurrence && delivery.artifact_hash === artifact.hash && delivery.bundle_path === artifact.bundleDir &&
    delivery.transcript_complete === Number(meeting.transcript_complete), "l4_delivery_binding");
  const segment = one(meeting.transcript, "l4_artifact_transcript_count");
  requireFact(segment.segment_id === unit.segmentId && segment.text === L4_TEXT && segment.provenance.stage === "live_stream" &&
    segment.started_at === unit.wall.startedAt && segment.ended_at === unit.wall.endedAt, "l4_artifact_live_binding");
  requireFact(l4Case === "sent-named" ? segment.speaker.kind === "person" && segment.speaker.person_id === L4_A : segment.speaker.kind === (conflict ? "ambiguous" : "anonymous"), "l4_artifact_identity");
  const intervals = c.reduceAttendance(raw.flatMap(row => row.type === "participant_joined" ? [{ type: row.type, feishuUserId: row.feishuUserId, displayName: row.displayName,
    occurredAt: row.observedAt, sequence: row.sequence, bridgeSessionId: row.sessionId }] : row.type === "participant_left" ? [{ type: row.type, feishuUserId: row.feishuUserId,
    occurredAt: row.observedAt, sequence: row.sequence, bridgeSessionId: row.sessionId }] : []));
  const grouped = [L4_A, conflict ? L4_B : L4_S].map(id => ({ person_id: id, display_name: intervals.find(row => row.feishuUserId === id)?.displayName,
    attendance: intervals.filter(row => row.feishuUserId === id).map(row => ({ joined_at: row.joinedAt, left_at: row.leftAt })) }));
  requireFact(intervals.length === (conflict ? 2 : 3) && grouped[0].attendance.length === (conflict ? 1 : 2) && grouped[1].attendance.length === 1 && same(meeting.participants, grouped), "l4_observed_attendance");
  requireFact(l4Case === "sent-named" ? meeting.person_summaries.length === 1 && meeting.person_summaries[0].person_id === L4_A : meeting.person_summaries.length === 0, "l4_summary_identity");
  requireFact(meeting.processing_warnings.filter(row => row.code === "timed_ui_evidence_loss").length === (expectedLoss ? 1 : 0) &&
    (!expectedLoss || meeting.processing_warnings.some(row => row.code === "timed_ui_evidence_loss" && row.detail === expectedLoss)) &&
    !meeting.processing_warnings.some(row => row.code === "timed_capture_loss"), "l4_artifact_ui_warning");
  if (conflict) requireFact(meeting.transcript_complete === merged.transcriptComplete, "l4_transcript_complete_truth");
  return { case: l4Case, disposition: "source-bound_scripted_campaign", planSha256: drive.planSha256,
    occurrenceId: s.occurrence, generationId: binding.generation_id, bridgeSessionId: drive.bridgeSessionId, runtimeSessionId: drive.runtimeSessionId,
    alignmentAttemptId: attempt.attempt_id, recordingSha256: recording.sha256, artifactHash: artifact.hash, artifactRevision: artifact.revision,
    rawRows: rows, disclosure: disclosure.outcome, capture: { firstFrame: capture.firstFrameSequence.toString(), lastFrame: capture.lastFrameSequence.toString(),
      sourceStartSample: capture.sourceStartSample.toString(), sourceEndSample: capture.sourceEndSample.toString(), samples: "24000", frames: 50 },
    attendance: grouped, warnings: meeting.processing_warnings.map(row => row.code), transcriptComplete: meeting.transcript_complete,
    summaries: conflict ? { A: meeting.person_summaries.some(row => row.person_id === L4_A), B: meeting.person_summaries.some(row => row.person_id === L4_B) } : { A: meeting.person_summaries.some(row => row.person_id === L4_A), S: false },
    ...(conflict ? { conflictingSamples: conflictingSamples.toString(), speakerKind: unit.speaker.kind } : {}) };
}

/** Public bundle is a whitelist. Raw private traces remain in the owned root. */
export function l4Report(input) {
  const array = (value, maximum) => plainData(value, true) && value.length <= maximum && Object.keys(value).length === value.length;
  const shape = (value, keys) => plainData(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  const uint = (value, maximum) => typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= maximum;
  const instant = value => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3}(?:\d{3})?)?Z$/.test(value)) return null;
    const normalized = value.replace(/(\.\d{3})\d{3}Z$/, "$1Z").replace(/(?<=:\d{2})Z$/, ".000Z"), ms = Date.parse(normalized);
    return Number.isSafeInteger(ms) && ms >= 0 && new Date(ms).toISOString() === normalized ? ms : null;
  };
  requireFact(plainData(input) && CASES.includes(input.l4Case) && array(input.checks, 128) &&
    input.checks.every(row => plainData(row) && typeof row.name === "string" && /^[a-z_0-9]{1,80}$/.test(row.name) &&
      ["pass", "fail", "skipped", "blocked"].includes(row.status)) && new Set(input.checks.map(row => row.name)).size === input.checks.length &&
    plainData(input.processCleanup) && typeof input.processCleanup.cleanupConfirmed === "boolean", "l4_report_input_refused");
  const metadata = input.metadata;
  const conflict = input.l4Case === "sent-conflict";
  let facts = null;
  if (metadata !== null && metadata !== undefined) {
    const scalars = ["case", "disposition", "planSha256", "occurrenceId", "generationId", "bridgeSessionId", "runtimeSessionId", "alignmentAttemptId",
      "recordingSha256", "artifactHash", "artifactRevision", "rawRows", "disclosure", "transcriptComplete", ...(conflict ? ["conflictingSamples", "speakerKind"] : [])];
    requireFact(shape(metadata, [...scalars, "capture", "summaries", "attendance", "warnings"]) && metadata.case === input.l4Case &&
      metadata.disposition === "source-bound_scripted_campaign" && metadata.rawRows === (conflict ? 64 : 38) && typeof metadata.transcriptComplete === "boolean" &&
      (!conflict || uint(metadata.conflictingSamples, 24000n) && BigInt(metadata.conflictingSamples) > 12000n && metadata.speakerKind === "ambiguous") &&
      typeof metadata.planSha256 === "string" && /^[a-f0-9]{64}$/.test(metadata.planSha256) &&
      typeof metadata.recordingSha256 === "string" && /^[a-f0-9]{64}$/.test(metadata.recordingSha256) &&
      typeof metadata.artifactHash === "string" && /^sha256:[a-f0-9]{64}$/.test(metadata.artifactHash) &&
      Number.isSafeInteger(metadata.artifactRevision) && metadata.artifactRevision >= 1 && metadata.artifactRevision <= 1000000 &&
      typeof metadata.bridgeSessionId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(metadata.bridgeSessionId) &&
      uint(metadata.runtimeSessionId, 18446744073709551615n) && metadata.runtimeSessionId !== "0" &&
      typeof metadata.alignmentAttemptId === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(metadata.alignmentAttemptId) &&
      typeof metadata.occurrenceId === "string" && /^[1-9][0-9]{0,19}@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(metadata.occurrenceId) &&
      instant(metadata.occurrenceId.split("@")[1]) !== null &&
      metadata.generationId === Buffer.from(metadata.occurrenceId).toString("hex") + ":" + Buffer.from(metadata.bridgeSessionId).toString("hex") &&
      metadata.disclosure === (input.l4Case === "unavailable-missing" ? "unavailable" : "sent") &&
      shape(metadata.capture, ["firstFrame", "lastFrame", "sourceStartSample", "sourceEndSample", "samples", "frames"]) &&
      uint(metadata.capture.firstFrame, 3000n) && metadata.capture.firstFrame !== "0" && uint(metadata.capture.lastFrame, 3000n) &&
      BigInt(metadata.capture.lastFrame) - BigInt(metadata.capture.firstFrame) === 49n &&
      uint(metadata.capture.sourceStartSample, 1440000n) && uint(metadata.capture.sourceEndSample, 1440000n) &&
      BigInt(metadata.capture.sourceEndSample) - BigInt(metadata.capture.sourceStartSample) === 24000n &&
      metadata.capture.samples === "24000" && metadata.capture.frames === 50 &&
      shape(metadata.summaries, ["A", conflict ? "B" : "S"]) && metadata.summaries.A === (input.l4Case === "sent-named") && metadata.summaries[conflict ? "B" : "S"] === false &&
      array(metadata.attendance, 2) && metadata.attendance.length === 2 && metadata.attendance.every((person, index) =>
        shape(person, ["person_id", "display_name", "attendance"]) && person.person_id === [L4_A, conflict ? L4_B : L4_S][index] &&
        person.display_name === ["Speaker A", conflict ? "Candidate B" : "Silent S"][index] && array(person.attendance, 2) && person.attendance.length === (!conflict && index === 0 ? 2 : 1) &&
        person.attendance.every(row => shape(row, ["joined_at", "left_at"]) && instant(row.joined_at) !== null && instant(row.left_at) !== null)) &&
      array(metadata.warnings, 8) && new Set(metadata.warnings).size === metadata.warnings.length && metadata.warnings.every(code =>
        ["local_wall_timestamp_estimate", "timed_ui_evidence_loss", "timed_final_processing_incomplete", "timed_cluster_conflict", "timed_live_outside_final", "runtime_text_warning"].includes(code)) &&
      metadata.warnings.includes("local_wall_timestamp_estimate") && metadata.warnings.includes("timed_ui_evidence_loss") === (input.l4Case === "sent-drop"), "l4_report_input_refused");
    const a = metadata.attendance[0].attendance, s = metadata.attendance[1].attendance, start = instant(a[0].joined_at);
    requireFact(instant(a[0].left_at) - start === 3500 && (conflict || instant(a[1].joined_at) - start === 3700 && instant(a[1].left_at) - start === 3800) &&
      instant(s[0].joined_at) - start === 10 && instant(s[0].left_at) - start === 3900, "l4_report_input_refused");
    const pick = (row, keys) => Object.fromEntries(keys.map(key => [key, row[key]]));
    facts = { ...pick(metadata, scalars), capture: pick(metadata.capture, ["firstFrame", "lastFrame", "sourceStartSample", "sourceEndSample", "samples", "frames"]),
      summaries: pick(metadata.summaries, ["A", conflict ? "B" : "S"]), attendance: metadata.attendance.map(person => ({ ...pick(person, ["person_id"]),
        attendance: person.attendance.map(row => pick(row, ["joined_at", "left_at"])) })),
      warnings: [...metadata.warnings] };
  }
  return { schema: "meeting-l4-report/v1", label: "scripted local application test readiness", case: input.l4Case,
    disposition: facts && input.processCleanup.cleanupConfirmed === true && !input.checks.some(row => row.status === "fail") &&
      ["l4_selected_campaign", "artifact_bundle", "shutdown_clean", "no_key_or_plaintext_audio", "no_orphan_process", "no_closed_store_callback", "single_occurrence_identity"]
        .every(name => input.checks.some(row => row.name === name && row.status === "pass")) ? "observed-scripted-campaign" : "prerequisite-failed-or-unknown",
    facts, cleanupConfirmed: input.processCleanup.cleanupConfirmed === true, publication: "untested",
    checks: input.checks.map(row => ({ name: row.name, status: row.status })) };
}
