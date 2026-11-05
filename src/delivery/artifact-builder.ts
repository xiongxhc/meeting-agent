// Post-meeting-only construction of the frozen TeamMem artifact. This module
// creates no files and performs no delivery: Task 9 owns the outbox/bundle.

import { createHash } from "node:crypto";
import { z } from "zod";
import { CLIENT_PROTOCOL_VERSION, validateClientCommand } from "@conversation/runtime";

import {
  addMillisecondsToUtcInstant,
  canonicalArtifactHash,
  canonicalArtifactJson,
  isDotSegment,
  isUnicodeScalarString,
  mapTeamMemText,
  normalizeTeamMemText,
  parseTeamMemMeetingArtifact,
  TEAMMEM_MEETING_V1_SCHEMA,
  teamMemTextViolations,
  type TeamMemMeetingArtifact,
} from "../contracts/teammem-meeting-v1.ts";
import {
  parseTeamMemMeetingArtifactV2,
  type SupportedTeamMemMeetingArtifact,
  type TeamMemMeetingArtifactV2,
} from "../contracts/teammem-meeting-v2.ts";
import type { MeetingIdentity } from "../domain/meeting.ts";
import type { AttendanceInterval } from "../domain/participants.ts";
import { getOwnedUiExactMsSnapshot, getOwnedTimedSampleSnapshot, namedTimedCandidate } from "../domain/attribution-evidence.ts";
import type { MediaTimelineAlignment, ReconciledSegment, ReconciledTranscript, TranscriptWarning, TimedReconciledTranscript } from "../domain/transcript.ts";
import type { ConversationRuntimePort } from "../ports/conversation-runtime.ts";
import type { SelectedAlignment } from "../ports/session-store.ts";
import { resolveProjects, synthesisProjectVocabulary } from "./project-resolution.ts";

/** Added after TeamMem refused a note for quoting its own transcript. */
export const NO_VERBATIM_INSTRUCTION = " Do not copy any sentence or phrase from the transcript verbatim into any field; restate every point in your own words. A note that quotes the transcript is refused.";

/** The artifact contract's bound on processing warnings. */
const MAX_PROCESSING_WARNINGS = 500;

const text = z.string().min(1).max(20_000);
const evidence = z.array(z.string().min(1).max(200)).min(1).max(100);

/** The authority for bounds (D031). The Runtime checks structure only, so
 * every length, count and `null | object` member is enforced here, on the
 * answer, and a violation is a visible build failure. */
export const textSynthesisContract = z.object({
  summary: text,
  projects: z.array(z.object({ name: z.string().min(1).max(200), evidence_segment_ids: evidence }).strict()).max(500),
  decisions: z.array(z.object({ text, evidence_segment_ids: evidence }).strict()).max(500),
  action_items: z.array(z.object({
    text,
    owner: z.object({ person_id: z.string().min(1).max(200), display_name: z.string().min(1).max(200), explicitly_stated: z.literal(true) }).strict().nullable(),
    due_date: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), explicitly_stated: z.literal(true) }).strict().nullable(),
    evidence_segment_ids: evidence,
  }).strict()).max(500),
  discussion_points: z.array(z.object({ text, evidence_segment_ids: evidence }).strict()).max(500),
  person_summaries: z.array(z.object({ person_id: z.string().min(1).max(200), display_name: z.string().min(1).max(200), text }).strict()).max(500),
}).strict();

/** The SDK enforces `maxOutputBytes <= MAX_PROCESSED_OUTPUT_BYTES` inside
 * `validateClientCommand`, but its package index does not re-export the
 * constant, so it cannot be imported. Asking the installed SDK for the largest
 * bound it admits keeps the two in step across a repin without restating the
 * number here; a bound the SDK refuses would be a refused build, never a
 * truncated answer. */
export const MAX_PROCESSED_OUTPUT_BYTES = largestAdmittedOutputBytes();

function largestAdmittedOutputBytes(): number {
  const admits = (maxOutputBytes: number): boolean => {
    try {
      validateClientCommand({ type: "process_text", requestId: "output-bound-probe", sessionId: 1n,
        instructions: ".", input: ".", outputSchema: { type: "object" }, maxOutputBytes }, CLIENT_PROTOCOL_VERSION);
      return true;
    } catch { return false; }
  };
  let low = 1, high = 1 << 30;
  if (!admits(low)) throw new Error("the installed Runtime SDK admits no text processing output bound");
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (admits(middle)) low = middle; else high = middle;
  }
  return low;
}

/** The SDK refuses a processText input above its `MAX_PROCESSING_INPUT_BYTES`
 * rather than chunking it, and does not export that constant either, so it is
 * probed the same way: the largest ASCII input `validateClientCommand` admits
 * is its byte cap. A long transcript is split to fit under it (see
 * `synthesize`). */
export const MAX_PROCESSING_INPUT_BYTES = largestAdmittedInputBytes();

function largestAdmittedInputBytes(): number {
  const admits = (bytes: number): boolean => {
    try {
      validateClientCommand({ type: "process_text", requestId: "input-bound-probe", sessionId: 1n,
        instructions: ".", input: ".".repeat(bytes), outputSchema: { type: "object" }, maxOutputBytes: 1 }, CLIENT_PROTOCOL_VERSION);
      return true;
    } catch { return false; }
  };
  if (!admits(1)) throw new Error("the installed Runtime SDK admits no text processing input");
  // Doubling first keeps every probe string within twice the cap.
  let low = 1, high = 2;
  while (high <= 1 << 24 && admits(high)) { low = high; high *= 2; }
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (admits(middle)) low = middle; else high = middle;
  }
  return low;
}

/** The WIRE schema (D031): the Runtime enforces exactly `type` (one string),
 * `properties`, `required`, `items`, `enum` and `additionalProperties`, and
 * refuses any other keyword outright, so the bounds above are not spelled
 * here. A `null | object` member is an unconstrained `{}` that stays in
 * `required`; the contract above decides which of the two it was. */
export const TEAMMEM_TEXT_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "projects", "decisions", "action_items", "discussion_points", "person_summaries"],
  properties: {
    summary: { type: "string" },
    projects: { type: "array", items: evidenceItemSchema("name") },
    decisions: { type: "array", items: evidenceItemSchema("text") },
    action_items: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["text", "owner", "due_date", "evidence_segment_ids"],
        properties: {
          text: { type: "string" },
          owner: {},
          due_date: {},
          evidence_segment_ids: evidenceSchema(),
        },
      },
    },
    discussion_points: { type: "array", items: evidenceItemSchema("text") },
    person_summaries: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["person_id", "display_name", "text"],
        properties: {
          person_id: { type: "string" },
          display_name: { type: "string" },
          text: { type: "string" },
        },
      },
    },
  },
};

