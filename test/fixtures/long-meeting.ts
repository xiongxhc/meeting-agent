// A synthetic timed meeting of any length, for the windowed synthesis tests
// (test/artifact-builder-windows.test.ts and the gateway-level
// e2e/long-meeting-gateway.test.ts).
import type { TimedArtifactBuildInput } from "../../src/delivery/artifact-builder.ts";
import { createOwnedTimedSampleEvidence } from "../../src/domain/attribution-evidence.ts";
import { buildMeetingIdentity } from "../../src/domain/meeting.ts";
import type { TimedReconciledSegment, TimedReconciledTranscript } from "../../src/domain/transcript.ts";

const RATE = 24_000;
const START_MS = Date.parse("2026-09-02T14:00:00Z");
export const PEOPLE = [{ id: "ou_ada", name: "Ada Synthetic" }, { id: "ou_ben", name: "Ben Synthetic" }] as const;
const PHRASES = [
  "we went through the release checklist for the payments service and agreed the rollback plan needs one more review",
  "the dashboard numbers from last week look stable but the latency spike on Tuesday still has no clear owner",
  "marketing wants the launch note two days earlier so the translation team can finish the Arabic version in time",
  "the vendor contract renewal is blocked on the security questionnaire, which legal expects to return on Friday",
  "we should split the onboarding work so the mobile changes ship separately from the backend migration",
];

const wallComponents = { maximumBracketNs: 1n, maximumResolutionNs: 1n, modelAllowanceNs: 1n, interpolationRoundingNs: 1n,
  captureRoundingNs: 1n, captureUncertaintyNs: null, externalUtcAccuracyNs: null };

function instant(ms: number): string {
  return `${new Date(START_MS + ms).toISOString().slice(0, 19)}.${String(ms % 1000).padStart(3, "0")}000Z`;
}

function timedSegment(segmentId: string, text: string, wording: "live" | "reconciled", startMs: number, endMs: number,
  speaker: number | null): TimedReconciledSegment {
  const startSample = BigInt(startMs * (RATE / 1000)), endSample = BigInt(endMs * (RATE / 1000)), possible = endSample - startSample;
  const person = speaker === null ? null : PEOPLE[speaker]!.id;
  return {
    segmentId, text, wording, liveSegmentIds: wording === "live" ? [segmentId] : [], cluster: null,
    range: { startSampleInclusive: startSample, endSampleExclusive: endSample, sampleRateHz: RATE, gapOffsetMs: 0n },
    speaker: person === null ? { kind: "anonymous", label: "speaker_01" } : { kind: "named", feishuUserId: person },
    sampleEvidence: createOwnedTimedSampleEvidence(person === null
      ? { sampleRateHz: RATE, possibleSamples: possible, candidateLower: [], observedUpper: [], ambiguousUpper: 0n, unobservedUpper: possible, freshCandidates: [] }
      : { sampleRateHz: RATE, possibleSamples: possible, candidateLower: [[person, possible]], observedUpper: [[person, possible]],
          ambiguousUpper: 0n, unobservedUpper: 0n, freshCandidates: [person] }),
    wall: { startedAt: instant(startMs), endedAt: instant(endMs), components: wallComponents, mappingRoundingNs: 1n, serializationRoundingNs: 1n },
  };
}

/** One utterance every eight seconds: a final-batch entry and the overlapping
 * live entry that observed the same speech, as the v2 transcript stores them. */
export function meeting(minutes: number, options: { readonly textBytes?: number; readonly utteranceMs?: number } = {}) {
  const step = options.utteranceMs ?? 8_000, segments: TimedReconciledSegment[] = [];
  for (let index = 0, at = 0; at + step <= minutes * 60_000; index += 1, at += step) {
    const base = `${PHRASES[index % PHRASES.length]!} (point ${index})`;
    const words = options.textBytes === undefined ? base : base.padEnd(options.textBytes, " and more detail");
    const speaker = index % 3 === 2 ? null : index % 3;
    segments.push(timedSegment(`final-${index}`, `${words}.`, "reconciled", at + 200, at + step - 300, speaker));
    segments.push(timedSegment(`live-${index}`, `${words} uh.`, "live", at, at + step - 100, speaker));
  }
  return segments;
}

export function buildInput(segments: readonly TimedReconciledSegment[], runtime: TimedArtifactBuildInput["runtime"],
  overrides: Partial<TimedArtifactBuildInput> = {}): TimedArtifactBuildInput {
  const lastEnd = Math.max(60_000, ...segments.map((segment) => Date.parse(segment.wall!.endedAt) - START_MS));
  const endedAt = new Date(START_MS + Math.ceil(lastEnd / 1000) * 1000).toISOString().replace(".000Z", "Z");
  const source = { sourceSessionId: 41n, recordingHandle: "a".repeat(32), sha256: "b".repeat(64) };
  const identity = buildMeetingIdentity({ providerMeetingId: "synthetic-long", meetingNo: "synthetic-long", occurrenceStartedAt: "2026-09-02T14:00:00Z",
    title: "Long synthetic meeting", organizer: null });
  const transcript: TimedReconciledTranscript = { kind: "timed_recording_transcript/v1", source, segments, transcriptComplete: true,
    warnings: [{ code: "local_wall_timestamp_estimate", detail: "Synthetic local-wall estimate; physical accuracy unknown." }],
    provenance: { occurrenceId: identity.occurrenceId, bridgeSessionId: "bridge", generationId: "generation", alignmentAttemptId: "attempt",
      timingContract: "capture-clock/v1", policyId: "local-wall-estimate/v1" } };
  return {
    identity, provider: "feishu", revision: 1, endedAt, transcript, sessionId: 99n, meetingEnded: true, recordingGaps: [], processingWarnings: [],
    selectedAlignment: { generationId: "generation", attemptId: "attempt", source, timingContract: "capture-clock/v1", policyId: "local-wall-estimate/v1",
      coverageStatus: "available", pageCount: 1, entryCount: segments.length, storedBytes: 100, warnings: [] },
    attendance: PEOPLE.map((person) => ({ feishuUserId: person.id, displayName: person.name, joinedAt: "2026-09-02T14:00:00Z", leftAt: endedAt })),
    runtime,
    provenance: { runtimeProfile: "online", sttProvider: "synthetic", sttModel: "synthetic", textProvider: "synthetic", textModel: "synthetic",
      agentVersion: "test", processedAt: endedAt, finalBatchModel: "synthetic-final", liveStreamModel: "synthetic-live" },
    audio: { format: "opus", encryption: "age-x25519", durationSeconds: 60, bytes: 10, sha256: `sha256:${"b".repeat(64)}`, expiresAt: "2026-09-16T14:10:00Z" },
    ...overrides,
  };
}
