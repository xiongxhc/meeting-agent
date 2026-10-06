// Test-only reopened application evidence; never a Runtime wire parser.
import Database from "better-sqlite3";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { decodeLiveEvidence, decodeProvisionalResult } from "../dist/src/sessions/live-evidence-codec.js";
import { decodeAlignmentPage, pageWarnings } from "../dist/src/sessions/recording-alignment.js";

function requireFact(value, reason) { if (!value) throw new Error(reason); }
function one(rows, reason) { requireFact(rows.length === 1, reason); return rows[0]; }

export function readDurableEvidence(filename, occurrence) {
  const db = new Database(filename, { readonly: true });
  const query = (sql) => db.prepare(sql).all(occurrence);
  try {
    return { occurrence,
      live: query(`SELECT e.*, g.occurrence_id, g.bridge_session_id, g.runtime_session_id, g.capture_complete, g.incomplete_reason,
        o.state AS owner_state, o.live_rows, o.ui_loss_reason, o.wording_loss_reason
        FROM timed_live_evidence e JOIN reconciliation_generations g USING(generation_id)
        JOIN timed_evidence_owners o USING(generation_id) JOIN sessions s USING(occurrence_id)
        WHERE s.occurrence_id = ?`),
      recordings: query(`SELECT occurrence_id,handle,sha256,key_id,duration_ms,format,capture_drain,capture_drain_reason,
        capture_drain_epoch,capture_drain_last_frame_sequence,capture_drain_output_end_sample,capture_drain_final_pair_sequence
        FROM recordings WHERE occurrence_id = ?`),
      gaps: query("SELECT ordinal,direction,started_at,ended_at FROM recording_gaps WHERE occurrence_id=? ORDER BY ordinal"),
      runtimeGaps: query("SELECT ordinal,started_at_ms,ended_at_ms,reason FROM recording_runtime_gaps WHERE occurrence_id=? ORDER BY ordinal"),
      bindings: query(`SELECT generation_id,occurrence_id,bridge_session_id,source_session_id,recording_handle,sha256,key_id,recording_kind
        FROM recording_recovery_bindings WHERE occurrence_id=?`),
      selected: query(`SELECT s.* FROM recording_alignment_selected s JOIN recording_recovery_bindings b USING(generation_id) WHERE b.occurrence_id=?`),
      attempts: query(`SELECT a.attempt_id,a.generation_id,a.source_session_id,a.recording_handle,a.sha256,a.key_id,a.timing_contract,
        a.state,a.page_count,a.entry_count,a.stored_bytes,a.coverage_status,a.warnings_json
        FROM recording_alignment_attempts a JOIN recording_recovery_bindings b USING(generation_id) WHERE b.occurrence_id=?`),
      pages: query(`SELECT p.* FROM recording_alignment_pages p JOIN recording_alignment_selected s USING(attempt_id)
        JOIN recording_recovery_bindings b USING(generation_id) WHERE b.occurrence_id=? ORDER BY p.page_index`),
    };
  } finally { db.close(); }
}

