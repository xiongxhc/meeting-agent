import assert from "node:assert/strict";
import { test } from "node:test";
import type { BridgeEventMessageV2 } from "../src/contracts/bridge-session-v2.ts";
import type { SessionStore } from "../src/ports/session-store.ts";
import { readClosedTimedAttendance } from "../src/sessions/speaker-reconciler.ts";
import { testCapability } from "./lib/runtime-sdk.ts";

type ClosedStore = Pick<SessionStore, "getRecordingRecovery" | "getTimedEvidenceBinding" | "getTimedEvidenceStatus" |
  "getSelectedAlignment" | "readSelectedAlignmentPage" | "readTimedUi" | "readTimedFinal" | "getRecording" | "getBridgeFailureRecording">;

const common = { schema: "bridge-session/v2" as const, sessionId: "bridge", observationTiming: null,
  observationTimingReason: "timing_unavailable" as const };

function joined(sequence: number, feishuUserId: string, displayName: string, observedAt: string): BridgeEventMessageV2 {
  return { ...common, sequence, observedAt, type: "participant_joined", feishuUserId, displayName };
}

function left(sequence: number, feishuUserId: string, observedAt: string): BridgeEventMessageV2 {
  return { ...common, sequence, observedAt, type: "participant_left", feishuUserId };
}

function storeFixture(events: readonly BridgeEventMessageV2[]) {
  const selected = { generationId: "generation", attemptId: "attempt", source: { sourceSessionId: 41n,
    recordingHandle: testCapability.recordingHandle, sha256: testCapability.sha256 }, timingContract: "capture-clock/v1" as const,
    policyId: "local-wall-estimate/v1" as const, coverageStatus: "available" as const, pageCount: 1, entryCount: 1,
    storedBytes: 1, warnings: [] };
  let current = selected;
  const binding = { occurrenceId: "occurrence", bridgeSessionId: "bridge", runtimeSessionId: 41n };
  const store: ClosedStore = {
    getRecordingRecovery: () => ({ generationId: "generation", occurrenceId: "occurrence", bridgeSessionId: "bridge",
      capability: testCapability, recordingKind: "final", failureAttempt: null }),
    getRecording: () => ({ occurrenceId: "occurrence", handle: testCapability.recordingHandle, encryptedPath: "/private/audio.enc",
      sha256: testCapability.sha256, durationMs: 1, format: "pcm_s16le/24000/1/20ms", keyId: testCapability.keyId,
      finalizedAtMs: 1, gaps: [], runtimeGaps: [] }),
    getBridgeFailureRecording: () => null,
    getSelectedAlignment: () => current,
    getTimedEvidenceBinding: () => ({ kind: "timed", generationId: "generation", binding,
      recordingHandle: testCapability.recordingHandle, terminalAtMs: 1, expiresAtMs: 10_000, state: "closed" }),
    getTimedEvidenceStatus: () => ({ state: "closed", uiRows: events.length, uiBytes: 1, liveRows: 0,
      uiLossReason: null, wordingLossReason: null }),
    readTimedUi: (_binding, after) => events.filter(({ sequence }) => sequence > after).slice(0, 8),
    readSelectedAlignmentPage: () => null,
    readTimedFinal: () => null,
  };
  return { store, selected, replaceSelected() { current = { ...selected, attemptId: "replacement" }; } };
}

test("closed attendance streams only participant projections through the existing reducer", async () => {
  const discarded = { schema: "bridge-session/v2", sessionId: "bridge", sequence: 2, observedAt: "2026-09-02T14:00:01Z",
    type: "command_result", commandId: "command", outcome: "ok", detail: "x".repeat(2048) } as const;
  const fixture = storeFixture([
    joined(1, "a", "Ada", "2026-09-02T14:00:00Z"), discarded,
    left(3, "a", "2026-09-02T14:05:00Z"), left(4, "ghost", "2026-09-02T14:06:00Z"),
    joined(5, "c", "Chris", "2026-09-02T14:07:00Z"),
  ]);

  const result = await readClosedTimedAttendance({ occurrenceId: "occurrence", bridgeSessionId: "bridge",
    recordingHandle: testCapability.recordingHandle, store: fixture.store, nowMs: () => 100 });

  assert.deepEqual(result.attendance, [
    { feishuUserId: "a", displayName: "Ada", joinedAt: "2026-09-02T14:00:00Z", leftAt: "2026-09-02T14:05:00Z" },
    { feishuUserId: "c", displayName: "Chris", joinedAt: "2026-09-02T14:07:00Z", leftAt: null },
  ]);
  assert.equal(result.selectedAlignment.attemptId, "attempt");
});

test("closed attendance rejects selected alignment replacement between pages", async () => {
  const fixture = storeFixture(Array.from({ length: 9 }, (_, index) =>
    joined(index + 1, `person-${index}`, `Person ${index}`, `2026-09-02T14:00:${String(index).padStart(2, "0")}Z`)));
  const read = fixture.store.readTimedUi.bind(fixture.store);
  let pages = 0;
  const store: ClosedStore = { ...fixture.store, readTimedUi(binding, after, now) {
    const page = read(binding, after, now);
    if (++pages === 1) fixture.replaceSelected();
    return page;
  } };

  await assert.rejects(readClosedTimedAttendance({ occurrenceId: "occurrence", bridgeSessionId: "bridge",
    recordingHandle: testCapability.recordingHandle, store, nowMs: () => 100 }), /selected final alignment changed/);
});

test("closed attendance rejects an unbounded store page", async () => {
  const events = Array.from({ length: 9 }, (_, index) =>
    joined(index + 1, `person-${index}`, `Person ${index}`, `2026-09-02T14:00:${String(index).padStart(2, "0")}Z`));
  const fixture = storeFixture(events);
  const store: ClosedStore = { ...fixture.store, readTimedUi: () => events };
  await assert.rejects(readClosedTimedAttendance({ occurrenceId: "occurrence", bridgeSessionId: "bridge",
    recordingHandle: testCapability.recordingHandle, store, nowMs: () => 100 }), /invalid bounded UI page/);
});
