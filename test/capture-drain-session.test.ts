import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import { createCoordinator } from "../src/sessions/coordinator.ts";
import { createMeetingSession } from "../src/sessions/meeting-session.ts";
import { parseCommandV2, type BridgeCommandMessageV2 } from "../src/contracts/bridge-session-v2.ts";
import { fakeRuntime } from "./lib/session-fakes.ts";
import type { CaptureDrain } from "../src/contracts/bridge-session-v1.ts";

const CONFIRMED: CaptureDrain = {
  drain: "confirmed", reason: null,
  boundary: { captureEpoch: "1", lastFrameSequence: "70", outputEndSample: "33600", finalClockPairSequence: "2" },
};
const UNCONFIRMED: CaptureDrain = { drain: "unconfirmed", reason: "drain_not_attempted", boundary: null };

/**
 * Drives the shipped v2 session to a bridge-observed end, publishing whichever
 * `media_disconnected` events the case names before `left`. Nothing else about
 * the shutdown differs between the cases: the drain is evidence, never a gate.
 */
async function finalizedWith(label: string, drains: readonly (CaptureDrain | undefined)[]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-capture-drain-session-"));
  const store = openSessionStore({ filename: path.join(dir, "state.db") });
  const identity = buildMeetingIdentity({ providerMeetingId: label, meetingNo: "000000000",
    occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "Drain", organizer: null });
  const coordinator = createCoordinator({ store, clock: { now: () => 1000 }, bridgeLeaseTtlMs: 30_000, maxConcurrentSessions: 1 });
  coordinator.discover(identity);
  const runtime = { ...fakeRuntime(), currentSessionId: 42n,
    startVoiceSession: async () => ({ timingContract: "capture-clock/v1" as const, bridgeSessionId: "bridge-one", sessionId: 42n,
      mediaLease: { mediaProtocolVersion: 2 as const, sessionId: 42n, connectEndpoint: "tcp://127.0.0.1:9001",
        credential: "a".repeat(64), expiresAtMs: BigInt(Date.now() + 60_000), reconnectWindowMs: 10_000n,
        captureFormat: "pcm_s16le/24000/1/20ms" as const, timingContract: "capture-clock/v1" as const } }) };
  let listener: ((raw: unknown) => void) | undefined;
  let sequence = 0;
  const emit = (event: Record<string, unknown>) => listener?.({ schema: "bridge-session/v2", sessionId: "bridge-one",
    sequence: ++sequence, observedAt: "2026-09-02T14:00:00Z", ...event });
  const bridge = {
    subscribe(callback: (raw: unknown) => void) { listener = callback; return () => { listener = undefined; }; },
    async send(command: BridgeCommandMessageV2) {
      parseCommandV2(command);
      if (command.type !== "join") return;
      emit({ type: "joined", meetingOccurrenceId: identity.occurrenceId, observationTiming: null, observationTimingReason: "timing_unavailable" });
      emit({ type: "media_connected", endpoint: "tcp://127.0.0.1:9001" });
    },
  };
  const session = createMeetingSession({ identity, bridge, runtime, coordinator, clock: { now: () => 1000 },
    agentIdentity: { aliases: ["Meetbot"] }, bridgeId: "mac", bridgeSessionId: "bridge-one",
    disclosureText: "Disclosure", timedEvidence: { store } });
  try {
    await session.join();
    for (const drain of drains) {
      emit({ type: "media_disconnected", reason: "media_stopped", ...(drain === undefined ? {} : { captureDrain: drain }) });
    }
    emit({ type: "left", reason: "ended", observationTiming: null, observationTimingReason: "timing_unavailable" });
    await session.settled();
    return { recording: store.getRecording(identity.occurrenceId), state: store.getSession(identity.occurrenceId) };
  } finally {
    await session.dispose(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
}

test("the session persists the last capture-drain claim the bridge made", async () => {
  const confirmed = await finalizedWith("confirmed", [CONFIRMED]);
  assert.deepEqual(confirmed.recording?.captureDrain, CONFIRMED);
  assert.equal(confirmed.recording?.captureIntegrity, "confirmed");

  const unconfirmed = await finalizedWith("unconfirmed", [UNCONFIRMED]);
  assert.deepEqual(unconfirmed.recording?.captureDrain, UNCONFIRMED);
  assert.equal(unconfirmed.recording?.captureIntegrity, "unconfirmed");

  // Reconnect churn: the terminal claim is the one that describes the capture
  // this recording finalizes, and an event without the member does not erase it.
  const last = await finalizedWith("last", [CONFIRMED, UNCONFIRMED]);
  assert.deepEqual(last.recording?.captureDrain, UNCONFIRMED);
  const silentAfter = await finalizedWith("silent-after", [CONFIRMED, undefined]);
  assert.deepEqual(silentAfter.recording?.captureDrain, CONFIRMED);
});

test("a session that never saw the member records no claim at all", async () => {
  const silent = await finalizedWith("silent", [undefined]);
  assert.equal(silent.recording?.captureDrain, null);
  assert.equal(silent.recording?.captureIntegrity, "unavailable");
  // PCM is recorded independently of any drain claim: the row exists either way.
  assert.ok(silent.recording?.handle);
});

/**
 * D029 §4 / Slice 5's validation rule. Finalization is driven by the SDK's own
 * stop acknowledgement, so the recording row and its handle are identical
 * across every drain outcome; only the persisted evidence differs.
 */
test("neither stop nor finalize is the drain oracle", async () => {
  const outcomes = await Promise.all([
    finalizedWith("oracle-confirmed", [CONFIRMED]),
    finalizedWith("oracle-unconfirmed", [UNCONFIRMED]),
    finalizedWith("oracle-silent", [undefined]),
  ]);
  for (const outcome of outcomes) {
    assert.equal(outcome.state?.state, "finalizing", "finalization proceeds whatever the drain said");
    assert.ok(outcome.recording, "the recording is written whatever the drain said");
    assert.equal(outcome.recording?.durationMs, outcomes[0]!.recording?.durationMs);
    assert.deepEqual(outcome.recording?.runtimeGaps, outcomes[0]!.recording?.runtimeGaps);
  }
  // The persisted outcome is exactly what the bridge said -- no promotion of an
  // unconfirmed drain by an accepted stop, no invention where none was claimed.
  assert.deepEqual(outcomes.map((outcome) => outcome.recording?.captureIntegrity),
    ["confirmed", "unconfirmed", "unavailable"]);
});