export type ArtifactBuildInput = {
  readonly identity: MeetingIdentity;
  readonly provider: string;
  readonly revision: number;
  readonly endedAt: string;
  readonly attendance: readonly AttendanceInterval[];
  readonly transcript: ReconciledTranscript;
  /** The real session identifier must stay a bigint through the Runtime port. */
  readonly sessionId: bigint;
  readonly runtime: Pick<ConversationRuntimePort, "processText">;
  /** Must only become true after the voice session has ended. R54 is checked
   * before invoking the Runtime, so a live session sees no processText call. */
  readonly meetingEnded: boolean;
  readonly recordingGaps: readonly { readonly startedAt: string; readonly endedAt: string; readonly reason: string }[];
  readonly processingWarnings: readonly { readonly code: string; readonly detail: string }[];
  readonly provenance: {
    readonly runtimeProfile: "offline" | "online";
    readonly sttProvider: string;
    readonly sttModel: string;
    readonly textProvider: string;
    readonly textModel: string;
    readonly agentVersion: string;
    readonly processedAt: string;
    readonly finalBatchModel: string;
    readonly liveStreamModel: string;
  };
  readonly audio: {
    readonly format: string;
    readonly encryption: string;
    readonly durationSeconds: number;
    readonly bytes: number;
    readonly sha256: string;
    readonly expiresAt: string;
  };
  /** In-memory test boundary only. It is deliberately not Task 9 persistence. */
  readonly revisionGuard?: ArtifactRevisionGuard;
  /** Exact project names TeamMem has published; null when that list could not
   * be read. Supplied, only these names are published (project-resolution.ts).
   * Omitted, the model's names pass through unchanged. */
  readonly knownProjects?: readonly string[] | null;
  /** TeamMem refused an earlier revision for quoting its own transcript: the
   * synthesis is told never to quote it verbatim. */
  readonly noVerbatimQuotes?: boolean;
};

export type BuiltTeamMemMeetingArtifact = {
  readonly artifact: TeamMemMeetingArtifact;
  readonly artifact_hash: string;
  /** Canonical compact JSON. Replaying the same occurrence/revision/content
   * produces these identical bytes independently of object insertion order. */
  readonly serialized: string;
};

export type BuiltTeamMemMeetingArtifactV2 = {
  readonly artifact: TeamMemMeetingArtifactV2;
  readonly artifact_hash: string;
  readonly serialized: string;
};

export type ArtifactRevisionGuard = { check(artifact: SupportedTeamMemMeetingArtifact, hash: string): void };
export type TimedArtifactBuildInput = Omit<ArtifactBuildInput, "transcript"> & {
  readonly transcript: TimedReconciledTranscript;
  /** Exact selected reference revalidated by the final reader; never a capability. */
  readonly selectedAlignment: SelectedAlignment;
};

/** Builds the only post-meeting contract payload. The Runtime produces a
 * bounded structured synthesis, but this process validates it locally and
 * validates the completed artifact again before returning it. */
export async function buildTeamMemMeetingArtifact(input: ArtifactBuildInput): Promise<BuiltTeamMemMeetingArtifact> {
  if (!input.meetingEnded) throw new Error("meeting must have ended before processText (R54)");
  const alignment = requireMatchingAlignment(input.transcript.alignment, input.sessionId);
  const participants = participantsFromAttendance(input.attendance);
  const transcript = transcriptFromReconciled(input.transcript.segments, alignment, participants, input.provenance);
  return assembleArtifact(input, participants, transcript, input.transcript.warnings.map(transcriptWarning));
}

/** Historical capture identity is separate from the current processText control. */
export async function buildTimedTeamMemMeetingArtifact(input: TimedArtifactBuildInput): Promise<BuiltTeamMemMeetingArtifact> {
  return buildTimedArtifact(input, "v1");
}

export async function buildTimedTeamMemMeetingArtifactV2(input: TimedArtifactBuildInput): Promise<BuiltTeamMemMeetingArtifactV2> {
  return buildTimedArtifact(input, "v2");
}