export function readRuntimeTrace(filename) {
  const rows = readFileSync(filename, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  requireFact(rows.length > 0, "missing Runtime trace");
  return rows;
}

function selectedAlignment(snapshot) {
  const recording = one(snapshot.recordings, "missing or ambiguous finalized recording");
  const binding = one(snapshot.bindings.filter(row => row.recording_kind === "final"), "missing or ambiguous final recovery binding");
  const selected = one(snapshot.selected.filter(row => row.generation_id === binding.generation_id), "missing selected attempt");
  const attempt = one(snapshot.attempts.filter(row => row.attempt_id === selected.attempt_id), "missing selected attempt metadata");
  requireFact(binding.occurrence_id === snapshot.occurrence && recording.occurrence_id === snapshot.occurrence &&
    attempt.generation_id === binding.generation_id && attempt.state === "complete" && attempt.timing_contract === "capture-clock/v1",
  "selected attempt is not COMPLETE and bound");
  for (const [recordingKey, key] of [["handle", "recording_handle"], ["sha256", "sha256"], ["key_id", "key_id"]]) {
    requireFact(recording[recordingKey] === binding[key] && attempt[key] === binding[key], "recording identity mismatch");
  }
  requireFact(attempt.source_session_id === binding.source_session_id && recording.format === "pcm_s16le/24000/1", "source or format mismatch");
  requireFact(["available", "partial"].includes(attempt.coverage_status), "recorded capture coverage unavailable");
  const pages = snapshot.pages.filter(row => row.attempt_id === selected.attempt_id).sort((a, b) => a.page_index - b.page_index);
  requireFact(pages.length > 0 && pages.length === attempt.page_count && pages.reduce((n, p) => n + p.entry_count, 0) === attempt.entry_count &&
    pages.reduce((n, p) => n + Buffer.byteLength(p.payload), 0) === attempt.stored_bytes, "selected page totals mismatch");
  const decoded = pages.map((row, i) => {
    const page = decodeAlignmentPage(row.payload);
    requireFact(row.page_index === i && page.pageIndex === BigInt(i) && page.entries.length === row.entry_count &&
      page.source.sourceSessionId.toString() === binding.source_session_id && page.source.recordingHandle === binding.recording_handle &&
      page.source.sha256 === binding.sha256, "selected page binding mismatch");
    return page;
  });
  const warnings = JSON.parse(attempt.warnings_json);
  requireFact(Array.isArray(warnings) && new Set(warnings).size === warnings.length &&
    JSON.stringify([...new Set(decoded.flatMap(pageWarnings))].sort()) === JSON.stringify([...warnings].sort()), "selected warnings mismatch");
  requireFact(attempt.coverage_status !== "available" || warnings.every(warning => warning === "local_wall_timestamp_estimate"),
    "available coverage contradicts selected warnings");
  const entries = decoded.flatMap(page => page.entries), frames = entries.filter(row => row.kind === "frame");
  requireFact(frames.length > 0 && frames.every(frame => frame.sampleRateHz === 24000) &&
    Number.isSafeInteger(recording.duration_ms) && recording.duration_ms >= 0, "invalid fixed-rate recording duration");
  // Runtime's timed recorder persists floor(total samples * 1000 / rate) plus
  // closed gaps; wall timestamps and an open trailing gap do not extend it.
  const last = frames.at(-1), duration = last.mediaEndSample * 1000n / 24000n + last.gapOffsetMs;
  requireFact(BigInt(recording.duration_ms) === duration, "recording duration contradicts decoded media timeline");
  return { recording, binding, attempt, entries };
}

export function durableOracles(snapshot, { tested, runtimeEvents, interval, requirePostFlush = true }) {
  const checks = [];
  const check = (name, work) => {
    try { checks.push({ name, status: "pass", detail: work() }); }
    catch (error) { checks.push({ name, status: "fail", detail: String(error?.message ?? error) }); }
  };
  check("durable_live_evidence", () => {
    requireFact(tested.length > 0 && new Set(tested.map(row => row.segment)).size === tested.length, "missing or duplicate tested segments");
    for (const expected of tested) {
      const row = one(snapshot.live.filter(row => row.segment_id === expected.segment), "missing or ambiguous live segment");
      const evidence = decodeLiveEvidence(row.evidence, row.text), result = decodeProvisionalResult(row.result);
      requireFact(row.occurrence_id === snapshot.occurrence && row.text === expected.text && evidence.segmentId === expected.segment &&
        evidence.sessionId.toString() === row.runtime_session_id && row.bridge_session_id && row.owner_state === "closed" &&
        row.capture_complete === 1 && row.incomplete_reason === null && row.ui_loss_reason === null && row.wording_loss_reason === null,
      "live evidence binding, wording or owner retention mismatch");
      requireFact(result.kind === "anonymous", "synthetic no-highlight attribution must stay anonymous");
      const binding = one(snapshot.bindings.filter(binding => binding.generation_id === row.generation_id), "missing live recording recovery binding");
      requireFact(binding.bridge_session_id === row.bridge_session_id && binding.source_session_id === row.runtime_session_id,
        "live and recorded generation bindings differ");
      requireFact(snapshot.live.filter(other => other.generation_id === row.generation_id).length === row.live_rows, "live row retention count mismatch");
    }
    requireFact(snapshot.live.length === tested.length, "untested persisted live segment");
    return `${tested.length} immutable occurrence/runtime/bridge-bound live rows; anonymous attribution retained`;
  });
  check("durable_turn_terminals", () => {
    for (const expected of tested) {
      const transcript = one(runtimeEvents.filter(row => row.type === "voice_transcript_final" && row.segment_id === expected.segment), "missing or duplicate actual transcript");
      const live = one(snapshot.live.filter(row => row.segment_id === expected.segment), "missing live binding");
      requireFact(transcript.session_id === live.runtime_session_id, "Runtime trace session binding mismatch");
      const authorizations = runtimeEvents.filter(row => row.type === "response_authorized" && row.segment_id === expected.segment);
      const skips = runtimeEvents.filter(row => row.type === "response_skipped" && row.segment_id === expected.segment);
      requireFact([...authorizations, ...skips].every(row => row.session_id === live.runtime_session_id), "Runtime decision session binding mismatch");
      if (!expected.authorized) { requireFact(authorizations.length === 0 && skips.length === 1, "negative segment admitted or skip missing"); continue; }
      requireFact(authorizations.length === 1 && skips.length === 0 && authorizations[0].turn_id === expected.turn, "segment authorization mismatch");
      const terminals = runtimeEvents.filter(row => ["turn_completed", "turn_cancelled", "turn_failed"].includes(row.event?.type) && row.event.turn_id === expected.turn);
      requireFact(terminals.length === 1 && terminals[0].session_id === live.runtime_session_id && terminals[0].generation_id === expected.turn &&
        (expected.terminal === undefined || terminals[0].event.type === expected.terminal), "turn terminal not exclusive, bound or correct winner");
    }
    return "actual reopened Runtime trace retains one decision and exclusive terminal per tested named segment";
  });
  check("selected_recording_alignment", () => {
    const { attempt, recording } = selectedAlignment(snapshot);
    return `selected COMPLETE attempt ${attempt.attempt_id}; ${attempt.page_count} pages/${attempt.entry_count} entries; coverage ${attempt.coverage_status}; drain ${recording.capture_drain ?? "unavailable"}`;
  });
  if (requirePostFlush) check("recorded_capture_after_flush", () => {
    const { binding, entries } = selectedAlignment(snapshot), first = interval?.captureAtFlush, last = interval?.captureAfterFlush;
    requireFact(first && last, "missing actual post-flush producer boundaries");
    const begin = BigInt(first.sequence), end = BigInt(last.sequence), startSample = BigInt(first.outputEndSample), endSample = BigInt(last.outputEndSample);
    requireFact(first.captureEpoch === last.captureEpoch && end >= begin + 10n && endSample - startSample === (end - begin) * 480n,
      "post-flush producer interval mismatch");
    const frames = entries.filter(row => row.kind === "frame" && row.epoch?.captureEpoch.toString() === first.captureEpoch &&
      row.provenance?.sequence > begin && row.provenance.sequence <= end);
    requireFact(BigInt(frames.length) === end - begin, "missing or duplicate recorded frame");
    let previous = null;
    for (let i = 0; i < frames.length; i += 1) {
      const frame = frames[i], p = frame.provenance;
      requireFact(frame.captureStatus === "available" && frame.epoch.bridgeSessionId === binding.bridge_session_id &&
        frame.sampleRateHz === 24000 && p.sampleCount === 480 && p.sequence === begin + BigInt(i + 1) &&
        p.outputStartSample === startSample + BigInt(i) * 480n && frame.mediaEndSample - frame.mediaStartSample === 480n &&
        (previous === null || previous === frame.mediaStartSample), "recorded capture sequence/sample discontinuity");
      previous = frame.mediaEndSample;
    }
    const firstMediaMs = frames[0].mediaStartSample * 1000n / 24000n + frames[0].gapOffsetMs;
    const lastMediaMs = frames.at(-1).mediaEndSample * 1000n / 24000n + frames.at(-1).gapOffsetMs;
    const intersects = (start, end) => BigInt(start) < lastMediaMs && (end === null || BigInt(end) > firstMediaMs);
    requireFact(!entries.some(row => row.kind === "audio_gap" && intersects(row.startedAtMs, row.endedAtMs)) &&
      !snapshot.runtimeGaps.some(row => intersects(row.started_at_ms, row.ended_at_ms)) &&
      !frames.some(row => row.reasons.includes("audio_missing")), "actual audio loss intersects recorded interval");
    requireFact(!snapshot.gaps.some(row => row.direction === "capture"), "bridge capture gap requires independent interval mapping");
    return `${frames.length} authenticated recorded frames cover epoch ${first.captureEpoch}, sequence ${begin + 1n}..${end}, samples ${startSample}..${endSample}; persisted drain ${snapshot.recordings[0]?.capture_drain ?? "unavailable"}`;
  });
  return checks;
}


function confirmedBoundary(recording, binding, child) {
  const peer = child?.captureFinish, drain = child?.captureDrain, boundary = drain?.boundary;
  const keys = ["captureEpoch", "lastFrameSequence", "outputEndSample", "finalClockPairSequence"];
  const decimal = value => typeof value === "string" && /^[1-9][0-9]*$/.test(value) && BigInt(value) <= 18446744073709551615n;
  const exact = value => value && Object.keys(value).length === 4 && keys.every(key => value[key] === boundary[key]);
  requireFact(drain?.drain === "confirmed" && drain.reason === null && boundary && keys.every(key => decimal(boundary[key])) &&
    Object.keys(boundary).length === 4 && peer?.authenticated === true && peer.sessionId === binding.source_session_id &&
    peer.bridgeSessionId === binding.bridge_session_id && exact(peer.requestedBoundary) && exact(peer.acknowledgedBoundary),
  "missing or mismatched authenticated peer finish");
  const columns = ["capture_drain_epoch", "capture_drain_last_frame_sequence", "capture_drain_output_end_sample", "capture_drain_final_pair_sequence"];
  requireFact(recording.capture_drain === "confirmed" && recording.capture_drain_reason === null &&
    columns.every((column, i) => recording[column] === boundary[keys[i]]), "persisted exact capture drain unavailable or mismatched");
  requireFact(child.capturePosition?.captureEpoch === boundary.captureEpoch && child.capturePosition.sequence === boundary.lastFrameSequence &&
    child.capturePosition.outputEndSample === boundary.outputEndSample && Number.isSafeInteger(child.framesSent) &&
    BigInt(child.framesSent) === BigInt(boundary.lastFrameSequence), "peer final producer position mismatch");
  return boundary;
}

/** Positive scripted baseline: peer reports alone cannot prove durable PCM. */
export function captureTailOracles(snapshot, child) {
  try {
    const { recording, binding, entries, attempt } = selectedAlignment(snapshot);
    const boundary = confirmedBoundary(recording, binding, child);
    const count = BigInt(boundary.lastFrameSequence), end = BigInt(boundary.outputEndSample), frames = entries.filter(row => row.kind === "frame");
    requireFact(BigInt(frames.length) === count && end === count * 480n, "missing or duplicate final recorded frame");
    let mediaEnd = 0n;
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i], p = frame.provenance, start = BigInt(i) * 480n;
      requireFact(frame.captureStatus === "available" && frame.epoch?.bridgeSessionId === binding.bridge_session_id &&
        frame.epoch.captureEpoch.toString() === boundary.captureEpoch && p?.captureEpoch.toString() === boundary.captureEpoch &&
        p.sequence === BigInt(i + 1) && p.outputStartSample === start && p.sampleCount === 480 && frame.sampleRateHz === 24000 &&
        frame.mediaStartSample === mediaEnd && frame.mediaEndSample === mediaEnd + 480n && !frame.reasons.includes("audio_missing"),
      "recorded final epoch/sequence/sample discontinuity");
      mediaEnd = frame.mediaEndSample;
    }
    const durationMs = mediaEnd * 1000n / 24000n;
    const intersects = (start, end) => BigInt(start) < durationMs && (end === null || BigInt(end) > 0n);
    requireFact(mediaEnd === end && !entries.some(row => row.kind === "audio_gap" && intersects(row.startedAtMs, row.endedAtMs)) &&
      !snapshot.runtimeGaps.some(row => intersects(row.started_at_ms, row.ended_at_ms)) &&
      !snapshot.gaps.some(row => row.direction === "capture"), "unaccounted recorded capture tail or audio loss");
    return [{ name: "confirmed_capture_tail", status: "pass", detail:
      `${frames.length} authenticated recorded frames retain all ${end} samples through exact acknowledged/persisted epoch ${boundary.captureEpoch}, frame ${count}, final pair ${boundary.finalClockPairSequence}; wall coverage is independently ${attempt.coverage_status}` }];
  } catch (error) { return [{ name: "confirmed_capture_tail", status: "fail", detail: String(error?.message ?? error) }]; }
}

