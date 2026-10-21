// Post-meeting-only construction of the frozen TeamMem artifact. This module
// creates no files and performs no delivery: Task 9 owns the outbox/bundle.

import { createHash } from "node:crypto";
import { z } from "zod";
import { CLIENT_PROTOCOL_VERSION, validateClientCommand } from "@conversation/runtime";

import {
  addMillisecondsToUtcInstant,
  canonicalArtifactHash,
  canonicalArtifactJson,
  isUnicodeScalarString,
  parseTeamMemMeetingArtifact,
  TEAMMEM_MEETING_V1_SCHEMA,
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
  const orderKey = (instant: string) => {
    try {
      const canonical = addMillisecondsToUtcInstant(instant, 0);
      return `${canonical.slice(0, 19)}.${canonical.slice(19, -1).replace(".", "").padEnd(6, "0")}`;
    } catch { throw new Error("timed artifact wall instant is invalid"); }
  };
  const meetingStart = orderKey(input.identity.occurrenceStartedAt), meetingEnd = orderKey(input.endedAt);
  const ids = new Set<string>();
  const segments = version === "v2" ? [...value.segments].sort((left, right) => {
    const leftStart = orderKey(left.wall?.startedAt ?? ""), rightStart = orderKey(right.wall?.startedAt ?? "");
    const leftEnd = orderKey(left.wall?.endedAt ?? ""), rightEnd = orderKey(right.wall?.endedAt ?? "");
    return leftStart < rightStart ? -1 : leftStart > rightStart ? 1 : leftEnd < rightEnd ? -1 : leftEnd > rightEnd ? 1
      : left.segmentId < right.segmentId ? -1 : left.segmentId > right.segmentId ? 1 : 0;
  }) : value.segments;
  let previousEnd: string | null = null;
  const transcript: TeamMemMeetingArtifact["transcript"] = segments.map((segment) => {
    const evidence = getOwnedTimedSampleSnapshot(segment.sampleEvidence), range = segment.range, wall = segment.wall;
    if (!evidence || !range || !wall || evidence.sampleRateHz !== range.sampleRateHz ||
      evidence.possibleSamples !== range.endSampleExclusive - range.startSampleInclusive || evidence.possibleSamples <= 0n) throw new Error("timed sample evidence or wall mapping unavailable");
    const start = orderKey(wall.startedAt), end = orderKey(wall.endedAt);
    if (start > end || start < meetingStart || end > meetingEnd || (version === "v1" && previousEnd !== null && start < previousEnd) || ids.has(segment.segmentId)) {
      throw new Error("timed transcript is not representable as ordered nonoverlapping artifact intervals");
    }
    previousEnd = end; ids.add(segment.segmentId);
    let confidence = 0;
    if (segment.speaker.kind === "named") {
      if (namedTimedCandidate(segment.sampleEvidence!) !== segment.speaker.feishuUserId) throw new Error("timed named evidence mismatch");
      const lower = new Map(evidence.candidateLower).get(segment.speaker.feishuUserId)!;
      confidence = Number(lower * 1000000n / evidence.possibleSamples) / 1000000;
    }
    return { segment_id: segment.segmentId, started_at: wall.startedAt, ended_at: wall.endedAt, text: segment.text,
      speaker: toArtifactSpeaker(segment, names), attribution_confidence: confidence,
      provenance: { stage: segment.wording === "reconciled" ? "final_batch" : "live_stream",
        model: segment.wording === "reconciled" ? input.provenance.finalBatchModel : input.provenance.liveStreamModel } };
  });
  if (transcript.length && value.warnings.filter(({ code }) => code === "local_wall_timestamp_estimate").length !== 1) throw new Error("timed local-wall warning required");
  return version === "v1"
    ? assembleArtifact(input, participants, transcript, value.warnings)
    : assembleArtifactV2(input, participants, transcript, value.warnings);
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
  const processed = await input.runtime.processText({
    sessionId: input.sessionId,
    instructions: version === "v1"
      ? "Produce only the requested factual meeting synthesis. Preserve explicit owners and due dates only when stated; every project, decision, action item, and discussion point must cite stored transcript segment IDs. Do not infer identities, owners, or dates. Under projects, list each project the meeting substantively discussed, whether named outright or clearly referred to, using the exact name from known_projects when one applies, and cite the segment IDs that show the discussion. Leave projects empty when none applies."
      : "Produce only the requested factual meeting synthesis. Preserve explicit owners and due dates only when stated; every project, decision, action item, and discussion point must cite stored transcript segment IDs. Do not infer identities, owners, or dates. Under projects, list each project the meeting substantively discussed, whether named outright or clearly referred to, using the exact name from known_projects when one applies, and cite the segment IDs that show the discussion. Leave projects empty when none applies. Overlapping live/final entries are observations that may describe the same speech, not proof of repeated events; retain ID-backed factual evidence without inventing identities.",
    input: canonicalSynthesisInput(transcript, version, input.knownProjects),
    outputSchema: TEAMMEM_TEXT_OUTPUT_SCHEMA,
    maxOutputBytes: MAX_PROCESSED_OUTPUT_BYTES,
  });
  const synthesis = textSynthesisContract.parse(processed.output);
  const runtimeWarnings = processed.warnings.map(runtimeTextWarning);
  const baseWarnings = input.processingWarnings.length + transcriptWarnings.length + runtimeWarnings.length;
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
    organizer_unresolved_reason: input.identity.organizer === null ? "instant_meeting" : null,
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
    processing_warnings: [...input.processingWarnings, ...transcriptWarnings, ...runtimeWarnings, ...projects.warnings],
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
  if (version === "v1") {
    const artifact = parseTeamMemMeetingArtifact(artifactValue);
    const artifact_hash = canonicalArtifactHash(artifact);
    input.revisionGuard?.check(artifact, artifact_hash);
    return { artifact, artifact_hash, serialized: canonicalArtifactJson(artifact) };
  }
  const artifact = parseTeamMemMeetingArtifactV2(artifactValue);
  const artifact_hash = canonicalArtifactHash(artifact);
  input.revisionGuard?.check(artifact, artifact_hash);
  return { artifact, artifact_hash, serialized: canonicalArtifactJson(artifact) };
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

/** The published project names, then the transcript the synthesis cites. */
function canonicalSynthesisInput(transcript: TeamMemMeetingArtifact["transcript"], version: "v1" | "v2",
  knownProjects: readonly string[] | null | undefined): string {
  return JSON.stringify({ known_projects: synthesisProjectVocabulary(knownProjects), transcript: transcript.map((segment) => version === "v1"
    ? { segment_id: segment.segment_id, text: segment.text, speaker: segment.speaker }
    : { segment_id: segment.segment_id, text: segment.text, speaker: segment.speaker, started_at: segment.started_at,
        ended_at: segment.ended_at, provenance: segment.provenance }) });
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
