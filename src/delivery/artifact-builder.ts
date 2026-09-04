// Post-meeting-only construction of the frozen TeamMem artifact. This module
// creates no files and performs no delivery: Task 9 owns the outbox/bundle.

import { z } from "zod";

import {
  canonicalArtifactHash,
  canonicalArtifactJson,
  parseTeamMemMeetingArtifact,
  TEAMMEM_MEETING_V1_SCHEMA,
  type TeamMemMeetingArtifact,
} from "../contracts/teammem-meeting-v1.ts";
import type { MeetingIdentity } from "../domain/meeting.ts";
import type { AttendanceInterval } from "../domain/participants.ts";
import type { ReconciledSegment, ReconciledTranscript, TranscriptWarning } from "../domain/transcript.ts";
import type { ConversationRuntimePort } from "../ports/conversation-runtime.ts";

const text = z.string().min(1).max(20_000);
const evidence = z.array(z.string().min(1).max(200)).min(1).max(100);

const textSynthesis = z.object({
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

export const TEAMMEM_TEXT_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "projects", "decisions", "action_items", "discussion_points", "person_summaries"],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 20_000 },
    projects: { type: "array", maxItems: 500, items: evidenceItemSchema("name") },
    decisions: { type: "array", maxItems: 500, items: evidenceItemSchema("text") },
    action_items: {
      type: "array", maxItems: 500,
      items: {
        type: "object", additionalProperties: false,
        required: ["text", "owner", "due_date", "evidence_segment_ids"],
        properties: {
          text: { type: "string", minLength: 1, maxLength: 20_000 },
          owner: { anyOf: [{ type: "null" }, explicitOwnerSchema()] },
          due_date: { anyOf: [{ type: "null" }, explicitDueDateSchema()] },
          evidence_segment_ids: evidenceSchema(),
        },
      },
    },
    discussion_points: { type: "array", maxItems: 500, items: evidenceItemSchema("text") },
    person_summaries: {
      type: "array", maxItems: 500,
      items: {
        type: "object", additionalProperties: false,
        required: ["person_id", "display_name", "text"],
        properties: {
          person_id: { type: "string", minLength: 1, maxLength: 200 },
          display_name: { type: "string", minLength: 1, maxLength: 200 },
          text: { type: "string", minLength: 1, maxLength: 20_000 },
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
};

export type BuiltTeamMemMeetingArtifact = {
  readonly artifact: TeamMemMeetingArtifact;
  readonly artifact_hash: string;
  /** Canonical compact JSON. Replaying the same occurrence/revision/content
   * produces these identical bytes independently of object insertion order. */
  readonly serialized: string;
};

export type ArtifactRevisionGuard = { check(artifact: TeamMemMeetingArtifact, hash: string): void };

/** Builds the only post-meeting contract payload. The Runtime produces a
 * bounded structured synthesis, but this process validates it locally and
 * validates the completed artifact again before returning it. */
export async function buildTeamMemMeetingArtifact(input: ArtifactBuildInput): Promise<BuiltTeamMemMeetingArtifact> {
  if (!input.meetingEnded) throw new Error("meeting must have ended before processText (R54)");
  const participants = participantsFromAttendance(input.attendance);
  const transcript = transcriptFromReconciled(input.transcript.segments, input.identity.occurrenceStartedAt, participants, input.provenance);
  const processed = await input.runtime.processText({
    sessionId: input.sessionId,
    instructions: "Produce only the requested factual meeting synthesis. Preserve explicit owners and due dates only when stated; every project, decision, action item, and discussion point must cite stored transcript segment IDs. Do not infer identities, owners, dates, or projects.",
    input: canonicalTranscriptInput(transcript),
    outputSchema: TEAMMEM_TEXT_OUTPUT_SCHEMA,
    maxOutputBytes: 1_000_000,
  });
  const synthesis = textSynthesis.parse(processed.output);
  const artifact = parseTeamMemMeetingArtifact({
    schema: TEAMMEM_MEETING_V1_SCHEMA,
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
    projects: synthesis.projects,
    decisions: synthesis.decisions,
    action_items: synthesis.action_items,
    discussion_points: synthesis.discussion_points,
    person_summaries: synthesis.person_summaries,
    recording_gaps: input.recordingGaps.map((gap) => ({ started_at: gap.startedAt, ended_at: gap.endedAt, reason: gap.reason })),
    processing_warnings: [...input.processingWarnings, ...input.transcript.warnings.map(transcriptWarning)],
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
  });
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
      const existing = revisions.get(artifact.revision);
      if (existing !== undefined) {
        if (existing !== hash) throw new Error("artifact revision is immutable: conflicting content");
        return;
      }
      const current = Math.max(0, ...revisions.keys());
      if (artifact.revision < current) throw new Error("artifact revision is lower than the current revision");
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
  meetingStartedAt: string,
  participants: TeamMemMeetingArtifact["participants"],
  provenance: ArtifactBuildInput["provenance"],
): TeamMemMeetingArtifact["transcript"] {
  const names = new Map(participants.map((entry) => [entry.person_id, entry.display_name]));
  return segments.map((segment) => ({
    segment_id: segment.segmentId,
    started_at: offsetInstant(meetingStartedAt, segment.startedAtMs),
    ended_at: offsetInstant(meetingStartedAt, segment.endedAtMs),
    text: segment.text,
    speaker: toArtifactSpeaker(segment, names),
    attribution_confidence: attributionConfidence(segment),
    provenance: {
      stage: segment.provenance.wording === "reconciled" ? "final_batch" : "live_stream",
      model: segment.provenance.wording === "reconciled" ? provenance.finalBatchModel : provenance.liveStreamModel,
    },
  }));
}

function toArtifactSpeaker(segment: ReconciledSegment, names: ReadonlyMap<string, string>) {
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

function attributionConfidence(segment: ReconciledSegment): number {
  const duration = segment.endedAtMs - segment.startedAtMs;
  if (duration <= 0 || segment.speaker.kind !== "named") return 0;
  return Math.min(1, Object.values(segment.provenance.uiExactMs).reduce((total, value) => total + value, 0) / duration);
}

function offsetInstant(origin: string, offsetMs: number): string {
  const timestamp = Date.parse(origin) + offsetMs;
  if (!Number.isFinite(timestamp)) throw new Error("meeting start or transcript offset is invalid");
  return new Date(timestamp).toISOString().replace(".000Z", "Z");
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

function canonicalTranscriptInput(transcript: TeamMemMeetingArtifact["transcript"]): string {
  return JSON.stringify(transcript.map((segment) => ({ segment_id: segment.segment_id, text: segment.text, speaker: segment.speaker })));
}

function evidenceSchema(): Record<string, unknown> {
  return { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 } };
}

function evidenceItemSchema(field: "name" | "text"): Record<string, unknown> {
  return {
    type: "object", additionalProperties: false,
    required: [field, "evidence_segment_ids"],
    properties: { [field]: { type: "string", minLength: 1, maxLength: field === "name" ? 200 : 20_000 }, evidence_segment_ids: evidenceSchema() },
  };
}

function explicitOwnerSchema(): Record<string, unknown> {
  return {
    type: "object", additionalProperties: false,
    required: ["person_id", "display_name", "explicitly_stated"],
    properties: { person_id: { type: "string", minLength: 1, maxLength: 200 }, display_name: { type: "string", minLength: 1, maxLength: 200 }, explicitly_stated: { const: true } },
  };
}

function explicitDueDateSchema(): Record<string, unknown> {
  return {
    type: "object", additionalProperties: false,
    required: ["date", "explicitly_stated"],
    properties: { date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, explicitly_stated: { const: true } },
  };
}
