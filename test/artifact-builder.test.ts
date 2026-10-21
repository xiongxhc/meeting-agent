import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { isDate } from "node:util/types";

import {
  addMillisecondsToUtcInstant,
  canonicalArtifactHash,
  canonicalJson,
  parseTeamMemMeetingArtifact,
} from "../src/contracts/teammem-meeting-v1.ts";
import {
  type ArtifactBuildInput,
  buildTeamMemMeetingArtifact,
  createArtifactRevisionGuard,
} from "../src/delivery/artifact-builder.ts";
import {
  createOwnedUiExactMs,
  getOwnedUiExactMsSnapshot,
} from "../src/domain/attribution-evidence.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import type { OccurrenceId } from "../src/domain/occurrence-id.ts";
import { shortOccurrenceId } from "../src/domain/occurrence-id.ts";
import type { AttendanceInterval } from "../src/domain/participants.ts";
import type { ReconciledTranscript } from "../src/domain/transcript.ts";
import type { ConversationRuntimePort, ProcessTextRequest } from "../src/ports/conversation-runtime.ts";
import { reconcileTranscript } from "../src/sessions/speaker-reconciler.ts";

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
  alignment: { kind: "durable_runtime_anchor", mediaOriginAt: "2026-09-02T14:00:00Z", runtimeSessionId: 42n },
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
      provenance: { wording: "reconciled", liveSegmentIds: ["live_001"], reason: "ui_aligned", uiExactMs: createOwnedUiExactMs([["ou_ada", 10_000]]), ambiguousMs: 0, unobservedMs: 0 },
    },
    {
      segmentId: "seg_002",
      startedAtMs: 16_000,
      endedAtMs: 20_000,
      text: "An anonymous question followed.",
      speaker: { kind: "anonymous", label: "speaker_01" },
      cluster: "cluster_2",
      provenance: { wording: "live", liveSegmentIds: ["live_002"], reason: "no_signal", uiExactMs: createOwnedUiExactMs([]), ambiguousMs: 0, unobservedMs: 4_000 },
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

function runtimeReturning(output: unknown, warnings: readonly string[] = []): { readonly runtime: Pick<ConversationRuntimePort, "processText">; readonly calls: ProcessTextRequest[] } {
  const calls: ProcessTextRequest[] = [];
  return {
    calls,
    runtime: {
      async processText(request) {
        calls.push(request);
        return { output, warnings };
      },
    },
  };
}

function buildInput(runtime: Pick<ConversationRuntimePort, "processText">, revision = 1, overrides: Partial<ArtifactBuildInput> = {}): ArtifactBuildInput {
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
    ...overrides,
  };
}

function task7NamedTranscript(): ReconciledTranscript {
  return reconcileTranscript({
    attendance,
    liveSegments: [{
      segmentId: "seg_001",
      text: "Atlas is ready and Ada owns the release note.",
      final: true,
      startedAt: "2026-09-02T14:00:05Z",
      endedAt: "2026-09-02T14:00:15Z",
    }],
    evidence: [{
      bridgeSessionId: "bridge_owned",
      sequence: 1,
      observedAt: "2026-09-02T14:00:07Z",
      confidence: "ui_exact",
      feishuUserId: "ou_ada",
    }],
    reconciliation: { unavailable: "synthetic post-meeting fallback" },
    alignment: reconciled.alignment,
    endedAt: "2026-09-02T14:10:00Z",
  });
}

async function assertUiExactMsRejected(uiExactMs: unknown, ambiguousMs = 0): Promise<void> {
  const runtime = runtimeReturning(synthesis);
  const transcript = {
    ...reconciled,
    segments: [{
      ...reconciled.segments[0]!,
      provenance: {
        ...reconciled.segments[0]!.provenance,
        uiExactMs: uiExactMs as ReconciledTranscript["segments"][number]["provenance"]["uiExactMs"],
        ambiguousMs,
        unobservedMs: 0,
      },
    }],
  };
  await assert.rejects(
    buildTeamMemMeetingArtifact(buildInput(runtime.runtime, 1, { transcript })),
    (error: Error) => error.message === "reconciled attribution evidence is invalid",
  );
  assert.equal(runtime.calls.length, 0);
}

