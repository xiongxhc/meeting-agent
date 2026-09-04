import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  canonicalArtifactHash,
  parseTeamMemMeetingArtifact,
} from "../src/contracts/teammem-meeting-v1.ts";
import {
  type ArtifactBuildInput,
  buildTeamMemMeetingArtifact,
  createArtifactRevisionGuard,
} from "../src/delivery/artifact-builder.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import type { OccurrenceId } from "../src/domain/occurrence-id.ts";
import { shortOccurrenceId } from "../src/domain/occurrence-id.ts";
import type { AttendanceInterval } from "../src/domain/participants.ts";
import type { ReconciledTranscript } from "../src/domain/transcript.ts";
import type { ConversationRuntimePort, ProcessTextRequest } from "../src/ports/conversation-runtime.ts";

const FIXTURES = new URL("../fixtures/contracts/", import.meta.url);

function fixture(name: "minimal" | "complete"): unknown {
  return JSON.parse(readFileSync(new URL(`teammem-meeting-v1.${name}.json`, FIXTURES), "utf8"));
}

function digest(name: "minimal" | "complete"): string {
  return createHash("sha256").update(readFileSync(new URL(`teammem-meeting-v1.${name}.json`, FIXTURES))).digest("hex");
}

const identity = buildMeetingIdentity({
  providerMeetingId: "vc:synthetic/artifact",
  meetingNo: "synthetic-meeting",
  occurrenceStartedAt: "2026-09-02T14:00:00Z",
  title: "Artifact Contract Test",
  organizer: { feishuUserId: "ou_ada", displayName: "Ada Synthetic", source: "reservation" },
});

const attendance: readonly AttendanceInterval[] = [
  { feishuUserId: "ou_ada", displayName: "Ada Synthetic", joinedAt: "2026-09-02T14:00:00Z", leftAt: "2026-09-02T14:10:00Z" },
  { feishuUserId: "ou_silent", displayName: "Silent Synthetic", joinedAt: "2026-09-02T14:00:10Z", leftAt: null },
];

const reconciled: ReconciledTranscript = {
  transcriptComplete: true,
  warnings: [],
  evidence: [],
  silentAttendees: ["ou_silent"],
  spokeButUnattributed: [],
  segments: [
    {
      segmentId: "seg_001",
      startedAtMs: 5_000,
      endedAtMs: 15_000,
      text: "Atlas is ready and Ada owns the release note.",
      speaker: { kind: "named", feishuUserId: "ou_ada" },
      cluster: "cluster_1",
      provenance: { wording: "reconciled", liveSegmentIds: ["live_001"], reason: "ui_aligned", uiExactMs: { ou_ada: 10_000 }, ambiguousMs: 0, unobservedMs: 0 },
    },
    {
      segmentId: "seg_002",
      startedAtMs: 16_000,
      endedAtMs: 20_000,
      text: "An anonymous question followed.",
      speaker: { kind: "anonymous", label: "speaker_01" },
      cluster: "cluster_2",
      provenance: { wording: "live", liveSegmentIds: ["live_002"], reason: "no_signal", uiExactMs: {}, ambiguousMs: 0, unobservedMs: 4_000 },
    },
  ],
};

const synthesis = {
  summary: "Atlas readiness and its release note were discussed.",
  projects: [{ name: "project-atlas", evidence_segment_ids: ["seg_001"] }],
  decisions: [{ text: "Atlas is ready.", evidence_segment_ids: ["seg_001"] }],
  action_items: [{ text: "Write the release note.", owner: { person_id: "ou_ada", display_name: "Ada Synthetic", explicitly_stated: true }, due_date: null, evidence_segment_ids: ["seg_001"] }],
  discussion_points: [{ text: "Release readiness.", evidence_segment_ids: ["seg_001"] }],
  person_summaries: [{ person_id: "ou_ada", display_name: "Ada Synthetic", text: "Confirmed Atlas readiness." }],
};

