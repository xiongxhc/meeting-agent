// The frozen TeamMem meeting artifact boundary. This module accepts only the
// exact v1 shape: lenience here would turn an unsupported producer claim into
// durable team memory.

import { createHash } from "node:crypto";
import { z } from "zod";

import { makeOccurrenceId } from "../domain/occurrence-id.ts";

export const TEAMMEM_MEETING_V1_SCHEMA = "teammem-meeting/v1";

const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const WHOLE_SECOND_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const TOKEN = /^[a-z][a-z0-9_-]*$/;

const boundedText = (maximum: number) => z.string().max(maximum).refine((value) => value.trim().length > 0, "must not be blank");
const instant = z.string().refine(isInstant, "must be a real UTC instant with literal Z");
const wholeSecondInstant = z.string().refine((value) => WHOLE_SECOND_UTC_INSTANT.test(value) && isInstant(value), "must be a whole-second UTC instant");
const evidenceIds = z.array(boundedText(200)).min(1).max(100).superRefine((ids, context) => {
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "evidence_segment_ids must not repeat an id" });
});

const attendanceInterval = z.object({
  joined_at: instant,
  left_at: instant.nullable(),
}).strict();

const participant = z.object({
  person_id: boundedText(200),
  display_name: boundedText(200),
  attendance: z.array(attendanceInterval).min(1).max(100),
}).strict();

const speaker = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person"), person_id: boundedText(200), display_name: boundedText(200), reconciled: z.literal(true) }).strict(),
  z.object({ kind: z.literal("anonymous"), cluster_id: boundedText(200) }).strict(),
  z.object({ kind: z.literal("ambiguous") }).strict(),
]);

const transcriptSegment = z.object({
  segment_id: boundedText(200),
  started_at: instant,
  ended_at: instant,
  text: boundedText(20_000),
  speaker,
  attribution_confidence: z.number().min(0).max(1),
  provenance: z.object({ stage: z.enum(["live_stream", "final_batch"]), model: boundedText(200) }).strict(),
}).strict();

const evidenceText = z.object({ text: boundedText(20_000), evidence_segment_ids: evidenceIds }).strict();
const project = z.object({ name: boundedText(200), evidence_segment_ids: evidenceIds }).strict();
const actionItem = z.object({
  text: boundedText(20_000),
  owner: z.object({ person_id: boundedText(200), display_name: boundedText(200), explicitly_stated: z.literal(true) }).strict().nullable(),
  due_date: z.object({ date: z.string().refine(isDate, "must be a real YYYY-MM-DD date"), explicitly_stated: z.literal(true) }).strict().nullable(),
  evidence_segment_ids: evidenceIds,
}).strict();
const personSummary = z.object({ person_id: boundedText(200), display_name: boundedText(200), text: boundedText(20_000) }).strict();
const recordingGap = z.object({ started_at: instant, ended_at: instant, reason: boundedText(500) }).strict();
const processingWarning = z.object({ code: z.string().regex(TOKEN), detail: z.string().max(500) }).strict();

const meetingArtifactBase = z.object({
  schema: z.literal(TEAMMEM_MEETING_V1_SCHEMA),
  occurrence_id: z.string().max(400),
  revision: z.number().int().min(1).max(1_000_000),
  provider: z.string().regex(TOKEN),
  provider_meeting_id: boundedText(400),
  title: boundedText(200),
  started_at: wholeSecondInstant,
  ended_at: instant,
  organizer: z.object({ person_id: boundedText(200), display_name: boundedText(200) }).strict().nullable(),
  organizer_source: z.enum(["reservation", "calendar_event"]).nullable(),
  organizer_unresolved_reason: z.literal("instant_meeting").nullable(),
  transcript_complete: z.boolean(),
  summary: boundedText(20_000),
  participants: z.array(participant).min(1).max(500),
  transcript: z.array(transcriptSegment).max(50_000),
  projects: z.array(project).max(500),
  decisions: z.array(evidenceText).max(500),
  action_items: z.array(actionItem).max(500),
  discussion_points: z.array(evidenceText).max(500),
  person_summaries: z.array(personSummary).max(500),
  recording_gaps: z.array(recordingGap).max(500),
  processing_warnings: z.array(processingWarning).max(500),
  provenance: z.object({
    runtime_profile: z.enum(["offline", "online"]),
    stt_provider: boundedText(200),
    stt_model: boundedText(200),
    text_provider: boundedText(200),
    text_model: boundedText(200),
    agent_version: boundedText(200),
    processed_at: instant,
  }).strict(),
  audio: z.object({
    filename: z.literal("audio.enc"),
    format: boundedText(100),
    encryption: boundedText(100),
    duration_seconds: z.number().positive().max(86_400),
    bytes: z.number().int().positive().max(8 * 1024 * 1024 * 1024),
    sha256: z.string().regex(SHA256),
    expires_at: instant,
  }).strict(),
}).strict();

export type TeamMemMeetingArtifact = z.infer<typeof meetingArtifactBase>;

/** Parse the exact frozen wire format, including all relationships that a
 * structural JSON schema cannot describe. Throws with field-only failures;
 * never include transcript text in an error. */
export function parseTeamMemMeetingArtifact(value: unknown): TeamMemMeetingArtifact {
  const artifact = meetingArtifactBase.parse(value);
  validateRelationships(artifact);
  return artifact;
}

/** TeamMem's canonical JSON hash: sorted object keys, compact separators,
 * UTF-8, and no formatting dependence. */