test("owned evidence copies source entries, freezes every layer, and rejects duplicate keys", () => {
  const source: Array<[string, number]> = [["ou_ada", 8_000]];
  const token = createOwnedUiExactMs(source);
  const snapshot = getOwnedUiExactMsSnapshot(token);
  assert.ok(snapshot);
  assert.notEqual(snapshot[0], source[0]);
  assert.equal(Object.getPrototypeOf(token), Object.prototype);
  assert.deepEqual(Reflect.ownKeys(token), ["ou_ada"]);
  assert.deepEqual(Object.getOwnPropertyDescriptor(token, "ou_ada"), {
    value: 8_000,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  assert.equal(Object.isFrozen(token), true);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot[0]), true);

  source[0]![0] = "ou_mutated";
  source[0]![1] = Number.NaN;
  source.push(["ou_added", 1]);
  assert.deepEqual(token, { ou_ada: 8_000 });
  assert.deepEqual(snapshot, [["ou_ada", 8_000]]);
  assert.throws(
    () => createOwnedUiExactMs([["duplicate", 1], ["duplicate", 2]]),
    /duplicate attribution evidence key/,
  );
});

test("owned attribution helpers are absent from the public package root", async () => {
  const publicApi = await import("../src/application.ts");
  assert.equal("createOwnedUiExactMs" in publicApi, false);
  assert.equal("getOwnedUiExactMsSnapshot" in publicApi, false);
});

test("canonical fixtures validate byte-for-byte, use Python canonical bytes/hashes, and preserve cross-language short occurrence ids", () => {
  assert.equal(digest("minimal"), "3ae8e2fb6a65a32586b8baf06d743c2f8b935ef0a8d9f72cf5de7c3fa507d06a");
  assert.equal(digest("complete"), "78446a650a5d230595b30718ccb5bee44e498080fb2e4e1b689d358756bf43a3");
  const minimal = parseTeamMemMeetingArtifact(fixture("minimal"));
  const complete = parseTeamMemMeetingArtifact(fixture("complete"));
  assert.equal(shortOccurrenceId(minimal.occurrence_id as OccurrenceId), "3a16a8e2");
  assert.equal(shortOccurrenceId(complete.occurrence_id as OccurrenceId), "02ef68db");
  assert.equal(Buffer.byteLength(canonicalJson(minimal), "utf8"), 1_565);
  assert.equal(Buffer.byteLength(canonicalJson(complete), "utf8"), 9_989);
  assert.equal(canonicalArtifactHash(minimal), "sha256:8385539007b68264bff2491bef81a1e3aed6f07a2bbb951bd58e7cf54985a4ca");
  assert.equal(canonicalArtifactHash(complete), "sha256:4b36ff782f2aee1290e57bde1b9191192bf6d38dfe77e862f6f84a7a31066b88");
});

test("canonical JSON orders punctuation, case, BMP, and astral keys by Unicode code point", () => {
  assert.equal(
    canonicalJson({ "𐀀": 8, "\uE000": 7, é: 6, a: 5, _: 4, Z: 3, A: 2, "!": 1 }),
    '{"!":1,"A":2,"Z":3,"_":4,"a":5,"é":6,"\uE000":7,"𐀀":8}',
  );
});