function runtimeReturning(output: unknown): { readonly runtime: Pick<ConversationRuntimePort, "processText">; readonly calls: ProcessTextRequest[] } {
  const calls: ProcessTextRequest[] = [];
  return {
    calls,
    runtime: {
      async processText(request) {
        calls.push(request);
        return { output, warnings: [] };
      },
    },
  };
}

function buildInput(runtime: Pick<ConversationRuntimePort, "processText">, revision = 1): ArtifactBuildInput {
  return {
    identity,
    provider: "feishu",
    revision,
    endedAt: "2026-09-02T14:10:00Z",
    attendance,
    transcript: reconciled,
    runtime,
    sessionId: 42n,
    meetingEnded: true,
    recordingGaps: [{ startedAt: "2026-09-02T14:00:30Z", endedAt: "2026-09-02T14:00:35Z", reason: "synthetic_gap" }],
    processingWarnings: [{ code: "synthetic_warning", detail: "Synthetic test warning." }],
    provenance: { runtimeProfile: "online", sttProvider: "synthetic-stt", sttModel: "synthetic-stt-v1", textProvider: "synthetic-text", textModel: "synthetic-text-v1", agentVersion: "meeting-agent/test", processedAt: "2026-09-02T14:11:00Z", finalBatchModel: "synthetic-diarize-v1", liveStreamModel: "synthetic-stream-v1" },
    audio: { format: "opus", encryption: "age-x25519", durationSeconds: 600, bytes: 512, sha256: `sha256:${"a".repeat(64)}`, expiresAt: "2026-09-16T14:10:00Z" },
  };
}

test("canonical fixtures validate byte-for-byte and preserve cross-language short occurrence ids", () => {
  assert.equal(digest("minimal"), "3ae8e2fb6a65a32586b8baf06d743c2f8b935ef0a8d9f72cf5de7c3fa507d06a");
  assert.equal(digest("complete"), "78446a650a5d230595b30718ccb5bee44e498080fb2e4e1b689d358756bf43a3");
  const minimal = parseTeamMemMeetingArtifact(fixture("minimal"));
  const complete = parseTeamMemMeetingArtifact(fixture("complete"));
  assert.equal(shortOccurrenceId(minimal.occurrence_id as OccurrenceId), "3a16a8e2");
  assert.equal(shortOccurrenceId(complete.occurrence_id as OccurrenceId), "02ef68db");
  assert.equal(canonicalArtifactHash(minimal), canonicalArtifactHash(JSON.parse(JSON.stringify(minimal))));
});

test("strict artifact parsing rejects unknown fields and invalid cross-field speaker, evidence, timing, attendance, and organizer claims", () => {
  const artifact = fixture("minimal") as Record<string, unknown>;
  assert.throws(() => parseTeamMemMeetingArtifact({ ...artifact, unexpected: true }), /unknown|unrecognized|unexpected/i);
  assert.throws(() => parseTeamMemMeetingArtifact({ ...artifact, provider_meeting_id: "different" }), /provider_meeting_id/i);
  assert.throws(() => parseTeamMemMeetingArtifact({ ...artifact, started_at: "2026-09-02T09:15:01Z" }), /started_at/i);
  const badSpeaker = structuredClone(artifact) as { transcript: Array<{ speaker: Record<string, unknown> }> };
  badSpeaker.transcript[0]!.speaker.reconciled = false;
  assert.throws(() => parseTeamMemMeetingArtifact(badSpeaker), /reconciled/i);
  const badEvidence = structuredClone(artifact) as { decisions: unknown[] };
  badEvidence.decisions = [{ text: "unsupported", evidence_segment_ids: ["missing"] }];
  assert.throws(() => parseTeamMemMeetingArtifact(badEvidence), /evidence_segment_ids/i);
  const badAttendance = structuredClone(artifact) as { participants: Array<{ attendance: Array<{ joined_at: string; left_at: string | null }> }> };
  badAttendance.participants[0]!.attendance[0]!.left_at = null;
  badAttendance.participants[0]!.attendance.push({ joined_at: "2026-09-02T09:21:00Z", left_at: "2026-09-02T09:22:00Z" });
  assert.throws(() => parseTeamMemMeetingArtifact(badAttendance), /attendance/i);
});