function buildTimedArtifact(input: TimedArtifactBuildInput, version: "v1"): Promise<BuiltTeamMemMeetingArtifact>;
function buildTimedArtifact(input: TimedArtifactBuildInput, version: "v2"): Promise<BuiltTeamMemMeetingArtifactV2>;
async function buildTimedArtifact(input: TimedArtifactBuildInput, version: "v1" | "v2"): Promise<BuiltTeamMemMeetingArtifact | BuiltTeamMemMeetingArtifactV2> {
  if (!input.meetingEnded) throw new Error("meeting must have ended before processText (R54)");
  const { transcript: value, selectedAlignment: selected } = input;
  if (value.kind !== "timed_recording_transcript/v1" || value.provenance.occurrenceId !== input.identity.occurrenceId ||
    value.provenance.generationId !== selected.generationId || value.provenance.alignmentAttemptId !== selected.attemptId ||
    value.provenance.timingContract !== "capture-clock/v1" || selected.timingContract !== "capture-clock/v1" ||
    value.provenance.policyId !== "local-wall-estimate/v1" || value.provenance.policyId !== selected.policyId ||
    value.source.sourceSessionId !== selected.source.sourceSessionId || value.source.recordingHandle !== selected.source.recordingHandle ||
    value.source.sha256 !== selected.source.sha256 || input.audio.sha256 !== `sha256:${value.source.sha256}`) throw new Error("timed recording provenance mismatch");
  const participants = participantsFromAttendance(input.attendance);
  const names = new Map(participants.map((entry) => [entry.person_id, entry.display_name]));
  if (names.size > 500 || value.segments.length > 1280) throw new Error("timed artifact output bound exceeded");
  const orderKey = instantOrderKey;
  const meetingStart = orderKey(input.identity.occurrenceStartedAt), meetingEnd = orderKey(input.endedAt);
  const ids = new Set<string>();
  const segments = version === "v2" ? [...value.segments].sort((left, right) => {
    const leftStart = orderKey(left.wall?.startedAt ?? ""), rightStart = orderKey(right.wall?.startedAt ?? "");
    const leftEnd = orderKey(left.wall?.endedAt ?? ""), rightEnd = orderKey(right.wall?.endedAt ?? "");
    return leftStart < rightStart ? -1 : leftStart > rightStart ? 1 : leftEnd < rightEnd ? -1 : leftEnd > rightEnd ? 1
      : left.segmentId < right.segmentId ? -1 : left.segmentId > right.segmentId ? 1 : 0;
  }) : value.segments;
  let previousEnd: string | null = null, clamped = 0, dropped = 0;
  const transcript: TeamMemMeetingArtifact["transcript"] = [];
  for (const segment of segments) {
    const evidence = getOwnedTimedSampleSnapshot(segment.sampleEvidence), range = segment.range, wall = segment.wall;
    if (!evidence || !range || !wall || evidence.sampleRateHz !== range.sampleRateHz ||
      evidence.possibleSamples !== range.endSampleExclusive - range.startSampleInclusive || evidence.possibleSamples <= 0n) throw new Error("timed sample evidence or wall mapping unavailable");
    const end = orderKey(wall.endedAt), early = orderKey(wall.startedAt) < meetingStart;
    const start = early ? meetingStart : orderKey(wall.startedAt);
    if (orderKey(wall.startedAt) > end || ids.has(segment.segmentId)) throw new Error("timed transcript is not representable as ordered nonoverlapping artifact intervals");
    ids.add(segment.segmentId);
    let confidence = 0;
    if (segment.speaker.kind === "named") {
      if (namedTimedCandidate(segment.sampleEvidence!) !== segment.speaker.feishuUserId) throw new Error("timed named evidence mismatch");
      const lower = new Map(evidence.candidateLower).get(segment.speaker.feishuUserId)!;
      confidence = Number(lower * 1000000n / evidence.possibleSamples) / 1000000;
    }
    // Wall times are local estimates: speech estimated before the occurrence
    // start is dropped, or clamped to the start when it runs past it.
    if (end <= meetingStart) { dropped += 1; continue; }
    if (early) clamped += 1;
    if (end > meetingEnd || (version === "v1" && previousEnd !== null && start < previousEnd)) {
      throw new Error("timed transcript is not representable as ordered nonoverlapping artifact intervals");
    }
    previousEnd = end;
    transcript.push({ segment_id: segment.segmentId, started_at: early ? `${meetingStart}Z` : wall.startedAt,
      ended_at: wall.endedAt, text: segment.text, speaker: toArtifactSpeaker(segment, names), attribution_confidence: confidence,
      provenance: { stage: segment.wording === "reconciled" ? "final_batch" : "live_stream",
        model: segment.wording === "reconciled" ? input.provenance.finalBatchModel : input.provenance.liveStreamModel } });
  }
  if (transcript.length && value.warnings.filter(({ code }) => code === "local_wall_timestamp_estimate").length !== 1) throw new Error("timed local-wall warning required");
  const warnings = clamped + dropped === 0 ? value.warnings : [...value.warnings,
    { code: "transcript_before_meeting_start", detail: `${clamped} segment(s) clamped to the meeting start, ${dropped} dropped as wholly before it` }];
  return version === "v1"
    ? assembleArtifact(input, participants, transcript, warnings)
    : assembleArtifactV2(input, participants, transcript, warnings);
}

async function assembleArtifactV2(input: Omit<ArtifactBuildInput, "transcript"> & { readonly transcript: { readonly transcriptComplete: boolean } },
  participants: TeamMemMeetingArtifact["participants"], transcript: TeamMemMeetingArtifact["transcript"],
  transcriptWarnings: readonly { readonly code: string; readonly detail: string }[]): Promise<BuiltTeamMemMeetingArtifactV2> {
  const built = await assembleSupportedArtifact(input, participants, transcript, transcriptWarnings, "v2");
  return built;
}

async function assembleArtifact(input: Omit<ArtifactBuildInput, "transcript"> & { readonly transcript: { readonly transcriptComplete: boolean } },
  participants: TeamMemMeetingArtifact["participants"], transcript: TeamMemMeetingArtifact["transcript"],
  transcriptWarnings: readonly { readonly code: string; readonly detail: string }[]): Promise<BuiltTeamMemMeetingArtifact> {
  const built = await assembleSupportedArtifact(input, participants, transcript, transcriptWarnings, "v1");
  return built;
}

function assembleSupportedArtifact(input: Omit<ArtifactBuildInput, "transcript"> & { readonly transcript: { readonly transcriptComplete: boolean } },
  participants: TeamMemMeetingArtifact["participants"], transcript: TeamMemMeetingArtifact["transcript"],
  transcriptWarnings: readonly { readonly code: string; readonly detail: string }[], version: "v1"): Promise<BuiltTeamMemMeetingArtifact>;
function assembleSupportedArtifact(input: Omit<ArtifactBuildInput, "transcript"> & { readonly transcript: { readonly transcriptComplete: boolean } },
  participants: TeamMemMeetingArtifact["participants"], transcript: TeamMemMeetingArtifact["transcript"],
  transcriptWarnings: readonly { readonly code: string; readonly detail: string }[], version: "v2"): Promise<BuiltTeamMemMeetingArtifactV2>;