test("artifact strings and canonical JSON reject lone UTF-16 surrogates without echoing them", () => {
  const high = "\uD800";
  const low = "\uDC00";
  for (const invalid of [high, low]) {
    const artifact = structuredClone(fixture("minimal")) as { summary: string };
    artifact.summary = `prefix ${invalid} suffix`;
    assert.throws(
      () => parseTeamMemMeetingArtifact(artifact),
      (error: Error) => /Unicode scalar|validation/i.test(error.message) && !error.message.includes(invalid),
    );
    for (const value of [{ [invalid]: "valid" }, { valid: { nested: invalid } }]) {
      assert.throws(
        () => canonicalJson(value),
        (error: Error) => /Unicode scalar/i.test(error.message) && !error.message.includes(invalid),
      );
    }
  }
  const ordinary = { astral: "𐀀", escaped: 'quote " slash \\ line\u2028end' };
  assert.equal(canonicalJson(ordinary), JSON.stringify(ordinary));
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

test("strict artifact parsing accepts every legal fractional UTC width and rejects impossible and microsecond-reversed timing", () => {
  for (const fraction of ["1", "12", "123", "1234", "12345", "123456"]) {
    const artifact = structuredClone(fixture("minimal")) as { ended_at: string };
    artifact.ended_at = `2026-09-02T09:22:00.${fraction}Z`;
    assert.doesNotThrow(() => parseTeamMemMeetingArtifact(artifact));
  }
  const impossible = structuredClone(fixture("minimal")) as { ended_at: string };
  impossible.ended_at = "2026-02-30T09:22:00.1Z";
  assert.throws(() => parseTeamMemMeetingArtifact(impossible), /UTC instant/i);
  const reversed = structuredClone(fixture("minimal")) as { transcript: Array<{ started_at: string; ended_at: string }> };
  reversed.transcript[0]!.started_at = "2026-09-02T09:15:10.000002Z";
  reversed.transcript[0]!.ended_at = "2026-09-02T09:15:10.000001Z";
  assert.throws(() => parseTeamMemMeetingArtifact(reversed), /transcript ended_at/i);
  const attendanceOverlap = structuredClone(fixture("minimal")) as { participants: Array<{ attendance: Array<{ joined_at: string; left_at: string | null }> }> };
  attendanceOverlap.participants[0]!.attendance = [
    { joined_at: "2026-09-02T09:15:00Z", left_at: "2026-09-02T09:16:00.000002Z" },
    { joined_at: "2026-09-02T09:16:00.000001Z", left_at: "2026-09-02T09:17:00Z" },
  ];
  assert.throws(() => parseTeamMemMeetingArtifact(attendanceOverlap), /attendance must be ordered/i);
  const gapOverlap = structuredClone(fixture("minimal")) as { recording_gaps: Array<{ started_at: string; ended_at: string; reason: string }> };
  gapOverlap.recording_gaps = [
    { started_at: "2026-09-02T09:16:00.000001Z", ended_at: "2026-09-02T09:16:00.000003Z", reason: "gap_a" },
    { started_at: "2026-09-02T09:16:00.000002Z", ended_at: "2026-09-02T09:16:00.000004Z", reason: "gap_b" },
  ];
  assert.throws(() => parseTeamMemMeetingArtifact(gapOverlap), /recording_gaps must be ordered/i);
});

test("exact instant domain excludes year zero and offset conversion stays inside years 0001 through 9999", () => {
  const yearZero = structuredClone(fixture("minimal")) as { participants: Array<{ attendance: Array<{ joined_at: string }> }> };
  yearZero.participants[0]!.attendance[0]!.joined_at = "0000-01-01T00:00:00Z";
  assert.throws(() => parseTeamMemMeetingArtifact(yearZero), /UTC instant/i);
  assert.equal(addMillisecondsToUtcInstant("0001-01-01T00:00:00Z", 0), "0001-01-01T00:00:00Z");
  assert.equal(addMillisecondsToUtcInstant("9999-12-31T23:59:59.999999Z", 0), "9999-12-31T23:59:59.999999Z");
  assert.throws(() => addMillisecondsToUtcInstant("0001-01-01T00:00:00Z", -1), /outside|UTC instant/i);
  assert.throws(() => addMillisecondsToUtcInstant("9999-12-31T23:59:59.999999Z", 1), /outside|UTC instant/i);
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

test("builder converts media offsets only through its session-matched durable Runtime anchor", async () => {
  const anchored = {
    ...reconciled,
    alignment: { kind: "durable_runtime_anchor" as const, mediaOriginAt: "2026-09-02T14:00:30Z", runtimeSessionId: 42n },
  };
  const { runtime } = runtimeReturning(synthesis);
  const built = await buildTeamMemMeetingArtifact(buildInput(runtime, 1, { transcript: anchored }));
  assert.equal(built.artifact.transcript[0]!.started_at, "2026-09-02T14:00:35Z");
  for (const transcript of [
    { ...reconciled, alignment: null },
    { ...reconciled, alignment: { kind: "durable_runtime_anchor" as const, mediaOriginAt: "0000-01-01T00:00:00Z", runtimeSessionId: 42n } },
    { ...reconciled, alignment: { kind: "durable_runtime_anchor" as const, mediaOriginAt: "2026-09-02T14:00:30Z", runtimeSessionId: 43n } },
  ]) {
    const runtime = runtimeReturning(synthesis);
    await assert.rejects(buildTeamMemMeetingArtifact(buildInput(runtime.runtime, 1, { transcript })), /alignment|anchor/i);
    assert.equal(runtime.calls.length, 0);
  }
});

test("builder serializes named confidence from the asserted identity only", async () => {
  const transcript = {
    ...reconciled,
    alignment: { kind: "durable_runtime_anchor" as const, mediaOriginAt: "2026-09-02T14:00:00Z", runtimeSessionId: 42n },
    segments: [{
      ...reconciled.segments[0]!,
      provenance: { ...reconciled.segments[0]!.provenance, uiExactMs: createOwnedUiExactMs([["ou_ada", 8_000], ["ou_competitor", 500]]) },
    }],
  };
  const built = await buildTeamMemMeetingArtifact(buildInput(runtimeReturning(synthesis).runtime, 1, { transcript }));
  assert.equal(built.artifact.transcript[0]!.attribution_confidence, 0.8);
});

test("builder rejects an unowned plain attribution record before Runtime", async () => {
  await assertUiExactMsRejected({ ou_ada: 8_000 });
});

test("builder rejects a prototype-reassigned WeakRef while its intrinsic slot remains", async () => {
  const referent = {};
  const exotic = new WeakRef(referent) as unknown as Record<string, number>;
  Object.setPrototypeOf(exotic, Object.prototype);
  Object.defineProperty(exotic, "ou_ada", { value: 8_000, enumerable: true });
  assert.equal(WeakRef.prototype.deref.call(exotic), referent);
  await assertUiExactMsRejected(exotic);
});

test("spreading Task 7 evidence loses its trusted identity", async () => {
  const transcript = task7NamedTranscript();
  const runtime = runtimeReturning(synthesis);
  const built = await buildTeamMemMeetingArtifact(buildInput(runtime.runtime, 1, { transcript }));
  assert.equal(runtime.calls.length, 1);
  assert.equal(built.artifact.transcript[0]!.attribution_confidence, 0.8);

  const token = transcript.segments[0]!.provenance.uiExactMs;
  await assertUiExactMsRejected({ ...token });
});

test("structured-cloning Task 7 evidence loses its trusted identity", async () => {
  const token = task7NamedTranscript().segments[0]!.provenance.uiExactMs;
  await assertUiExactMsRejected(structuredClone(token));
});

test("builder rejects non-finite, fractional, negative, and over-duration owned evidence before Runtime processing", async () => {
  for (const evidence of [Infinity, Number.NaN, 1.5, -1, 10_001]) {
    const runtime = runtimeReturning(synthesis);
    const transcript = {
      ...reconciled,
      alignment: { kind: "durable_runtime_anchor" as const, mediaOriginAt: "2026-09-02T14:00:00Z", runtimeSessionId: 42n },
      segments: [{ ...reconciled.segments[0]!, provenance: { ...reconciled.segments[0]!.provenance, uiExactMs: createOwnedUiExactMs([["ou_ada", evidence], ["ou_competitor", 1]]) } }],
    };
    await assert.rejects(
      buildTeamMemMeetingArtifact(buildInput(runtime.runtime, 1, { transcript })),
      (error: Error) => /attribution evidence/i.test(error.message) && !error.message.includes("Atlas is ready"),
    );
    assert.equal(runtime.calls.length, 0);
  }
});

test("builder rejects malformed ambiguous and unobserved provenance components before Runtime processing", async () => {
  for (const provenance of [
    { ...reconciled.segments[0]!.provenance, ambiguousMs: Number.NaN },
    { ...reconciled.segments[0]!.provenance, ambiguousMs: Infinity },
    { ...reconciled.segments[0]!.provenance, ambiguousMs: -1 },
    { ...reconciled.segments[0]!.provenance, ambiguousMs: 1.5 },
    { ...reconciled.segments[0]!.provenance, unobservedMs: Number.NaN },
    { ...reconciled.segments[0]!.provenance, unobservedMs: Infinity },
    { ...reconciled.segments[0]!.provenance, unobservedMs: -1 },
    { ...reconciled.segments[0]!.provenance, unobservedMs: 1.5 },
  ]) {
    const runtime = runtimeReturning(synthesis);
    const transcript = {
      ...reconciled,
      alignment: { kind: "durable_runtime_anchor" as const, mediaOriginAt: "2026-09-02T14:00:00Z", runtimeSessionId: 42n },
      segments: [{ ...reconciled.segments[0]!, provenance }],
    };
    await assert.rejects(buildTeamMemMeetingArtifact(buildInput(runtime.runtime, 1, { transcript })), /attribution evidence/i);
    assert.equal(runtime.calls.length, 0);
  }
});

test("builder rejects overfull mutually exclusive attribution evidence and unsupported named claims before Runtime processing", async () => {
  const invalidProvenance = [
    { ...reconciled.segments[0]!.provenance, uiExactMs: createOwnedUiExactMs([["ou_ada", 8_000], ["ou_competitor", 3_000]]) },
    { ...reconciled.segments[0]!.provenance, uiExactMs: createOwnedUiExactMs([["ou_ada", 8_000], ["ou_competitor", 500]]), ambiguousMs: 1_000, unobservedMs: 1_000 },
    { ...reconciled.segments[0]!.provenance, uiExactMs: createOwnedUiExactMs([["ou_competitor", 500]]) },
    { ...reconciled.segments[0]!.provenance, uiExactMs: createOwnedUiExactMs([["ou_ada", 0]]) },
  ];
  for (const provenance of invalidProvenance) {
    const runtime = runtimeReturning(synthesis);
    const transcript = {
      ...reconciled,
      alignment: { kind: "durable_runtime_anchor" as const, mediaOriginAt: "2026-09-02T14:00:00Z", runtimeSessionId: 42n },
      segments: [{ ...reconciled.segments[0]!, provenance }],
    };
    await assert.rejects(buildTeamMemMeetingArtifact(buildInput(runtime.runtime, 1, { transcript })), /attribution evidence/i);
    assert.equal(runtime.calls.length, 0);
  }
});

test("builder rejects inherited asserted evidence before Runtime even when enumerable own evidence fits", async () => {
  const inherited = Object.create({ ou_ada: 8_000 }) as Record<string, number>;
  await assertUiExactMsRejected(inherited, 10_000);
});

test("builder rejects non-enumerable own asserted evidence before Runtime even when enumerable evidence fits", async () => {
  const nonEnumerable: Record<string, number> = {};
  Object.defineProperty(nonEnumerable, "ou_ada", { value: 8_000, enumerable: false });
  await assertUiExactMsRejected(nonEnumerable, 10_000);
});

test("builder rejects an enumerable stateful evidence getter without reading it", async () => {
  let reads = 0;
  const stateful: Record<string, number> = {};
  Object.defineProperty(stateful, "ou_ada", {
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? 8_000 : Number.NaN;
    },
  });
  await assertUiExactMsRejected(stateful);
  assert.equal(reads, 0);
});

test("builder translates a throwing evidence accessor to the generic pre-Runtime error without invoking it", async () => {
  let reads = 0;
  const throwing: Record<string, number> = {};
  Object.defineProperty(throwing, "ou_ada", {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error("private getter sentinel");
    },
  });
  await assertUiExactMsRejected(throwing);
  assert.equal(reads, 0);
});

test("builder rejects symbol-keyed evidence before Runtime processing", async () => {
  const symbolKeyed: Record<string | symbol, number> = { ou_ada: 8_000 };
  Object.defineProperty(symbolKeyed, Symbol("hidden identity"), { value: 3_000, enumerable: true });
  await assertUiExactMsRejected(symbolKeyed);
});

test("builder rejects array-shaped evidence before Runtime processing", async () => {
  const arrayShaped = [0] as unknown as Record<string, number>;
  Object.defineProperty(arrayShaped, "ou_ada", { value: 8_000, enumerable: true });
  await assertUiExactMsRejected(arrayShaped);
});

test("builder rejects class-instance evidence before Runtime processing", async () => {
  class EvidenceRecord {
    readonly ou_ada = 8_000;
  }
  await assertUiExactMsRejected(new EvidenceRecord());
});

test("builder rejects exotic built-in evidence before Runtime processing", async () => {
  const exotic = new Date(0) as unknown as Record<string, number>;
  Object.defineProperty(exotic, "ou_ada", { value: 8_000, enumerable: true });
  await assertUiExactMsRejected(exotic);
});

test("builder rejects intrinsically branded Date evidence after its prototype is reassigned", async () => {
  const exotic = new Date(0) as unknown as Record<string, number>;
  Object.setPrototypeOf(exotic, Object.prototype);
  Object.defineProperty(exotic, "ou_ada", { value: 8_000, enumerable: true });
  assert.equal(Object.getPrototypeOf(exotic), Object.prototype);
  assert.equal(isDate(exotic), true);
  await assertUiExactMsRejected(exotic);
});

test("builder translates evidence reflection failures to the generic error before Runtime", async () => {
  let reflections = 0;
  const hostile = new Proxy({ ou_ada: 8_000 }, {
    get() {
      reflections += 1;
      throw new Error("private get sentinel");
    },
    getPrototypeOf() {
      reflections += 1;
      throw new Error("private prototype sentinel");
    },
    ownKeys() {
      reflections += 1;
      throw new Error("private keys sentinel");
    },
    getOwnPropertyDescriptor() {
      reflections += 1;
      throw new Error("private reflection sentinel");
    },
  });
  await assertUiExactMsRejected(hostile);
  assert.equal(reflections, 0);
});

test("builder rejects null-prototype and frozen same-shape evidence forgeries", async () => {
  const nullPrototype = Object.create(null) as Record<string, number>;
  Object.defineProperties(nullPrototype, {
    ou_ada: { value: 8_000, enumerable: true },
    ou_competitor: { value: 500, enumerable: true },
  });
  for (const forgery of [nullPrototype, Object.freeze({ ou_ada: 8_000, ou_competitor: 500 })]) {
    await assertUiExactMsRejected(forgery);
  }
});

test("builder rejects a proxy around genuine Task 7 evidence without invoking traps", async () => {
  let traps = 0;
  const token = task7NamedTranscript().segments[0]!.provenance.uiExactMs;
  const proxied = new Proxy(token, {
    get() {
      traps += 1;
      throw new Error("private genuine-token trap");
    },
    getPrototypeOf() {
      traps += 1;
      throw new Error("private genuine-token trap");
    },
    ownKeys() {
      traps += 1;
      throw new Error("private genuine-token trap");
    },
  });
  await assertUiExactMsRejected(proxied);
  assert.equal(traps, 0);
});

test("builder preserves legitimate anonymous and ambiguous mutually-exclusive evidence", async () => {
  const cases = [
    {
      speaker: { kind: "anonymous" as const, label: "speaker_01" },
      provenance: { ...reconciled.segments[0]!.provenance, uiExactMs: createOwnedUiExactMs([]), ambiguousMs: 0, unobservedMs: 10_000 },
      artifactKind: "anonymous",
    },
    {
      speaker: { kind: "ambiguous" as const },
      provenance: { ...reconciled.segments[0]!.provenance, uiExactMs: createOwnedUiExactMs([]), ambiguousMs: 10_000, unobservedMs: 0 },
      artifactKind: "ambiguous",
    },
  ];
  for (const scenario of cases) {
    const runtime = runtimeReturning({ ...synthesis, person_summaries: [] });
    const transcript = {
      ...reconciled,
      segments: [{ ...reconciled.segments[0]!, speaker: scenario.speaker, provenance: scenario.provenance }],
    };
    const built = await buildTeamMemMeetingArtifact(buildInput(runtime.runtime, 1, { transcript }));
    assert.equal(runtime.calls.length, 1);
    assert.equal(built.artifact.transcript[0]!.speaker.kind, scenario.artifactKind);
    assert.equal(built.artifact.transcript[0]!.attribution_confidence, 0);
  }
});

test("builder accepts an attribution evidence aggregate exactly equal to the segment duration", async () => {
  const transcript = {
    ...reconciled,
    alignment: { kind: "durable_runtime_anchor" as const, mediaOriginAt: "2026-09-02T14:00:00Z", runtimeSessionId: 42n },
    segments: [{
      ...reconciled.segments[0]!,
      provenance: { ...reconciled.segments[0]!.provenance, uiExactMs: createOwnedUiExactMs([["ou_ada", 8_000], ["ou_competitor", 500]]), ambiguousMs: 1_000, unobservedMs: 500 },
    }],
  };
  const built = await buildTeamMemMeetingArtifact(buildInput(runtimeReturning(synthesis).runtime, 1, { transcript }));
  assert.equal(built.artifact.transcript[0]!.attribution_confidence, 0.8);
});

test("builder fails closed before processText until the voice meeting ended and rejects unsupported text output", async () => {
  const live = runtimeReturning(synthesis);
  await assert.rejects(buildTeamMemMeetingArtifact({ ...buildInput(live.runtime), meetingEnded: false }), /ended/i);
  assert.equal(live.calls.length, 0);
  const invalid = runtimeReturning({ ...synthesis, unexpected: true });
  await assert.rejects(buildTeamMemMeetingArtifact(buildInput(invalid.runtime)), /unknown|unrecognized|unexpected/i);
});

test("builder represents every scalar Runtime warning without retaining raw transcript or credential content", async () => {
  for (const warning of ["structured output repaired one omitted field", "Atlas is ready", "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789", "C1\u0085control", "", "x".repeat(501)]) {
    const safe = await buildTeamMemMeetingArtifact(buildInput(runtimeReturning(synthesis, [warning]).runtime, 1, {
      transcript: { ...reconciled, alignment: { kind: "durable_runtime_anchor" as const, mediaOriginAt: "2026-09-02T14:00:00Z", runtimeSessionId: 42n } },
    }));
    const detail = safe.artifact.processing_warnings.at(-1)?.detail ?? "";
    assert.equal(safe.artifact.processing_warnings.at(-1)?.code, "runtime_text_warning");
    assert.match(detail, /^Runtime text processing warning \(sha256:[a-f0-9]{64}\)$/);
    assert.notEqual(detail, warning);
    if (warning.length > 0) assert.ok(!detail.includes(warning));
  }
});

test("builder rejects non-scalar Runtime warnings generically without returning an artifact", async () => {
  const invalid = "unsafe\uD800credential";
  const runtime = runtimeReturning(synthesis, [invalid]);
  await assert.rejects(buildTeamMemMeetingArtifact(buildInput(runtime.runtime, 1, {
    transcript: { ...reconciled, alignment: { kind: "durable_runtime_anchor" as const, mediaOriginAt: "2026-09-02T14:00:00Z", runtimeSessionId: 42n } },
  })), (error: Error) => /warning cannot be represented/i.test(error.message) && !error.message.includes(invalid));
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
  const aligned = { ...reconciled, alignment: { kind: "durable_runtime_anchor" as const, mediaOriginAt: "2026-09-02T14:00:00Z", runtimeSessionId: 42n } };
  const first = await buildTeamMemMeetingArtifact({ ...buildInput(runtimeReturning(synthesis).runtime, 1, { transcript: aligned }), revisionGuard: guard });
  const replay = await buildTeamMemMeetingArtifact({ ...buildInput(runtimeReturning(synthesis).runtime, 1, { transcript: aligned }), revisionGuard: guard });
  assert.equal(first.serialized, replay.serialized);
  assert.equal(first.artifact_hash, replay.artifact_hash);
  const changed = { ...synthesis, summary: "A materially changed summary." };
  await assert.rejects(buildTeamMemMeetingArtifact({ ...buildInput(runtimeReturning(changed).runtime, 1, { transcript: aligned }), revisionGuard: guard }), /immutable|conflict/i);
  const higher = await buildTeamMemMeetingArtifact({ ...buildInput(runtimeReturning(changed).runtime, 2, { transcript: aligned }), revisionGuard: guard });
  assert.notEqual(higher.artifact_hash, first.artifact_hash);
  await assert.rejects(buildTeamMemMeetingArtifact({ ...buildInput(runtimeReturning(synthesis).runtime, 1, { transcript: aligned }), revisionGuard: guard }), /lower/i);
});

test("builder publishes only project names from the supplied published list and flags the rest", async () => {
  const proposed = { ...synthesis, projects: [{ name: " PROJECT-ATLAS", evidence_segment_ids: ["seg_001"] },
    { name: "project-atlas", evidence_segment_ids: ["seg_001"] }, { name: "Unlisted", evidence_segment_ids: ["seg_001"] }] };
  const built = await buildTeamMemMeetingArtifact(buildInput(runtimeReturning(proposed).runtime, 1, { knownProjects: ["project-atlas"] }));
  assert.deepEqual(built.artifact.projects, [{ name: "project-atlas", evidence_segment_ids: ["seg_001"] }]);
  assert.deepEqual(built.artifact.processing_warnings.at(-1), { code: "project_unassigned", detail: "Unlisted" });
});

test("project warnings never push a meeting over the artifact's warning limit", async () => {
  const proposed = { ...synthesis, projects: Array.from({ length: 500 }, (_, index) => ({ name: `Unlisted ${index}`, evidence_segment_ids: ["seg_001"] })) };
  const processingWarnings = Array.from({ length: 498 }, (_, index) => ({ code: "synthetic_warning", detail: `Synthetic ${index}.` }));
  const built = await buildTeamMemMeetingArtifact(buildInput(runtimeReturning(proposed).runtime, 1, { knownProjects: ["project-atlas"], processingWarnings }));
  assert.equal(built.artifact.processing_warnings.length, 500);
  assert.deepEqual(built.artifact.processing_warnings.slice(-2).map(({ code }) => code), ["project_unassigned", "project_unassigned_more"]);
  assert.deepEqual(built.artifact.projects, []);
});

test("synthesis is asked for discussed projects, from the published names it is given", async () => {
  const { runtime, calls } = runtimeReturning(synthesis);
  await buildTeamMemMeetingArtifact(buildInput(runtime, 1, { knownProjects: ["project-atlas", "Orbit"] }));
  const request = calls[0]!;
  assert.doesNotMatch(request.instructions, /Do not infer[^.]*projects/);
  assert.match(request.instructions, /Do not infer identities, owners, or dates\./);
  assert.match(request.instructions, /list each project the meeting substantively discussed[^.]*known_projects[^.]*segment IDs/);
  const input = JSON.parse(request.input) as { known_projects: string[]; transcript: { segment_id: string }[] };
  assert.deepEqual(Object.keys(input), ["known_projects", "transcript"]);
  assert.deepEqual(input.known_projects, ["project-atlas", "Orbit"]);
  assert.deepEqual(input.transcript.map(({ segment_id }) => segment_id), ["seg_001", "seg_002"]);
});