export function canonicalArtifactHash(value: TeamMemMeetingArtifact): string {
  const canonical = JSON.stringify(sortJson(value));
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function canonicalArtifactJson(value: TeamMemMeetingArtifact): string {
  return JSON.stringify(sortJson(value));
}

function validateRelationships(artifact: TeamMemMeetingArtifact): void {
  const occurrence = parseOccurrence(artifact.occurrence_id);
  issue(occurrence.meetingId === artifact.provider_meeting_id, "provider_meeting_id must equal occurrence_id meeting id");
  issue(occurrence.startedAt === artifact.started_at, "started_at must equal occurrence_id start");
  issue(compareInstants(artifact.ended_at, artifact.started_at) >= 0, "ended_at must not precede started_at");

  const organizerIsNull = artifact.organizer === null;
  issue(organizerIsNull === (artifact.organizer_source === null), "organizer_source must be null exactly when organizer is null");
  issue(organizerIsNull === (artifact.organizer_unresolved_reason === "instant_meeting"), "organizer_unresolved_reason must be instant_meeting exactly when organizer is null");

  const participants = new Map<string, string>();
  for (const entry of artifact.participants) {
    issue(!participants.has(entry.person_id), "participants person_id must be unique");
    participants.set(entry.person_id, entry.display_name);
    let previousEnd: string | null = null;
    for (const [index, interval] of entry.attendance.entries()) {
      issue(compareInstants(interval.joined_at, artifact.ended_at) <= 0, "attendance joined_at must not follow ended_at");
      if (interval.left_at !== null) {
        issue(compareInstants(interval.left_at, interval.joined_at) >= 0, "attendance left_at must not precede joined_at");
        issue(compareInstants(interval.left_at, artifact.ended_at) <= 0, "attendance left_at must not follow ended_at");
      } else {
        issue(index === entry.attendance.length - 1, "attendance null left_at must be last");
      }
      if (previousEnd !== null) issue(compareInstants(interval.joined_at, previousEnd) >= 0, "attendance must be ordered and disjoint");
      previousEnd = interval.left_at;
    }
  }

  const segmentIds = new Set<string>();
  let previousTranscriptEnd: string | null = null;
  const namedSpeakers = new Set<string>();
  for (const segment of artifact.transcript) {
    issue(!segmentIds.has(segment.segment_id), "transcript segment_id must be unique");
    segmentIds.add(segment.segment_id);
    issue(compareInstants(segment.ended_at, segment.started_at) >= 0, "transcript ended_at must not precede started_at");
    issue(compareInstants(segment.started_at, artifact.started_at) >= 0 && compareInstants(segment.ended_at, artifact.ended_at) <= 0, "transcript timing must be inside meeting window");
    if (previousTranscriptEnd !== null) issue(compareInstants(segment.started_at, previousTranscriptEnd) >= 0, "transcript must be ordered and non-overlapping");
    previousTranscriptEnd = segment.ended_at;
    if (segment.speaker.kind === "person") {
      issue(participants.get(segment.speaker.person_id) === segment.speaker.display_name, "person speaker must be a reconciled actual participant with matching display_name");
      namedSpeakers.add(segment.speaker.person_id);
    }
  }

  const projectNames = new Set<string>();
  for (const item of artifact.projects) {
    issue(!projectNames.has(item.name), "project names must be unique");
    projectNames.add(item.name);
    validateEvidence(item.evidence_segment_ids, segmentIds);
  }
  for (const item of artifact.decisions) validateEvidence(item.evidence_segment_ids, segmentIds);
  for (const item of artifact.discussion_points) validateEvidence(item.evidence_segment_ids, segmentIds);
  for (const item of artifact.action_items) validateEvidence(item.evidence_segment_ids, segmentIds);

  const summarized = new Set<string>();
  for (const summary of artifact.person_summaries) {
    issue(!summarized.has(summary.person_id), "person_summaries person_id must be unique");
    summarized.add(summary.person_id);
    issue(participants.get(summary.person_id) === summary.display_name && namedSpeakers.has(summary.person_id), "person_summaries require an actual participant with a named transcript segment");
  }

  let previousGapEnd: string | null = null;
  for (const gap of artifact.recording_gaps) {
    issue(compareInstants(gap.ended_at, gap.started_at) >= 0, "recording_gaps ended_at must not precede started_at");
    issue(compareInstants(gap.started_at, artifact.started_at) >= 0 && compareInstants(gap.ended_at, artifact.ended_at) <= 0, "recording_gaps must be inside meeting window");
    if (previousGapEnd !== null) issue(compareInstants(gap.started_at, previousGapEnd) >= 0, "recording_gaps must be ordered and disjoint");
    previousGapEnd = gap.ended_at;
  }
}

function validateEvidence(ids: readonly string[], segments: ReadonlySet<string>): void {
  for (const id of ids) issue(segments.has(id), "evidence_segment_ids must refer to stored transcript segments");
}

function parseOccurrence(value: string): { readonly meetingId: string; readonly startedAt: string } {
  const split = value.lastIndexOf("@");
  issue(split > 0, "occurrence_id must contain meeting id and start");
  const meetingId = value.slice(0, split);
  const startedAt = value.slice(split + 1);
  issue(WHOLE_SECOND_UTC_INSTANT.test(startedAt), "occurrence_id must contain a whole-second UTC start");
  try {
    makeOccurrenceId(meetingId, startedAt);
  } catch {
    throw new Error("occurrence_id is invalid");
  }
  return { meetingId, startedAt };
}

function isInstant(value: string): boolean {
  if (!UTC_INSTANT.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().startsWith(value.includes(".") ? value.slice(0, value.indexOf(".") + 4) : value.replace("Z", ".000Z").slice(0, 23));
}

function isDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function compareInstants(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

function issue(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortJson(entry)]));
  }
  return value;
}