async function assembleSupportedArtifact(input: Omit<ArtifactBuildInput, "transcript"> & { readonly transcript: { readonly transcriptComplete: boolean } },
  participants: TeamMemMeetingArtifact["participants"], transcript: TeamMemMeetingArtifact["transcript"],
  transcriptWarnings: readonly { readonly code: string; readonly detail: string }[], version: "v1" | "v2"): Promise<BuiltTeamMemMeetingArtifact | BuiltTeamMemMeetingArtifactV2> {
  const { synthesis, runtimeWarnings: rawRuntimeWarnings, warnings: synthesisWarnings } = await synthesize(input, transcript, version);
  const runtimeWarnings = rawRuntimeWarnings.map(runtimeTextWarning);
  const baseWarnings = input.processingWarnings.length + transcriptWarnings.length + runtimeWarnings.length + synthesisWarnings.length;
  const projects = input.knownProjects === undefined ? { projects: synthesis.projects, warnings: [] }
    : resolveProjects(synthesis.projects, input.knownProjects, MAX_PROCESSING_WARNINGS - baseWarnings);
  if (baseWarnings + projects.warnings.length > MAX_PROCESSING_WARNINGS) {
    throw new Error("processing warning limit exceeded");
  }
  const artifactValue = {
    schema: version === "v1" ? TEAMMEM_MEETING_V1_SCHEMA : "teammem-meeting/v2",
    occurrence_id: input.identity.occurrenceId,
    revision: input.revision,
    provider: input.provider,
    provider_meeting_id: input.identity.providerMeetingId,
    title: input.identity.title,
    started_at: input.identity.occurrenceStartedAt,
    ended_at: input.endedAt,
    organizer: input.identity.organizer === null ? null : { person_id: input.identity.organizer.feishuUserId, display_name: input.identity.organizer.displayName },
    organizer_source: input.identity.organizer?.source ?? null,
    organizer_unresolved_reason: input.identity.organizer === null ? input.identity.organizerUnresolvedReason ?? "organizer_unresolved" : null,
    transcript_complete: input.transcript.transcriptComplete,
    summary: synthesis.summary,
    participants,
    transcript,
    projects: projects.projects,
    decisions: synthesis.decisions,
    action_items: synthesis.action_items,
    discussion_points: synthesis.discussion_points,
    person_summaries: synthesis.person_summaries,
    recording_gaps: input.recordingGaps.map((gap) => ({ started_at: gap.startedAt, ended_at: gap.endedAt, reason: gap.reason })),
    processing_warnings: [...input.processingWarnings, ...transcriptWarnings, ...runtimeWarnings, ...synthesisWarnings, ...projects.warnings],
    provenance: {
      runtime_profile: input.provenance.runtimeProfile,
      stt_provider: input.provenance.sttProvider,
      stt_model: input.provenance.sttModel,
      text_provider: input.provenance.textProvider,
      text_model: input.provenance.textModel,
      agent_version: input.provenance.agentVersion,
      processed_at: input.provenance.processedAt,
    },
    audio: {
      filename: "audio.enc",
      format: input.audio.format,
      encryption: input.audio.encryption,
      duration_seconds: input.audio.durationSeconds,
      bytes: input.audio.bytes,
      sha256: input.audio.sha256,
      expires_at: input.audio.expiresAt,
    },
  };
  // A stray control character from a model or a display name would get the
  // whole bundle quarantined by TeamMem. Normalise it here and say so.
  let normalized = 0;
  const sanitized = mapTeamMemText(artifactValue as SupportedTeamMemMeetingArtifact, (path, kind, value) => {
    let next = normalizeTeamMemText(value, kind);
    // A name that is blank or a dot path segment once stripped (a Feishu topic
    // of "." for instance) gets a fixed fallback instead of failing every build.
    if (kind === "line" && (next.trim() === "" || isDotSegment(next))) next = lineFallback(path, input.identity.meetingNo) ?? next;
    if (next !== value) normalized += 1;
    return next;
  });
  if (normalized > 0) {
    if (sanitized.processing_warnings.length + 1 > MAX_PROCESSING_WARNINGS) throw new Error("processing warning limit exceeded");
    sanitized.processing_warnings.push({ code: "text_normalized", detail: `control characters or unusable names repaired in ${normalized} text field(s)` });
  }
  if (version === "v1") {
    const artifact = parseTeamMemMeetingArtifact(sanitized);
    assertTeamMemText(artifact);
    const artifact_hash = canonicalArtifactHash(artifact);
    input.revisionGuard?.check(artifact, artifact_hash);
    return { artifact, artifact_hash, serialized: canonicalArtifactJson(artifact) };
  }
  const artifact = parseTeamMemMeetingArtifactV2(sanitized);
  assertTeamMemText(artifact);
  const artifact_hash = canonicalArtifactHash(artifact);
  input.revisionGuard?.check(artifact, artifact_hash);
  return { artifact, artifact_hash, serialized: canonicalArtifactJson(artifact) };
}

/** Person ids have no fallback: an identity is never invented. */
function lineFallback(path: string, meetingNo: string): string | null {
  if (path === "title") {
    const number = normalizeTeamMemText(meetingNo, "line").trim();
    return number === "" || isDotSegment(number) ? "Meeting" : `Meeting ${number}`.slice(0, 200);
  }
  if (path.endsWith(".display_name")) return "Participant";
  if (/^projects\[\d+\]\.name$/.test(path)) return "Unnamed project";
  if (path.startsWith("provenance.") || path.endsWith(".provenance.model")) return "unknown";
  return null;
}

/** What normalising cannot repair (a `.` or `..` name) is a visible build
 * failure naming the fields, never a bundle TeamMem quarantines. */
function assertTeamMemText(artifact: SupportedTeamMemMeetingArtifact): void {
  const violations = teamMemTextViolations(artifact);
  if (violations.length > 0) throw new Error(`artifact text violates TeamMem text rules: ${violations.slice(0, 10).join(",")}`);
}

/** A deliberately ephemeral reference implementation of TeamMem's revision
 * rules. Task 8 uses it to make immutable identity testable without owning
 * Task 9's durable inbox/outbox state. */
export function createArtifactRevisionGuard(): ArtifactRevisionGuard {
  const occurrences = new Map<string, Map<number, string>>();
  return {
    check(artifact, hash) {
      const revisions = occurrences.get(artifact.occurrence_id) ?? new Map<number, string>();
      const current = Math.max(0, ...revisions.keys());
      if (artifact.revision < current) throw new Error("artifact revision is lower than the current revision");
      const existing = revisions.get(artifact.revision);
      if (existing !== undefined) {
        if (existing !== hash) throw new Error("artifact revision is immutable: conflicting content");
        return;
      }
      revisions.set(artifact.revision, hash);
      occurrences.set(artifact.occurrence_id, revisions);
    },
  };
}

function participantsFromAttendance(attendance: readonly AttendanceInterval[]): TeamMemMeetingArtifact["participants"] {
  const grouped = new Map<string, AttendanceInterval[]>();
  for (const interval of attendance) {
    const intervals = grouped.get(interval.feishuUserId) ?? [];
    intervals.push(interval);
    grouped.set(interval.feishuUserId, intervals);
  }
  return [...grouped.entries()].map(([person_id, intervals]) => {
    const current = intervals.at(-1)!;
    return {
      person_id,
      display_name: current.displayName,
      attendance: intervals.map((interval) => ({ joined_at: interval.joinedAt, left_at: interval.leftAt })),
    };
  });
}

