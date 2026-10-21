// Post-meeting processing through the real SQLite store and outbox: the profile
// an artifact claims is the one its synthesis ran in, and project names the
// model proposes are resolved against the published project list before they
// reach TeamMem.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { RecordingAlignmentEntry, RecordingAlignmentPage } from "@conversation/runtime";

import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { createBackfillWorker, type BackfillGatewayTransport, type BackfillPollResult } from "../src/delivery/backfill-worker.ts";
import { createOutboxWorker } from "../src/delivery/outbox-worker.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import type { TeamMemMeetingArtifactV2 } from "../src/contracts/teammem-meeting-v2.ts";
import { createCoordinator } from "../src/sessions/coordinator.ts";
import { ALIGNMENT_POLICY } from "../src/sessions/recording-alignment.ts";
import { testCapability } from "./lib/runtime-sdk.ts";

type Profile = "offline" | "online";

async function runInitialBuild(input: {
  readonly seedProfile: Profile;
  readonly runtimeProfile: Profile;
  readonly projects?: readonly { readonly name: string; readonly evidence_segment_ids: readonly string[] }[];
  readonly knownProjects?: readonly string[] | null;
}): Promise<{ readonly result: BackfillPollResult; readonly artifact: TeamMemMeetingArtifactV2 | null; readonly processTextCalls: number; readonly transportsClosed: number }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-backfill-postmeeting-"));
  const recordingsDir = path.join(dir, "recordings"), outboxDir = path.join(dir, "outbox"), receiptsDir = path.join(dir, "receipts");
  mkdirSync(recordingsDir); mkdirSync(outboxDir); mkdirSync(receiptsDir);
  const recordingPath = path.join(recordingsDir, `${testCapability.recordingHandle}.crsr`);
  const bytes = Buffer.from("synthetic-encrypted-recording");
  writeFileSync(recordingPath, bytes);
  const capability = { ...testCapability, sha256: createHash("sha256").update(bytes).digest("hex") };
  const endedAt = "2026-09-02T14:10:00.123Z", endedAtMs = Date.parse(endedAt);
  const wall = endedAtMs + 1;
  let processTextCalls = 0, transportsClosed = 0;
  const store = openSessionStore({ filename: path.join(dir, "state.db"), nowMs: endedAtMs });
  try {
    const identity = buildMeetingIdentity({ providerMeetingId: "profile-meeting", meetingNo: "424242",
      occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "Profile meeting",
      organizer: { feishuUserId: "owner", displayName: "Owner", source: "reservation" } });
    const coordinator = createCoordinator({ store, clock: { now: () => wall }, bridgeLeaseTtlMs: 30_000, maxConcurrentSessions: 1 });
    coordinator.discover(identity); coordinator.advance(identity.occurrenceId, "joining"); coordinator.advance(identity.occurrenceId, "listening");
    const binding = { occurrenceId: identity.occurrenceId, bridgeSessionId: "bridge", runtimeSessionId: 41n };
    store.beginReconciliationGeneration(identity.occurrenceId, "bridge", endedAtMs - 1_000);
    store.setReconciliationRuntimeSession(identity.occurrenceId, "bridge", 41n);
    const timed = store.beginTimedEvidence(binding, endedAtMs - 1_000);
    store.appendTimedUi(timed, { schema: "bridge-session/v2", sessionId: "bridge", sequence: 1, observedAt: "2026-09-02T14:00:00Z",
      type: "participant_joined", feishuUserId: "owner", displayName: "Owner", observationTiming: null,
      observationTimingReason: "timing_unavailable" }, endedAtMs - 999);
    store.closeTimedEvidence(timed, endedAtMs);
    coordinator.finalizeWithRecording(identity.occurrenceId, { kind: "advance", toState: "finalizing" }, {
      recovery: { bridgeSessionId: "bridge", capability }, handle: capability.recordingHandle, encryptedPath: recordingPath,
      sha256: capability.sha256, durationMs: 20, format: "pcm_s16le/24000/1/20ms", keyId: capability.keyId,
      gaps: [], runtimeGaps: [],
    }, "bridge", endedAtMs, "bridge_observed", { terminalReason: "ended", terminalSource: "bridge_observed", endedAt,
      identity, provider: "feishu", encryption: "aes-256-gcm", processingWarnings: [], provenance: {
        runtimeProfile: input.seedProfile, sttProvider: "stt", sttModel: "stt-v1", liveStreamModel: "live-v1",
        finalBatchModel: "final-v1", textProvider: "text", textModel: "text-v1", agentVersion: "test" } });
    const recovery = store.getRecordingRecovery(identity.occurrenceId, "bridge", capability.recordingHandle)!;
    const source = { sourceSessionId: 41n, recordingHandle: capability.recordingHandle, sha256: capability.sha256 };
    const epoch = { bridgeSessionId: "bridge", clockDomainId: "clock", captureEpoch: 1n };
    const frame: Extract<RecordingAlignmentEntry, { kind: "frame" }> = { kind: "frame", mediaStartSample: 0n,
      mediaEndSample: 480n, sampleRateHz: 24_000, gapOffsetMs: 0n, epoch, captureStatus: "available", reasons: [],
      provenance: { captureEpoch: 1n, sequence: 1n, outputStartSample: 0n, sampleCount: 480,
        sourceStartNumerator: 0n, sourceEndNumerator: 11_520_000n, sourceDenominator: 24_000, sourceRateHz: 24_000,
        quality: "nominal_frame_endpoint_interpolation", span: { hostStartNs: 1_000_000_000n,
          hostEndNs: 1_020_000_000n, roundingEnvelopeNs: 1n, captureUncertaintyNs: null } },
      wall: { quality: "local_wall_estimate", policyId: "local-wall-estimate/v1",
        localStartNs: BigInt(Date.parse("2026-09-02T14:00:00Z")) * 1_000_000n,
        localEndNs: BigInt(Date.parse("2026-09-02T14:00:00.020Z")) * 1_000_000n,
        wallEpoch: 1n, wallRun: 1n, maximumBracketNs: 1n, maximumResolutionNs: 1n, modelAllowanceNs: 10_000_000n,
        interpolationRoundingNs: 1n, captureRoundingNs: 1n, captureUncertaintyNs: null,
        externalUtcAccuracyNs: null, overallPhysicalAccuracyNs: null } };
    const alignment = store.beginRecordingAlignment(recovery.generationId, "fixture");
    if (alignment.kind !== "claimed") throw new Error("fixture alignment already selected");
    const page: RecordingAlignmentPage = { type: "recording_alignment_page", source, pageIndex: 0n,
      policy: ALIGNMENT_POLICY, entries: [{ kind: "epoch", epoch }, frame] };
    store.appendRecordingAlignment(alignment.attempt, page);
    store.completeRecordingAlignment(alignment.attempt, { type: "recording_alignment_complete", source, pageCount: 1n,
      coverageStatus: "available", warnings: ["local_wall_timestamp_estimate"], traversalSucceeded: true });

    const outbox = createOutboxWorker({ recordingsDir, outboxDir, receiptsDir, journal: store, clock: { now: () => wall },
      random: () => 0, session: { state: (occurrenceId) => store.getSession(occurrenceId)?.state ?? null,
        publish: () => assert.fail("atomic store owns publication") }, reconciliationEvidence: store });
    const worker = createBackfillWorker({ store, outbox, gatewayPath: "/synthetic/gateway", configPath: "/synthetic/config.json",
      env: { PATH: "/usr/bin:/bin" }, operationBudgetMs: 1_000,
      cleanupTimeouts: { eofGraceMs: 1, termGraceMs: 1, killGraceMs: 1 },
      clock: { now: () => wall, monotonicNow: () => 1 }, random: () => 0,
      readKnownProjects: () => input.knownProjects === undefined ? [] : input.knownProjects,
      startTransport: async () => ({ cleanupOutcome: { status: "graceful" as const },
        messages: { async *[Symbol.asyncIterator]() { /* injected adapter does not consume transport */ } },
        async send() {}, async close() { transportsClosed++; } }) as BackfillGatewayTransport,
      connectRuntime: async () => ({ currentSessionId: 99n, runtimeProfile: input.runtimeProfile,
        readRecordingAlignment() { throw new Error("selected alignment must replay without a new Runtime read"); },
        async reconcileFinalizedRecording() { return { source, segments: [], warnings: [] }; },
        async processText() {
          processTextCalls++;
          return { output: { summary: "Profile summary", projects: input.projects ?? [], decisions: [], action_items: [],
            discussion_points: [], person_summaries: [] }, warnings: [] };
        },
        async close() {},
      }) as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof createBackfillWorker>[0]["connectRuntime"]>>>,
    });
    const result = await worker.pollOnce();
    await worker.close();
    const row = store.pending().find(({ revision }) => revision === 1);
    const artifact = row?.recoveryArtifact == null ? null : JSON.parse(row.recoveryArtifact) as TeamMemMeetingArtifactV2;
    return { result, artifact, processTextCalls, transportsClosed };
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("post-meeting artifact records the profile its synthesis ran in, for both profiles", async () => {
  for (const profile of ["online", "offline"] as const) {
    const run = await runInitialBuild({ seedProfile: profile, runtimeProfile: profile });
    assert.equal(run.result.kind, "enqueued", profile);
    assert.equal(run.processTextCalls, 1);
    assert.equal(run.artifact?.provenance.runtime_profile, profile);
  }
});

test("a post-meeting Runtime in a different profile from the meeting's pinned one is refused before any processing", async () => {
  for (const [seedProfile, runtimeProfile] of [["online", "offline"], ["offline", "online"]] as const) {
    const run = await runInitialBuild({ seedProfile, runtimeProfile });
    assert.deepEqual(run.result, { kind: "rescheduled", occurrenceId: run.result.kind === "idle" ? "" : run.result.occurrenceId,
      reason: "runtime_failed", refusal: "profile_mismatch" }, `${seedProfile} meeting, ${runtimeProfile} post-meeting Runtime`);
    assert.equal(run.processTextCalls, 0, "no synthesis may run in a switched profile");
    assert.equal(run.artifact, null, "no artifact may claim a profile its synthesis did not run in");
    assert.equal(run.transportsClosed, 1, "the refused Runtime is still cleaned up");
  }
});

test("model-proposed projects outside the published project list are flagged, not published, and do not block the meeting", async () => {
  const run = await runInitialBuild({ seedProfile: "online", runtimeProfile: "online", knownProjects: ["Atlas"],
    projects: [{ name: "Brand New Thing", evidence_segment_ids: ["seg-missing"] }] });
  assert.equal(run.result.kind, "enqueued");
  assert.deepEqual(run.artifact?.projects, []);
  assert.deepEqual(run.artifact?.processing_warnings.filter(({ code }) => code === "project_unassigned"),
    [{ code: "project_unassigned", detail: "Brand New Thing" }]);
});

test("an unreadable project list leaves every proposed project unassigned and still publishes the meeting", async () => {
  const run = await runInitialBuild({ seedProfile: "online", runtimeProfile: "online", knownProjects: null,
    projects: [{ name: "Atlas", evidence_segment_ids: ["seg-missing"] }] });
  assert.equal(run.result.kind, "enqueued");
  assert.deepEqual(run.artifact?.projects, []);
  assert.deepEqual(run.artifact?.processing_warnings.filter(({ code }) => code.startsWith("project_")).map(({ code }) => code),
    ["project_index_unavailable", "project_unassigned"]);
});