/** Private fixed recording-conformance cut, not a Runtime threshold validator. */
function validatedMediaTiming(snapshot, child, mode) {
  requireFact(mode === "invalid2ns", "invalid media timing oracle mode");
  const selected = selectedAlignment(snapshot), { recording, binding, attempt, entries } = selected;
  requireFact(snapshot.bindings.length === 1 && snapshot.selected.length === 1 && attempt.coverage_status === "partial",
    "media timing requires one selected partial final source");
  const boundary = confirmedBoundary(recording, binding, child);
  requireFact(child.mediaTiming === "invalid2ns" && child.mediaTimingTargetSequence === "26" && child.framesSent === 51 &&
    boundary.captureEpoch === "1" && boundary.lastFrameSequence === "51" && boundary.outputEndSample === "24480" &&
    boundary.finalClockPairSequence === "3", "media timing producer selection or boundary mismatch");
  const frames = entries.filter(row => row.kind === "frame"), reasons = ["capture_alignment_missing", "inconsistent_coordinates", "wall_alignment_missing"];
  const sameEpoch = epoch => epoch?.bridgeSessionId === binding.bridge_session_id &&
    epoch.captureEpoch.toString() === boundary.captureEpoch && epoch.clockDomainId === "e2e-clock";
  const wallReasons = ["wall_alignment_missing", "wall_clock_discontinuity", "clock_pair_gap", "clock_bracket_exceeded",
    "missing_clock_pair", "clock_domain_mismatch", "arithmetic_overflow", "local_wall_timestamp_estimate"];
  requireFact(entries.every(entry => entry.kind !== "epoch" || sameEpoch(entry.epoch)), "media timing epoch identity mismatch");
  requireFact(!entries.some(entry => entry.kind === "discontinuity" || entry.kind === "alignment_limit"),
    "unexpected media timing capture discontinuity or alignment limit");
  requireFact(frames.length === 51 && recording.duration_ms === 1020, "media timing exact frame count or duration mismatch");
  const firstSpan = frames[0]?.provenance?.span;
  requireFact(firstSpan, "missing nominal frame span");
  const base = firstSpan.hostStartNs;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i], p = frame.provenance, span = p?.span, start = BigInt(i) * 480n, target = i === 25;
    requireFact(sameEpoch(frame.epoch) &&
      p?.captureEpoch.toString() === boundary.captureEpoch && p.sequence === BigInt(i + 1) && p.outputStartSample === start &&
      p.sampleCount === 480 && p.sourceStartNumerator === start * 24000n && p.sourceEndNumerator === (start + 480n) * 24000n &&
      p.sourceDenominator === 24000 && p.sourceRateHz === 24000 && p.quality === "nominal_frame_endpoint_interpolation" &&
      frame.sampleRateHz === 24000 && frame.mediaStartSample === start && frame.mediaEndSample === start + 480n && frame.gapOffsetMs === 0n &&
      span?.hostStartNs === base + BigInt(i) * 20000000n - (target ? 2n : 0n) &&
      span.hostEndNs === base + BigInt(i + 1) * 20000000n && span.roundingEnvelopeNs === 1000n && span.captureUncertaintyNs === null,
    "media timing epoch/sequence/sample/nominal span mismatch");
    requireFact(!frame.reasons.includes("audio_missing") && (target
      ? frame.captureStatus === "capture_alignment_missing" && frame.wall === null && reasons.every(reason => frame.reasons.includes(reason)) &&
        frame.reasons.every(reason => reasons.includes(reason))
      : frame.captureStatus === "available" && frame.reasons.every(reason => wallReasons.includes(reason))),
    "media timing target status or reasons mismatch");
  }
  const overlap = frames[24].provenance.span.hostEndNs - frames[25].provenance.span.hostStartNs;
  const warnings = JSON.parse(attempt.warnings_json);
  requireFact(overlap === 2n && reasons.every(reason => warnings.includes(reason)), "media timing overlap or selected warnings mismatch");
  const intersects = (start, end) => BigInt(start) < 1020n && (end === null || BigInt(end) > 0n);
  requireFact(!entries.some(row => row.kind === "audio_gap" && intersects(row.startedAtMs, row.endedAtMs)) &&
    !snapshot.runtimeGaps.some(row => intersects(row.started_at_ms, row.ended_at_ms)) &&
    !snapshot.gaps.some(row => row.direction === "capture"), "audio loss intersects media timing cut");
  return { ...selected, boundary, frames, overlap, warnings };
}