function transcriptFromReconciled(
  segments: readonly ReconciledSegment[],
  alignment: MediaTimelineAlignment,
  participants: TeamMemMeetingArtifact["participants"],
  provenance: ArtifactBuildInput["provenance"],
): TeamMemMeetingArtifact["transcript"] {
  const names = new Map(participants.map((entry) => [entry.person_id, entry.display_name]));
  return segments.map((segment) => ({
    segment_id: segment.segmentId,
    started_at: addMillisecondsToUtcInstant(alignment.mediaOriginAt, segment.startedAtMs),
    ended_at: addMillisecondsToUtcInstant(alignment.mediaOriginAt, segment.endedAtMs),
    text: segment.text,
    speaker: toArtifactSpeaker(segment, names),
    attribution_confidence: attributionConfidence(segment, validateReconciledEvidence(segment)),
    provenance: {
      stage: segment.provenance.wording === "reconciled" ? "final_batch" : "live_stream",
      model: segment.provenance.wording === "reconciled" ? provenance.finalBatchModel : provenance.liveStreamModel,
    },
  }));
}

function toArtifactSpeaker(segment: Pick<ReconciledSegment, "speaker">, names: ReadonlyMap<string, string>) {
  switch (segment.speaker.kind) {
    case "named": {
      const display_name = names.get(segment.speaker.feishuUserId);
      if (display_name === undefined) throw new Error("reconciled named speaker is not an actual participant");
      return { kind: "person" as const, person_id: segment.speaker.feishuUserId, display_name, reconciled: true as const };
    }
    case "anonymous":
      return { kind: "anonymous" as const, cluster_id: segment.speaker.label };
    case "ambiguous":
      return { kind: "ambiguous" as const };
  }
}

type ReconciledEvidenceSnapshot = {
  readonly duration: number;
  readonly assertedMs: number;
};

function validateReconciledEvidence(segment: ReconciledSegment): ReconciledEvidenceSnapshot {
  if (!Number.isSafeInteger(segment.startedAtMs) || !Number.isSafeInteger(segment.endedAtMs) || segment.startedAtMs < 0 || segment.endedAtMs < segment.startedAtMs) {
    throw new Error("reconciled attribution evidence is invalid");
  }
  const duration = segment.endedAtMs - segment.startedAtMs;
  if (duration <= 0) throw new Error("reconciled attribution evidence is invalid");
  const snapshot = getOwnedUiExactMsSnapshot(segment.provenance.uiExactMs);
  if (snapshot === null) throw new Error("reconciled attribution evidence is invalid");
  const uiExactMs = new Map(snapshot);
  const components = [
    ...uiExactMs.values(),
    segment.provenance.ambiguousMs,
    segment.provenance.unobservedMs,
  ];
  let total = 0n;
  for (const value of components) {
    if (!Number.isSafeInteger(value) || value < 0 || value > duration) {
      throw new Error("reconciled attribution evidence is invalid");
    }
    total += BigInt(value);
  }
  if (total > BigInt(duration)) throw new Error("reconciled attribution evidence is invalid");
  let assertedMs = 0;
  if (segment.speaker.kind === "named") {
    if (!uiExactMs.has(segment.speaker.feishuUserId)) throw new Error("reconciled attribution evidence is invalid");
    assertedMs = uiExactMs.get(segment.speaker.feishuUserId)!;
    if (assertedMs <= 0) throw new Error("reconciled attribution evidence is invalid");
  }
  return { duration, assertedMs };
}

function attributionConfidence(segment: ReconciledSegment, evidence: ReconciledEvidenceSnapshot): number {
  if (segment.speaker.kind !== "named") return 0;
  return evidence.assertedMs / evidence.duration;
}

function requireMatchingAlignment(alignment: MediaTimelineAlignment | null, sessionId: bigint): MediaTimelineAlignment {
  if (alignment === null || alignment.kind !== "durable_runtime_anchor" || alignment.runtimeSessionId !== sessionId) {
    throw new Error("durable Runtime media timeline alignment is required for artifact construction");
  }
  try {
    addMillisecondsToUtcInstant(alignment.mediaOriginAt, 0);
  } catch {
    throw new Error("durable Runtime media timeline alignment is invalid");
  }
  return alignment;
}

function transcriptWarning(warning: TranscriptWarning): { readonly code: string; readonly detail: string } {
  switch (warning.code) {
    case "reconciliation_unavailable": return { code: warning.code, detail: warning.detail };
    case "reconciled_text_missing": return { code: warning.code, detail: `segments=${warning.segments}` };
    case "durable_evidence_incomplete": return { code: warning.code, detail: warning.reason };
    case "runtime_warning": return { code: warning.code, detail: warning.detail };
    case "live_segment_outside_reconciliation": return { code: warning.code, detail: `segment_count=${warning.segmentIds.length}` };
    case "multi_voice_live_segment": return { code: warning.code, detail: `segment_count=${warning.segmentIds.length}` };
    case "cluster_identity_conflict": return { code: warning.code, detail: `cluster=${warning.cluster};identity_count=${warning.feishuUserIds.length}` };
    default: return { code: warning.code, detail: warning.code };
  }
}

function runtimeTextWarning(warning: string): { readonly code: string; readonly detail: string } {
  if (!isUnicodeScalarString(warning)) throw new Error("runtime text warning cannot be represented safely");
  const digest = createHash("sha256").update(warning, "utf8").digest("hex");
  return { code: "runtime_text_warning", detail: `Runtime text processing warning (sha256:${digest})` };
}

/** A UTC instant as a string that orders by time, whatever its fraction width. */
function instantOrderKey(instant: string): string {
  try {
    const canonical = addMillisecondsToUtcInstant(instant, 0);
    return `${canonical.slice(0, 19)}.${canonical.slice(19, -1).replace(".", "").padEnd(6, "0")}`;
  } catch { throw new Error("timed artifact wall instant is invalid"); }
}

type TextSynthesis = z.infer<typeof textSynthesisContract>;
type ProcessingWarning = { readonly code: string; readonly detail: string };
type ArtifactTranscript = TeamMemMeetingArtifact["transcript"];

/** processText calls: every window call plus every reduce call, each reduce
 * counted twice for its one retry here (D047). The Runtime may also retry a
 * schema-invalid answer once inside any processText call, so provider chats
 * can reach twice this. */
const MAX_SYNTHESIS_CALLS = 64;
/** Window or partial summaries merged by one reduce call. */
const REDUCE_FAN_IN = 6;
/** Each window and partial merge is asked to keep its prose to this, so
 * REDUCE_FAN_IN of them fit one Runtime input even at three UTF-8 bytes a
 * character with up to nine people each (Feishu-length IDs); with ten they do
 * not. A merge input that still runs over is a visible build failure. */