test("builder calls post-meeting text processing with strict JSON Schema, validates its result, and preserves only observed joiners", async () => {
  const { runtime, calls } = runtimeReturning(synthesis);
  const built = await buildTeamMemMeetingArtifact(buildInput(runtime));
  assert.equal(calls.length, 1);
  const request = calls[0]!;
  assert.equal(request.sessionId, 42n);
  assert.equal(request.outputSchema.type, "object");
  assert.equal(request.outputSchema.additionalProperties, false);
  assert.match(JSON.stringify(request.outputSchema), /evidence_segment_ids/);
  assert.deepEqual(built.artifact.participants.map((participant) => participant.person_id), ["ou_ada", "ou_silent"]);
  assert.equal(built.artifact.person_summaries.length, 1);
  assert.equal(built.artifact.person_summaries[0]!.person_id, "ou_ada");
  assert.deepEqual(built.artifact.transcript.map((segment) => segment.speaker.kind), ["person", "anonymous"]);
  assert.deepEqual(built.artifact.recording_gaps, [{ started_at: "2026-09-02T14:00:30Z", ended_at: "2026-09-02T14:00:35Z", reason: "synthetic_gap" }]);
  assert.equal(built.artifact.provenance.runtime_profile, "online");
  assert.equal(built.artifact.audio.filename, "audio.enc");
  assert.equal(built.artifact_hash, canonicalArtifactHash(built.artifact));
});

test("builder fails closed before processText until the voice meeting ended and rejects unsupported text output", async () => {
  const live = runtimeReturning(synthesis);
  await assert.rejects(buildTeamMemMeetingArtifact({ ...buildInput(live.runtime), meetingEnded: false }), /ended/i);
  assert.equal(live.calls.length, 0);
  const invalid = runtimeReturning({ ...synthesis, unexpected: true });
  await assert.rejects(buildTeamMemMeetingArtifact(buildInput(invalid.runtime)), /unknown|unrecognized|unexpected/i);
});

test("builder rejects inferred project evidence, inferred owners and dates, and summaries for silent attendees", async () => {
  for (const invalid of [
    { ...synthesis, projects: [{ name: "project-atlas", evidence_segment_ids: [] }] },
    { ...synthesis, action_items: [{ ...synthesis.action_items[0]!, owner: { person_id: "ou_ada", display_name: "Ada Synthetic", explicitly_stated: false } }] },
    { ...synthesis, action_items: [{ ...synthesis.action_items[0]!, due_date: { date: "2026-09-03", explicitly_stated: false } }] },
    { ...synthesis, person_summaries: [{ person_id: "ou_silent", display_name: "Silent Synthetic", text: "Guessed summary." }] },
  ]) {
    await assert.rejects(buildTeamMemMeetingArtifact(buildInput(runtimeReturning(invalid).runtime)), /evidence|explicitly_stated|person_summaries/i);
  }
});

test("revision guard makes same revision byte-stable, rejects conflict and lower revision, and accepts a higher changed revision", async () => {
  const guard = createArtifactRevisionGuard();
  const first = await buildTeamMemMeetingArtifact({ ...buildInput(runtimeReturning(synthesis).runtime), revisionGuard: guard });
  const replay = await buildTeamMemMeetingArtifact({ ...buildInput(runtimeReturning(synthesis).runtime), revisionGuard: guard });
  assert.equal(first.serialized, replay.serialized);
  assert.equal(first.artifact_hash, replay.artifact_hash);
  const changed = { ...synthesis, summary: "A materially changed summary." };
  await assert.rejects(buildTeamMemMeetingArtifact({ ...buildInput(runtimeReturning(changed).runtime), revisionGuard: guard }), /immutable|conflict/i);
  await assert.rejects(buildTeamMemMeetingArtifact({ ...buildInput(runtimeReturning(changed).runtime, 0), revisionGuard: guard }), /revision/i);
  const higher = await buildTeamMemMeetingArtifact({ ...buildInput(runtimeReturning(changed).runtime, 2), revisionGuard: guard });
  assert.notEqual(higher.artifact_hash, first.artifact_hash);
});