/** One-pair short recording: retained PCM cannot manufacture drain or wall confirmation. */
function validatedTailOmission(snapshot, child) {
  const selected = selectedAlignment(snapshot), { recording, binding, attempt, entries } = selected;
  requireFact(snapshot.bindings.length === 1 && snapshot.selected.length === 1 && attempt.coverage_status === "partial",
    "tail omission requires one selected partial final source");
  const peer = child?.captureFinish, drain = child?.captureDrain;
  const position = value => value?.captureEpoch === "1" && value.sequence === "49" && value.outputEndSample === "23520";
  requireFact(child?.mediaTiming === "omit-final-pair" && child.mediaTimingTargetSequence === null && child.framesSent === 49 &&
    position(child.capturePosition) && position(peer?.capturePosition), "tail omission producer selection or position mismatch");
  requireFact(peer?.authenticated === true && peer.sessionId === binding.source_session_id && peer.bridgeSessionId === binding.bridge_session_id &&
    peer.requestedBoundary === null && peer.acknowledgedBoundary === null &&
    drain?.drain === "unconfirmed" && drain.reason === "final_clock_pair_omitted" && drain.boundary === null &&
    child.mediaClosedReason === "final_clock_pair_omitted", "tail omission authenticated unconfirmed finish mismatch");
  requireFact(recording.capture_drain === "unconfirmed" && recording.capture_drain_reason === "final_clock_pair_omitted" &&
    ["capture_drain_epoch", "capture_drain_last_frame_sequence", "capture_drain_output_end_sample", "capture_drain_final_pair_sequence"]
      .every(key => recording[key] === null), "tail omission persisted unconfirmed boundary mismatch");
  const sameEpoch = epoch => epoch?.bridgeSessionId === binding.bridge_session_id && epoch.clockDomainId === "e2e-clock" && epoch.captureEpoch === 1n;
  requireFact(entries[0]?.kind === "epoch" && sameEpoch(entries[0].epoch) && entries.filter(row => row.kind === "epoch").length === 1,
    "tail omission initial epoch mismatch");
  const pair = entries[1]?.pair;
  requireFact(entries[1]?.kind === "clock_pair" && entries.filter(row => row.kind === "clock_pair").length === 1 &&
    pair.clockDomainId === "e2e-clock" && pair.wallEpoch === 1n && pair.sequence === 1n &&
    pair.hostBeforeNs <= pair.hostAfterNs && pair.wallResolutionNs === 1000n && pair.externalUtcAccuracyNs === null,
    "tail omission requires exactly one initial clock pair");
  const frames = entries.filter(row => row.kind === "frame");
  requireFact(frames.length === 49 && recording.duration_ms === 980 && frames.at(-1)?.mediaEndSample === 23520n,
    "tail omission exact final frame/sample count or duration mismatch");
  requireFact(entries.slice(2, 51).every(row => row.kind === "frame") && frames.every(frame => sameEpoch(frame.epoch) && frame.provenance?.captureEpoch === 1n),
    "tail omission frame order or epoch identity mismatch");
  const base = frames[0]?.provenance?.span?.hostStartNs;
  requireFact(typeof base === "bigint", "tail omission missing nominal span");
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i], p = frame.provenance, span = p?.span, start = BigInt(i) * 480n;
    requireFact(p.sequence === BigInt(i + 1) && p.outputStartSample === start && p.sampleCount === 480 &&
      p.sourceStartNumerator === start * 24000n && p.sourceEndNumerator === (start + 480n) * 24000n &&
      p.sourceDenominator === 24000 && p.sourceRateHz === 24000 && p.quality === "nominal_frame_endpoint_interpolation" &&
      frame.sampleRateHz === 24000 && frame.mediaStartSample === start && frame.mediaEndSample === start + 480n && frame.gapOffsetMs === 0n &&
      span?.hostStartNs === base + BigInt(i) * 20000000n && span.hostEndNs === base + BigInt(i + 1) * 20000000n &&
      span.roundingEnvelopeNs === 1000n && span.captureUncertaintyNs === null,
    "tail omission sequence/sample/nominal span mismatch");
    requireFact(frame.captureStatus === "available" && frame.wall === null &&
      JSON.stringify([...frame.reasons].sort()) === '["missing_clock_pair","wall_alignment_missing"]',
    "tail omission frame wall/status/reasons mismatch");
  }
  // Runtime cleanup may append reconnect, then an open gap at the PCM watermark.
  const suffix = entries.slice(51);
  let index = 0;
  if (suffix[index]?.kind === "discontinuity") {
    requireFact(suffix[index].captureEpoch === 1n && suffix[index].reason === "reconnect", "tail omission terminal reconnect mismatch");
    index++;
  }
  let trailingGap = null;
  if (suffix[index]?.kind === "audio_gap") {
    trailingGap = suffix[index++];
    requireFact(trailingGap.startedAtMs === 980n && trailingGap.endedAtMs === null && trailingGap.reason === "capture_discontinuity",
      "tail omission terminal gap mismatch");
  }
  requireFact(index === suffix.length, "tail omission unexpected terminal suffix");
  requireFact(snapshot.runtimeGaps.length === (trailingGap ? 1 : 0) && snapshot.runtimeGaps.every(row =>
    String(row.started_at_ms) === "980" && row.ended_at_ms === null && row.reason === "capture_discontinuity") &&
    !snapshot.gaps.some(row => row.direction === "capture"), "tail omission recorded gap disagreement or capture loss");
  return { ...selected, peer, drain, frames, pair, suffix, warnings: JSON.parse(attempt.warnings_json) };
}