const PART_PROSE_CHARACTERS = 600;
/** The synthesis contract's bounds on a list and on an item's evidence. */
const MAX_SYNTHESIS_ITEMS = 500, MAX_EVIDENCE_IDS = 100;

const WINDOW_INSTRUCTION = (index: number, count: number) => ` This input is window ${index + 1} of ${count} of one meeting transcript, in time order. Synthesize only what this window shows and cite only its segment IDs; the windows are merged afterwards. Keep the summary and all person summaries together within ${PART_PROSE_CHARACTERS} characters.`;
const REDUCE_INSTRUCTION = "Merge these per-window syntheses of one meeting, given in time order, into one factual meeting summary and one summary per person. Use only what the window summaries state; do not add facts or infer identities. Return exactly one person summary for each person_id given, with its display_name exactly as given, and no other person.";
const PARTIAL_REDUCE_INSTRUCTION = ` These windows are one part of a longer meeting and this merge is merged again with the other parts: keep the summary and all person summaries together within ${PART_PROSE_CHARACTERS} characters.`;
const REDUCE_RETRY_INSTRUCTION = " An earlier answer to this request did not return exactly the people given.";
const reduceContract = textSynthesisContract.pick({ summary: true, person_summaries: true });
const REDUCE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "person_summaries"],
  properties: {
    summary: (TEAMMEM_TEXT_OUTPUT_SCHEMA.properties as Record<string, unknown>).summary,
    person_summaries: (TEAMMEM_TEXT_OUTPUT_SCHEMA.properties as Record<string, unknown>).person_summaries,
  },
};

type ReducePart = Pick<TextSynthesis, "summary" | "person_summaries"> & { readonly first_window: number; readonly last_window: number };

/** Map/reduce over a transcript the Runtime would refuse in one input (D047).
 *
 * A transcript that fits is one call, exactly as before windowing. Otherwise
 * it is cut into ordered windows that each fit the input cap, never inside a
 * segment and, where a cut exists, never between entries whose times overlap
 * (a live entry and the final entry that observed the same speech). Each
 * window is synthesized with the usual instructions and may cite only its own
 * segments, unless the item is a project that is not published and so is
 * dropped anyway.
 *
 * Merging: projects, decisions, action items and discussion points are lists
 * of ID-backed items, so they are merged deterministically: concatenated in
 * window order, an identical item seen in several windows kept once with the
 * union of its evidence. A merged item citing more than MAX_EVIDENCE_IDS keeps
 * an even spread of them (spreadEvidence) and is named in an
 * `evidence_thinned` warning; the item and its text stay. `summary` and
 * `person_summaries` are prose, merged by the model in rounds of at most
 * REDUCE_FAN_IN parts until one remains, so they always come from the model.
 * No item or text is cut: a merged list over its bound, a reduce input over
 * the cap, or a reduce answer that does not return exactly its people is a
 * visible build failure. Every call is planned, and checked against
 * MAX_SYNTHESIS_CALLS, before the first one. */