export function tailOmissionOracles(snapshot, child) {
  try {
    validatedTailOmission(snapshot, child);
    return [{ name: "media_timing_omit_final_pair", status: "pass", detail: "selected COMPLETE partial recording retains all 49 frames/23520 samples/980ms; one initial pair, all frame walls missing; authenticated unconfirmed drain without requested or acknowledged finish" }];
  } catch (error) { return [{ name: "media_timing_omit_final_pair", status: "fail", detail: String(error?.message ?? error) }]; }
}
export function tailOmissionMetadata(snapshot, child) {
  const { recording, binding, attempt, entries, peer, drain, frames, pair, suffix, warnings } = validatedTailOmission(snapshot, child);
  const last = frames.at(-1);
  return { mode: child.mediaTiming, occurrence: snapshot.occurrence, generationId: binding.generation_id,
    bridgeSessionId: binding.bridge_session_id, sourceSessionId: binding.source_session_id,
    recordingHandle: recording.handle, sha256: recording.sha256, keyId: recording.key_id,
    attemptId: attempt.attempt_id, pageCount: attempt.page_count, entryCount: attempt.entry_count, storedBytes: attempt.stored_bytes,
    coverageStatus: attempt.coverage_status, captureDrain: { drain: drain.drain, reason: drain.reason, boundary: drain.boundary },
    frames: frames.length, samples: String(last.mediaEndSample), durationMs: recording.duration_ms, initialPairSequence: String(pair.sequence),
    finalPairRecorded: entries.some(row => row.kind === "clock_pair" && row.pair.sequence > pair.sequence), finishRequested: peer.requestedBoundary !== null, finishAcknowledged: peer.acknowledgedBoundary !== null,
    lastFrame: { sequence: String(last.provenance.sequence), sourceStartSample: String(last.mediaStartSample), sourceEndSample: String(last.mediaEndSample),
      captureStatus: last.captureStatus, wall: last.wall, reasons: [...last.reasons].sort() },
    terminalSuffix: suffix.map(row => row.kind === "discontinuity" ? { kind: row.kind, captureEpoch: String(row.captureEpoch), reason: row.reason }
      : { kind: row.kind, startedAtMs: String(row.startedAtMs), endedAtMs: row.endedAtMs, reason: row.reason }), warnings: [...warnings].sort() };
}

/** Selected long cut only; the decoded walls determine K, never the cadence. */
function validatedLongTailOmission(snapshot, child) {
  const selected = selectedAlignment(snapshot), { recording, binding, attempt, entries } = selected;
  requireFact(snapshot.recordings.length === 1 && snapshot.bindings.length === 1 && snapshot.selected.length === 1 &&
    snapshot.attempts.length === 1 && attempt.coverage_status === "partial", "long tail source selection mismatch");
  const peer = child?.captureFinish, drain = child?.captureDrain;
  const position = value => value?.captureEpoch === "1" && value.sequence === "99" && value.outputEndSample === "47520";
  requireFact(child?.mediaTiming === "omit-final-pair-long" && child.mediaTimingTargetSequence === null && child.framesSent === 99 &&
    position(child.capturePosition) && position(peer?.capturePosition), "long tail producer position mismatch");
  requireFact(peer?.authenticated === true && peer.sessionId === binding.source_session_id && peer.bridgeSessionId === binding.bridge_session_id &&
    peer.requestedBoundary === null && peer.acknowledgedBoundary === null && drain?.drain === "unconfirmed" &&
    drain.reason === "final_clock_pair_omitted" && drain.boundary === null && child.mediaClosedReason === "final_clock_pair_omitted",
  "long tail authenticated finish mismatch");
  requireFact(recording.capture_drain === "unconfirmed" && recording.capture_drain_reason === "final_clock_pair_omitted" &&
    ["capture_drain_epoch", "capture_drain_last_frame_sequence", "capture_drain_output_end_sample", "capture_drain_final_pair_sequence"]
      .every(key => recording[key] === null), "long tail persisted boundary mismatch");
  const sameEpoch = epoch => epoch?.bridgeSessionId === binding.bridge_session_id && epoch.clockDomainId === "e2e-clock" && epoch.captureEpoch === 1n;
  requireFact(entries[0]?.kind === "epoch" && sameEpoch(entries[0].epoch) && entries.filter(e => e.kind === "epoch").length === 1,
    "long tail epoch mismatch");
  requireFact(entries[1]?.kind === "clock_pair" && entries[52]?.kind === "clock_pair" &&
    entries.filter(e => e.kind === "clock_pair").length === 2 && entries.slice(2, 52).every(e => e.kind === "frame") &&
    entries.slice(53, 102).length === 49 && entries.slice(53, 102).every(e => e.kind === "frame"), "long tail order mismatch");
  const pairs = [entries[1].pair, entries[52].pair];
  requireFact(pairs.every((p, i) => p.clockDomainId === "e2e-clock" && p.wallEpoch === 1n && p.sequence === BigInt(i + 1) &&
    p.hostBeforeNs <= p.hostAfterNs && p.hostAfterNs - p.hostBeforeNs <= 5_000_000n && p.localUnixNs >= 0n &&
    p.wallResolutionNs === 1000n && p.externalUtcAccuracyNs === null), "long tail pair policy mismatch");
  const firstMid = pairs[0].hostBeforeNs + pairs[0].hostAfterNs, lastMid = pairs[1].hostBeforeNs + pairs[1].hostAfterNs;
  const gap = lastMid - firstMid, residual = 2n * (pairs[1].localUnixNs - pairs[0].localUnixNs) - gap;
  requireFact(gap > 0n && gap <= 4_000_000_000n && residual >= -20_000_000n && residual <= 20_000_000n,
    "long tail pair interval mismatch");
  const frames = entries.filter(e => e.kind === "frame"), base = frames[0]?.provenance?.span?.hostStartNs;
  requireFact(frames.length === 99 && recording.duration_ms === 1980 && frames.at(-1)?.mediaEndSample === 47520n,
    "long tail count mismatch");
  requireFact(typeof base === "bigint" && firstMid <= 2n * base && lastMid >= 2n * (base + 20_000_000n) &&
    lastMid < 2n * frames.at(-1).provenance?.span?.hostStartNs, "long tail shape unavailable");
  const mappedFrames = frames.findIndex(f => f.wall === null);
  requireFact(mappedFrames >= 1 && mappedFrames <= 98, "long tail partition mismatch");
  const wallRun = frames[0].wall?.wallRun, maximumBracket = pairs.reduce((n, p) => p.hostAfterNs - p.hostBeforeNs > n ? p.hostAfterNs - p.hostBeforeNs : n, 0n);
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i], p = frame.provenance, span = p?.span, start = BigInt(i) * 480n;
    requireFact(sameEpoch(frame.epoch) && p?.captureEpoch === 1n && p.sequence === BigInt(i + 1) && p.outputStartSample === start &&
      p.sampleCount === 480 && p.sourceStartNumerator === start * 24000n && p.sourceEndNumerator === (start + 480n) * 24000n &&
      p.sourceDenominator === 24000 && p.sourceRateHz === 24000 && p.quality === "nominal_frame_endpoint_interpolation" &&
      frame.captureStatus === "available" && frame.sampleRateHz === 24000 && frame.mediaStartSample === start && frame.mediaEndSample === start + 480n &&
      frame.gapOffsetMs === 0n && span?.hostStartNs === base + BigInt(i) * 20_000_000n &&
      span.hostEndNs === base + BigInt(i + 1) * 20_000_000n && span.roundingEnvelopeNs === 1000n && span.captureUncertaintyNs === null,
    "long tail frame mismatch");
    const mapped = i < mappedFrames, bracketed = firstMid <= 2n * span.hostStartNs && 2n * span.hostEndNs <= lastMid;
    requireFact(mapped === bracketed && (mapped ? frame.wall !== null && frame.reasons.length === 0 : frame.wall === null &&
      JSON.stringify([...frame.reasons].sort()) === '["missing_clock_pair","wall_alignment_missing"]'), "long tail partition mismatch");
    if (mapped) {
      const w = frame.wall;
      requireFact(w.wallEpoch === 1n && w.wallRun === wallRun && w.maximumBracketNs === maximumBracket && w.maximumResolutionNs === 1000n &&
        w.modelAllowanceNs === 10_000_000n && w.interpolationRoundingNs === 2n && w.captureRoundingNs === 1000n &&
        w.captureUncertaintyNs === null && w.externalUtcAccuracyNs === null && w.overallPhysicalAccuracyNs === null,
      "long tail wall policy mismatch");
    }
  }
  const suffix = entries.slice(102); let index = 0, trailingGap = null;
  if (suffix[index]?.kind === "discontinuity") {
    requireFact(suffix[index].captureEpoch === 1n && suffix[index].reason === "reconnect", "long tail suffix reconnect mismatch"); index++;
  }
  if (suffix[index]?.kind === "audio_gap") {
    trailingGap = suffix[index++];
    requireFact(trailingGap.startedAtMs === 1980n && trailingGap.endedAtMs === null && trailingGap.reason === "capture_discontinuity",
      "long tail suffix gap mismatch");
  }
  requireFact(index === suffix.length, "long tail suffix order mismatch");
  requireFact(snapshot.runtimeGaps.length === (trailingGap ? 1 : 0) && snapshot.runtimeGaps.every(g => String(g.started_at_ms) === "1980" &&
    g.ended_at_ms === null && g.reason === "capture_discontinuity") && !snapshot.gaps.some(g => g.direction === "capture"), "long tail suffix recorded gap mismatch");
  const warnings = JSON.parse(attempt.warnings_json), expected = ["local_wall_timestamp_estimate", "missing_clock_pair", "wall_alignment_missing"];
  if (suffix.some(e => e.kind === "discontinuity")) expected.push("reconnect");
  if (trailingGap) expected.push("audio_missing");
  requireFact(JSON.stringify([...warnings].sort()) === JSON.stringify(expected.sort()), "long tail warnings mismatch");
  return { ...selected, mappedFrames, suffix, warnings };
}
export function longTailOmissionOracles(snapshot, child) {
  try {
    validatedLongTailOmission(snapshot, child);
    return [{ name: "media_timing_omit_final_pair_long", status: "pass", detail: "selected COMPLETE partial long recording retains mapped prefix and missing-wall tail; drain unconfirmed without finish" }];
  } catch (error) {
    const reasons = ["source selection", "producer position", "authenticated finish", "persisted boundary", "epoch", "order", "pair policy", "pair interval",
      "count", "shape unavailable", "partition", "frame", "wall policy", "suffix reconnect", "suffix gap", "suffix order", "suffix recorded gap", "warnings"];
    const message = reasons.flatMap(r => [`long tail ${r} mismatch`, `long tail ${r}`]).find(r => r === error?.message) ?? "long tail evidence unavailable";
    return [{ name: "media_timing_omit_final_pair_long", status: "fail", detail: message }];
  }
}
export function longTailOmissionMetadata(snapshot, child) {
  const { recording, binding, attempt, mappedFrames, suffix, warnings } = validatedLongTailOmission(snapshot, child);
  const result = { mode: "omit-final-pair-long", disposition: "observed-mapped-prefix-tail", occurrence: snapshot.occurrence,
    generationId: binding.generation_id, bridgeSessionId: binding.bridge_session_id, sourceSessionId: binding.source_session_id,
    recordingHandle: recording.handle, sha256: recording.sha256, keyId: recording.key_id, attemptId: attempt.attempt_id,
    pageCount: attempt.page_count, entryCount: attempt.entry_count, storedBytes: attempt.stored_bytes, coverageStatus: "partial",
    frames: 99, samples: "47520", durationMs: 1980, mappedFrames, mappedSamples: { start: "0", end: String(mappedFrames * 480) },
    missingSamples: { start: String(mappedFrames * 480), end: "47520" }, pairSequences: ["1", "2"],
    captureDrain: { drain: "unconfirmed", reason: "final_clock_pair_omitted", boundary: null }, finalPairRecorded: false,
    finishRequested: false, finishAcknowledged: false, wallEstimate: "qualified-local-estimate",
    terminalSuffix: suffix.map(e => e.kind === "discontinuity" ? { kind: "discontinuity", captureEpoch: "1", reason: "reconnect" }
      : { kind: "audio_gap", startedAtMs: "1980", endedAtMs: null, reason: "capture_discontinuity" }), warnings: [...warnings].sort() };
  return validateLongTailMetadata(result);
}