async function synthesize(input: Omit<ArtifactBuildInput, "transcript">, transcript: ArtifactTranscript, version: "v1" | "v2"): Promise<{
  readonly synthesis: TextSynthesis; readonly runtimeWarnings: readonly string[]; readonly warnings: readonly ProcessingWarning[];
}> {
  const noVerbatim = input.noVerbatimQuotes === true ? NO_VERBATIM_INSTRUCTION : "";
  const instructions = (version === "v1"
    ? "Produce only the requested factual meeting synthesis. Preserve explicit owners and due dates only when stated; every project, decision, action item, and discussion point must cite stored transcript segment IDs. Do not infer identities, owners, or dates. Under projects, list each project the meeting substantively discussed, whether named outright or clearly referred to, using the exact name from known_projects when one applies, and cite the segment IDs that show the discussion. Leave projects empty when none applies."
    : "Produce only the requested factual meeting synthesis. Preserve explicit owners and due dates only when stated; every project, decision, action item, and discussion point must cite stored transcript segment IDs. Do not infer identities, owners, or dates. Under projects, list each project the meeting substantively discussed, whether named outright or clearly referred to, using the exact name from known_projects when one applies, and cite the segment IDs that show the discussion. Leave projects empty when none applies. Overlapping live/final entries are observations that may describe the same speech, not proof of repeated events; retain ID-backed factual evidence without inventing identities.") + noVerbatim;
  const windows = synthesisWindows(transcript, version, input.knownProjects);
  const count = windows.length;
  const rounds = reduceRounds(count), reduceCalls = rounds.reduce((sum, calls) => sum + calls, 0);
  if (count + 2 * reduceCalls > MAX_SYNTHESIS_CALLS) {
    throw new Error(`meeting transcript needs ${count} synthesis windows and ${reduceCalls} reduce calls, up to ${count + 2 * reduceCalls} calls with retries; at most ${MAX_SYNTHESIS_CALLS} are allowed`);
  }
  // Undefined when the name is not published, so the artifact drops the project.
  const publishedName = ({ name }: { readonly name: string }) => input.knownProjects === undefined ? name
    : resolveProjects([{ name, evidence_segment_ids: [] }], input.knownProjects).projects[0]?.name;
  const outputs: TextSynthesis[] = [], runtimeWarnings: string[] = [];
  for (const [index, window] of windows.entries()) {
    const processed = await input.runtime.processText({
      sessionId: input.sessionId,
      instructions: count === 1 ? instructions : instructions + WINDOW_INSTRUCTION(index, count),
      input: canonicalSynthesisInput(window, version, input.knownProjects),
      outputSchema: TEAMMEM_TEXT_OUTPUT_SCHEMA,
      maxOutputBytes: MAX_PROCESSED_OUTPUT_BYTES,
    });
    const synthesis = textSynthesisContract.parse(processed.output);
    // One window is the whole transcript: the artifact checks its evidence as before.
    // A project that is not published is dropped below, as it is from one window,
    // so only a published one must cite this window.
    const ids = new Set(window.map(({ segment_id }) => segment_id));
    const published = synthesis.projects.filter((project) => publishedName(project) !== undefined);
    if (count > 1 && [...published, ...synthesis.decisions, ...synthesis.action_items, ...synthesis.discussion_points]
      .some(({ evidence_segment_ids }) => evidence_segment_ids.some((id) => !ids.has(id)))) {
      throw new Error(`synthesis window ${index + 1} of ${count} cites evidence_segment_ids outside the window`);
    }
    outputs.push(synthesis);
    runtimeWarnings.push(...processed.warnings);
  }
  if (count === 1) return { synthesis: outputs[0]!, runtimeWarnings, warnings: [] };

  const lists = <K extends "projects" | "decisions" | "action_items" | "discussion_points">(field: K) => outputs.map((output) => output[field]);
  const unpublished = lists("projects").flat().filter((project) => publishedName(project) === undefined);
  const windowIds = windows.map((window) => window.map(({ segment_id }) => segment_id)), thinned: ProcessingWarning[] = [];
  const merged = {
    // Published projects merge under their published name; the rest are only
    // named in a warning after the merge, whatever they cite.
    projects: [...mergeItems(lists("projects").map((projects) => projects.filter((project) => publishedName(project) !== undefined)),
      (project) => publishedName(project)!, "projects", windowIds, thinned),
      ...unpublished.filter((project, index) => unpublished.findIndex(({ name }) => name === project.name) === index)],
    decisions: mergeItems(lists("decisions"), ({ text }) => text, "decisions", windowIds, thinned),
    action_items: mergeItems(lists("action_items"), ({ text, owner, due_date }) => JSON.stringify([text, owner, due_date]), "action_items", windowIds, thinned),
    discussion_points: mergeItems(lists("discussion_points"), ({ text }) => text, "discussion_points", windowIds, thinned),
  };
  let parts: ReducePart[] = outputs.map(({ summary, person_summaries }, index) => ({ first_window: index + 1, last_window: index + 1, summary, person_summaries }));
  for (const [round, calls] of rounds.entries()) {
    const next: ReducePart[] = [];
    for (let call = 0; call < calls; call += 1) {
      const group = parts.slice(Math.floor(call * parts.length / calls), Math.floor((call + 1) * parts.length / calls));
      const reduceInput = JSON.stringify({ parts: group });
      const label = `synthesis reduce round ${round + 1} of ${rounds.length}, windows ${group[0]!.first_window}-${group.at(-1)!.last_window}`;
      const bytes = Buffer.byteLength(reduceInput, "utf8");
      if (bytes > MAX_PROCESSING_INPUT_BYTES) throw new Error(`${label}: the summaries take ${bytes} bytes, over the Runtime text processing input cap of ${MAX_PROCESSING_INPUT_BYTES}`);
      const people = new Map(group.flatMap(({ person_summaries }) => person_summaries.map(({ person_id, display_name }) => [person_id, display_name] as const)));
      let prose: Pick<TextSynthesis, "summary" | "person_summaries"> | undefined;
      for (let attempt = 0; prose === undefined; attempt += 1) {
        if (attempt === 2) throw new Error(`${label}: the answer did not return exactly the people the windows summarized`);
        const processed = await input.runtime.processText({ sessionId: input.sessionId,
          instructions: REDUCE_INSTRUCTION + (round < rounds.length - 1 ? PARTIAL_REDUCE_INSTRUCTION : "") + (attempt > 0 ? REDUCE_RETRY_INSTRUCTION : "") + noVerbatim,
          input: reduceInput, outputSchema: REDUCE_OUTPUT_SCHEMA, maxOutputBytes: MAX_PROCESSED_OUTPUT_BYTES });
        const answer = reduceContract.parse(processed.output);
        runtimeWarnings.push(...processed.warnings);
        const returned = answer.person_summaries;
        if (returned.length === people.size && new Set(returned.map(({ person_id }) => person_id)).size === people.size &&
          returned.every(({ person_id, display_name }) => people.get(person_id) === display_name)) prose = answer;
      }
      next.push({ first_window: group[0]!.first_window, last_window: group.at(-1)!.last_window, ...prose });
    }
    parts = next;
  }
  const warnings: ProcessingWarning[] = [
    ...thinned,
    { code: "synthesis_reduced", detail: `the ${count} window summaries were merged by the model in ${rounds.length} reduce round(s) of ${rounds.join(", ")} call(s)` },
    { code: "synthesis_windowed", detail: `transcript synthesized in ${count} windows covering all ${transcript.length} segments` },
  ];
  return { synthesis: { summary: parts[0]!.summary, person_summaries: parts[0]!.person_summaries, ...merged }, runtimeWarnings, warnings };
}

/** Reduce calls per round until one part remains. */
function reduceRounds(count: number): number[] {
  const rounds: number[] = [];
  for (let parts = count; parts > 1; parts = rounds.at(-1)!) rounds.push(Math.ceil(parts / REDUCE_FAN_IN));
  return rounds;
}

/** Ordered windows whose serialized input each fits the Runtime input cap. */
function synthesisWindows(transcript: ArtifactTranscript, version: "v1" | "v2", knownProjects: readonly string[] | null | undefined): ArtifactTranscript[] {
  if (Buffer.byteLength(canonicalSynthesisInput(transcript, version, knownProjects), "utf8") <= MAX_PROCESSING_INPUT_BYTES) return [transcript];
  // The serialized input is the empty envelope plus each entry and a comma between entries.
  const envelope = Buffer.byteLength(canonicalSynthesisInput([], version, knownProjects), "utf8");
  const sizes = transcript.map((segment) => Buffer.byteLength(JSON.stringify(synthesisEntry(segment, version)), "utf8"));
  const starts = transcript.map(({ started_at }) => instantOrderKey(started_at)), ends = transcript.map(({ ended_at }) => instantOrderKey(ended_at));
  const windows: ArtifactTranscript[] = [];
  for (let start = 0; start < transcript.length;) {
    let end = start, used = envelope;
    while (end < transcript.length && used + sizes[end]! + (end > start ? 1 : 0) <= MAX_PROCESSING_INPUT_BYTES) {
      used += sizes[end]! + (end > start ? 1 : 0);
      end += 1;
    }
    if (end === start) {
      const bare = Buffer.byteLength(canonicalSynthesisInput([], version, null), "utf8");
      throw new Error(bare + sizes[start]! <= MAX_PROCESSING_INPUT_BYTES
        ? `the published project list (${synthesisProjectVocabulary(knownProjects).length} names, ${envelope - bare} bytes) leaves no room for transcript segment ${transcript[start]!.segment_id} under the Runtime text processing input cap of ${MAX_PROCESSING_INPUT_BYTES} bytes`
        : `transcript segment ${transcript[start]!.segment_id} alone exceeds the Runtime text processing input cap of ${MAX_PROCESSING_INPUT_BYTES} bytes`);
    }
    if (end < transcript.length) {
      // Prefer the latest cut no earlier entry of this window overlaps, unless
      // it would leave the window less than half full: a long run of
      // overlapping entries is then cut where it overflows.
      let latestEnd = ends[start]!, cut = start;
      for (let index = start + 1; index <= end; index += 1) {
        if (latestEnd <= starts[index]!) cut = index;
        if (ends[index]! > latestEnd) latestEnd = ends[index]!;
      }
      if (cut - start >= (end - start) / 2) end = cut;
    }
    windows.push(transcript.slice(start, end));
    start = end;
  }
  return windows;
}

/** Concatenates items in window order; identical items become one citing the
 * union of their evidence. A merged list over MAX_SYNTHESIS_ITEMS is a visible
 * build failure naming the field. An item whose windows together cite more
 * than MAX_EVIDENCE_IDS keeps the spreadEvidence selection of them, and one
 * `evidence_thinned` warning per such item goes to `thinned`, naming the
 * field, the item (a project by its published name, any other item by its
 * position in the merged list) and the kept and cited counts. A name is at
 * most 200 characters, so the detail stays well within the 500 a warning
 * allows. These warnings count toward MAX_PROCESSING_WARNINGS like every
 * synthesis warning: a build they would take past it fails visibly
 * ("processing warning limit exceeded"), so none is dropped (D047). */
function mergeItems<T extends { readonly evidence_segment_ids: string[] }>(lists: readonly (readonly T[])[], key: (item: T) => string, field: string,
  windowIds: readonly (readonly string[])[], thinned: ProcessingWarning[]): T[] {
  const merged = new Map<string, T>();
  for (const item of lists.flat()) {
    const existing = merged.get(key(item));
    merged.set(key(item), existing === undefined ? item
      : { ...existing, evidence_segment_ids: [...new Set([...existing.evidence_segment_ids, ...item.evidence_segment_ids])] });
  }
  const items = [...merged.values()];
  if (items.length > MAX_SYNTHESIS_ITEMS) throw new Error(`merged synthesis ${field} has ${items.length} items; the artifact allows at most ${MAX_SYNTHESIS_ITEMS}`);
  return items.map((item, index) => {
    // Only a merged item can exceed the bound, and its union has no repeats.
    if (item.evidence_segment_ids.length <= MAX_EVIDENCE_IDS) return item;
    // Every ID is in its own window, so each window's cited IDs come out in transcript order.
    const cited = new Set(item.evidence_segment_ids);
    const perWindow = windowIds.map((ids) => ids.filter((id) => cited.has(id))).filter((ids) => ids.length > 0);
    const kept = spreadEvidence(perWindow, MAX_EVIDENCE_IDS);
    const name = field === "projects" ? `"${key(item)}"` : `${index + 1} of ${items.length}`;
    thinned.push({ code: "evidence_thinned", detail: `${field} item ${name}: kept ${kept.length} of ${cited.size} evidence segment IDs, spread across the ${perWindow.length} windows that cite it` });
    return { ...item, evidence_segment_ids: kept };
  });
}

/** The `limit` evidence IDs an item keeps when its windows together cite more
 * (D047). `windows` holds, for each window citing the item in time order, the
 * IDs it cites in transcript order; the result is in transcript order.
 *
 * Slots per window, max-min fair: every window is offered the same share,
 * floor(slots left / windows still sharing). A window citing no more than its
 * share keeps all its IDs and leaves the sharing; the rest share again what is
 * left. Once every window still sharing cites more than the share, each gets
 * the share, and the slots that do not divide evenly go one each to the
 * earliest of them. So no window keeps more than it cites, every citing window
 * keeps at least one ID (the share starts at floor(limit / windows) >= 1 and
 * never falls), and exactly `limit` are kept when more are cited.
 *
 * Within a window that keeps c of its n IDs: the IDs at positions
 * floor((2j + 1) * n / (2c)) for j = 0 .. c - 1, the middle of each of c equal
 * runs, so the kept IDs are evenly spaced and distinct.
 *
 * More citing windows than `limit` cannot happen: at most 42 windows plan
 * within MAX_SYNTHESIS_CALLS, under the 100 an item may cite. It is checked. */
export function spreadEvidence(windows: readonly (readonly string[])[], limit: number): string[] {
  if (windows.length > limit) throw new Error(`an item cited in ${windows.length} windows cannot keep an evidence segment ID from each within ${limit}`);
  const slots = windows.map(() => 0);
  let sharing = windows.map((_, index) => index), left = limit;
  while (sharing.length > 0) {
    const share = Math.floor(left / sharing.length);
    const within = sharing.filter((index) => windows[index]!.length <= share);
    if (within.length === 0) {
      sharing.forEach((index, order) => { slots[index] = share + (order < left % sharing.length ? 1 : 0); });
      break;
    }
    for (const index of within) { slots[index] = windows[index]!.length; left -= windows[index]!.length; }
    sharing = sharing.filter((index) => windows[index]!.length > share);
  }
  return windows.flatMap((ids, index) => Array.from({ length: slots[index]! }, (_, j) => ids[Math.floor((2 * j + 1) * ids.length / (2 * slots[index]!))]!));
}

function synthesisEntry(segment: ArtifactTranscript[number], version: "v1" | "v2") {
  return version === "v1"
    ? { segment_id: segment.segment_id, text: segment.text, speaker: segment.speaker }
    : { segment_id: segment.segment_id, text: segment.text, speaker: segment.speaker, started_at: segment.started_at,
        ended_at: segment.ended_at, provenance: segment.provenance };
}

/** The published project names, then the transcript the synthesis cites. */
function canonicalSynthesisInput(transcript: ArtifactTranscript, version: "v1" | "v2",
  knownProjects: readonly string[] | null | undefined): string {
  return JSON.stringify({ known_projects: synthesisProjectVocabulary(knownProjects), transcript: transcript.map((segment) => synthesisEntry(segment, version)) });
}

function evidenceSchema(): Record<string, unknown> {
  return { type: "array", items: { type: "string" } };
}

function evidenceItemSchema(field: "name" | "text"): Record<string, unknown> {
  return {
    type: "object", additionalProperties: false,
    required: [field, "evidence_segment_ids"],
    properties: { [field]: { type: "string" }, evidence_segment_ids: evidenceSchema() },
  };
}