// Inspect descriptors before reading values or invoking any serialization method.
function longData(value, budget = { left: 800 }) {
  requireFact(--budget.left >= 0, "long_tail_output_refused");
  if (value === null || typeof value === "boolean" || typeof value === "string" && value.length <= 640 ||
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  requireFact(typeof value === "object" && value !== null, "long_tail_output_refused");
  const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
  requireFact(array ? proto === Array.prototype && value.length <= 128 : proto === Object.prototype || proto === null, "long_tail_output_refused");
  requireFact(!Object.getOwnPropertyDescriptor(Object.prototype, "toJSON") && !Object.getOwnPropertyDescriptor(Array.prototype, "toJSON"), "long_tail_output_refused");
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  requireFact(keys.every(k => typeof k === "string" && (array && k === "length" || descriptors[k].enumerable && Object.hasOwn(descriptors[k], "value"))) &&
    (!array || keys.length === value.length + 1 && keys.every(k => k === "length" || /^(0|[1-9][0-9]*)$/.test(k))), "long_tail_output_refused");
  const copy = array ? [] : {};
  for (const key of keys) if (key !== "length" || !array)
    Object.defineProperty(copy, key, { value: longData(descriptors[key].value, budget), enumerable: true, configurable: true, writable: true });
  return copy;
}
export function validateLongTailMetadata(value) {
  const m = longData(value), shape = (v, keys) => v && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
  const instant = typeof m?.occurrence === "string" ? m.occurrence.split("@")[1] : null, ms = typeof instant === "string" ? Date.parse(instant) : NaN;
  const scalar = ["mode", "disposition", "occurrence", "generationId", "bridgeSessionId", "sourceSessionId", "recordingHandle", "sha256", "keyId", "attemptId",
    "pageCount", "entryCount", "storedBytes", "coverageStatus", "frames", "samples", "durationMs", "mappedFrames", "finalPairRecorded", "finishRequested", "finishAcknowledged", "wallEstimate"];
  requireFact(shape(m, [...scalar, "mappedSamples", "missingSamples", "pairSequences", "captureDrain", "terminalSuffix", "warnings"]) &&
    m.mode === "omit-final-pair-long" && m.disposition === "observed-mapped-prefix-tail" && m.coverageStatus === "partial" &&
    typeof m.occurrence === "string" && /^[1-9][0-9]{0,19}@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(m.occurrence) &&
    Number.isSafeInteger(ms) && ms >= 0 && new Date(ms).toISOString().replace(".000Z", "Z") === instant &&
    typeof m.bridgeSessionId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(m.bridgeSessionId) &&
    m.generationId === Buffer.from(m.occurrence).toString("hex") + ":" + Buffer.from(m.bridgeSessionId).toString("hex") &&
    typeof m.sourceSessionId === "string" && /^[1-9][0-9]{0,19}$/.test(m.sourceSessionId) && BigInt(m.sourceSessionId) <= 18446744073709551615n &&
    typeof m.recordingHandle === "string" && /^[a-f0-9]{32}$/.test(m.recordingHandle) && typeof m.sha256 === "string" && /^[a-f0-9]{64}$/.test(m.sha256) &&
    typeof m.keyId === "string" && /^[a-f0-9]{16}$/.test(m.keyId) && typeof m.attemptId === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(m.attemptId) &&
    [m.pageCount, m.entryCount, m.storedBytes, m.mappedFrames].every(Number.isSafeInteger) &&
    m.pageCount >= 2 && m.pageCount <= 104 && m.entryCount >= 102 && m.entryCount <= 104 && m.pageCount <= m.entryCount &&
    m.storedBytes > 0 && m.storedBytes <= 104 * 131072 && m.frames === 99 && m.samples === "47520" && m.durationMs === 1980 &&
    m.mappedFrames >= 1 && m.mappedFrames <= 98 && shape(m.mappedSamples, ["start", "end"]) && shape(m.missingSamples, ["start", "end"]) &&
    m.mappedSamples.start === "0" && m.mappedSamples.end === String(m.mappedFrames * 480) &&
    m.missingSamples.start === m.mappedSamples.end && m.missingSamples.end === "47520" &&
    Array.isArray(m.pairSequences) && m.pairSequences.length === 2 && m.pairSequences[0] === "1" && m.pairSequences[1] === "2" &&
    shape(m.captureDrain, ["drain", "reason", "boundary"]) && m.captureDrain.drain === "unconfirmed" &&
    m.captureDrain.reason === "final_clock_pair_omitted" && m.captureDrain.boundary === null && m.finalPairRecorded === false &&
    m.finishRequested === false && m.finishAcknowledged === false && m.wallEstimate === "qualified-local-estimate" &&
    Array.isArray(m.terminalSuffix) && m.terminalSuffix.length <= 2 && Array.isArray(m.warnings), "long_tail_output_refused");
  let index = 0;
  if (m.terminalSuffix[index]?.kind === "discontinuity") {
    const e = m.terminalSuffix[index++]; requireFact(shape(e, ["kind", "captureEpoch", "reason"]) && e.captureEpoch === "1" && e.reason === "reconnect", "long_tail_output_refused");
  }
  if (m.terminalSuffix[index]?.kind === "audio_gap") {
    const e = m.terminalSuffix[index++]; requireFact(shape(e, ["kind", "startedAtMs", "endedAtMs", "reason"]) && e.startedAtMs === "1980" && e.endedAtMs === null && e.reason === "capture_discontinuity", "long_tail_output_refused");
  }
  const expected = ["local_wall_timestamp_estimate", "missing_clock_pair", "wall_alignment_missing"];
  if (m.terminalSuffix.some(e => e.kind === "discontinuity")) expected.push("reconnect");
  if (m.terminalSuffix.some(e => e.kind === "audio_gap")) expected.push("audio_missing");
  requireFact(index === m.terminalSuffix.length && m.entryCount === 102 + index &&
    JSON.stringify([...m.warnings].sort()) === JSON.stringify(expected.sort()), "long_tail_output_refused");
  return m;
}
export function longTailReport(input) {
  const value = longData(input);
  requireFact(value && Object.keys(value).length === 3 && Object.hasOwn(value, "metadata") && Object.hasOwn(value, "checks") &&
    Object.hasOwn(value, "cleanupConfirmed") && typeof value.cleanupConfirmed === "boolean" && Array.isArray(value.checks) &&
    value.checks.every(c => c && Object.keys(c).length === 2 && typeof c.name === "string" && /^[a-z_0-9]{1,80}$/.test(c.name) &&
      ["pass", "fail", "blocked", "skipped"].includes(c.status)) && new Set(value.checks.map(c => c.name)).size === value.checks.length, "long_tail_output_refused");
  const facts = value.metadata === null ? null : validateLongTailMetadata(value.metadata);
  const required = ["media_timing_omit_final_pair_long", "media_timing_alignment_ready", "long_tail_public_close", "shutdown_clean", "no_key_or_plaintext_audio", "no_orphan_process", "no_closed_store_callback", "single_occurrence_identity"];
  return { schema: "meeting-long-tail-report/v1", mode: "omit-final-pair-long", disposition: facts && value.cleanupConfirmed &&
    !value.checks.some(c => c.status === "fail") && required.every(name => value.checks.some(c => c.name === name && c.status === "pass"))
      ? "observed-mapped-prefix-tail" : "prerequisite-failed-or-unknown", facts, cleanupConfirmed: value.cleanupConfirmed,
    publication: "untested", checks: value.checks };
}

export function mediaTimingOracles(snapshot, child, mode) {
  try {
    validatedMediaTiming(snapshot, child, mode);
    return [{ name: "media_timing_invalid2ns", status: "pass", detail: "selected COMPLETE recording retains 51 frames/24480 samples/1020ms; frame26 alone has unavailable capture timing with exactly 2ns overlap; exact confirmed finish retained" }];
  } catch (error) { return [{ name: "media_timing_invalid2ns", status: "fail", detail: String(error?.message ?? error) }]; }
}

/** Whitelisted summary derived only after strict selected-page validation. */
export function mediaTimingMetadata(snapshot, child, mode) {
  const { recording, binding, attempt, boundary, frames, overlap, warnings } = validatedMediaTiming(snapshot, child, mode);
  return { mode, occurrence: snapshot.occurrence, generationId: binding.generation_id, bridgeSessionId: binding.bridge_session_id,
    sourceSessionId: binding.source_session_id, recordingHandle: recording.handle, sha256: recording.sha256, keyId: recording.key_id,
    attemptId: attempt.attempt_id, pageCount: attempt.page_count, entryCount: attempt.entry_count, storedBytes: attempt.stored_bytes,
    coverageStatus: attempt.coverage_status, finishBoundary: { ...boundary }, frames: frames.length, samples: "24480", durationMs: 1020,
    target: { sequence: "26", sourceStartSample: "12000", sourceEndSample: "12480", overlapNs: String(overlap),
      captureStatus: frames[25].captureStatus, wall: null, reasons: [...frames[25].reasons].sort() }, warnings: [...warnings].sort() };
}

const pick = (row, keys) => row === null || row === undefined ? null : Object.fromEntries(keys.map(key => [key, row[key]]));
/** Retained private metadata only; never raw alignment pages or authorization. */
export function durableMetadata(snapshot) {
  const rows = (name, keys) => snapshot[name].map(row => pick(row, keys));
  return { occurrence: snapshot.occurrence,
    liveRows: rows("live", ["generation_id", "segment_id", "text", "evidence", "result", "occurrence_id", "bridge_session_id",
      "runtime_session_id", "capture_complete", "incomplete_reason", "owner_state", "live_rows", "ui_loss_reason", "wording_loss_reason"]),
    recordings: rows("recordings", ["occurrence_id", "handle", "sha256", "key_id", "duration_ms", "format", "capture_drain", "capture_drain_reason",
      "capture_drain_epoch", "capture_drain_last_frame_sequence", "capture_drain_output_end_sample", "capture_drain_final_pair_sequence"]),
    gaps: rows("gaps", ["ordinal", "direction", "started_at", "ended_at"]),
    runtimeGaps: rows("runtimeGaps", ["ordinal", "started_at_ms", "ended_at_ms", "reason"]),
    bindings: rows("bindings", ["generation_id", "occurrence_id", "bridge_session_id", "source_session_id", "recording_handle", "sha256", "key_id", "recording_kind"]),
    selected: rows("selected", ["generation_id", "attempt_id"]),
    attempts: rows("attempts", ["attempt_id", "generation_id", "source_session_id", "recording_handle", "sha256", "key_id", "timing_contract",
      "state", "page_count", "entry_count", "stored_bytes", "coverage_status", "warnings_json"]),
    pageMetadata: snapshot.pages.map(row => ({ ...pick(row, ["attempt_id", "page_index", "entry_count"]), storedBytes: Buffer.byteLength(row.payload) })) };
}

/** Whitelist only the scripted peer's finish/observation metadata for bundles. */
export function captureFinishMetadata(child) {
  const boundary = value => pick(value, ["captureEpoch", "lastFrameSequence", "outputEndSample", "finalClockPairSequence"]);
  const position = value => pick(value, ["captureEpoch", "sequence", "outputEndSample"]);
  const finish = child.captureFinish, observation = child.endObservation;
  return { ...(child.mediaTiming === "invalid2ns" ? { mediaTiming: { mode: "invalid2ns",
    targetSequence: child.mediaTimingTargetSequence === "26" ? "26" : null } } : child.mediaTiming === "omit-final-pair" ? { mediaTiming: { mode: "omit-final-pair" } } : {}),
    captureDrain: child.captureDrain === null || child.captureDrain === undefined ? null : {
    drain: child.captureDrain.drain, reason: child.captureDrain.reason, boundary: boundary(child.captureDrain.boundary) },
    captureFinish: finish === null || finish === undefined ? null : { ...pick(finish, ["sessionId", "bridgeSessionId", "authenticated"]),
      requestedBoundary: boundary(finish.requestedBoundary), acknowledgedBoundary: boundary(finish.acknowledgedBoundary),
      capturePosition: position(finish.capturePosition) },
    capturePosition: position(child.capturePosition),
    endObservation: observation === null || observation === undefined ? null : { ...pick(observation, ["reason", "observedAt", "observationTimingReason"]),
      observationTiming: pick(observation.observationTiming, ["clockDomainId", "hostBeforeNs", "hostAfterNs"]) } };
}
