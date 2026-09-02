import { deepStrictEqual, notStrictEqual, strictEqual } from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { createBridgeSessionValidator } from "../src/protocol.ts";
import {
  createSequentialClock,
  loadObservationFixture,
  replayFixture,
  replayFixtureToEvidence,
} from "../src/replay.ts";

const FIXTURES_DIR = path.join(import.meta.dirname, "../fixtures/observations");

function fixturePath(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

// ---------------------------------------------------------------------------
// Seven required scenarios, each asserting the full ordered BridgeEvent list —
// not just that "an event was emitted".
// ---------------------------------------------------------------------------

test("replay: one active speaker", () => {
  const fixture = loadObservationFixture(fixturePath("one-active-speaker.json"));
  const events = replayFixture(fixture);
  deepStrictEqual(events, [
    {
      schema: "bridge-session/v1",
      sessionId: "sess_replay_0000000000000001",
      sequence: 1,
      observedAt: "2026-09-02T14:00:10.000Z",
      type: "active_speaker",
      confidence: "ui_exact",
      feishuUserId: "ou_00000000000000000000000000000a",
    },
  ]);
});

test("replay: speaker switch emits both speakers in order, dedupes the repeat", () => {
  const fixture = loadObservationFixture(fixturePath("speaker-switch.json"));
  const events = replayFixture(fixture);
  deepStrictEqual(events, [
    {
      schema: "bridge-session/v1",
      sessionId: "sess_replay_0000000000000002",
      sequence: 1,
      observedAt: "2026-09-02T14:00:10.000Z",
      type: "active_speaker",
      confidence: "ui_exact",
      feishuUserId: "ou_00000000000000000000000000000a",
    },
    {
      schema: "bridge-session/v1",
      sessionId: "sess_replay_0000000000000002",
      sequence: 2,
      observedAt: "2026-09-02T14:00:15.000Z",
      type: "active_speaker",
      confidence: "ui_exact",
      feishuUserId: "ou_00000000000000000000000000000b",
    },
  ]);
});

test("replay: two highlighted tiles are ambiguous, feishuUserId null — never a chosen participant", () => {
  const fixture = loadObservationFixture(fixturePath("two-highlighted-tiles.json"));
  const events = replayFixture(fixture);
  deepStrictEqual(events, [
    {
      schema: "bridge-session/v1",
      sessionId: "sess_replay_0000000000000003",
      sequence: 1,
      observedAt: "2026-09-02T14:00:20.000Z",
      type: "active_speaker",
      confidence: "ambiguous",
      feishuUserId: null,
    },
  ]);
  // Both tiles were individually resolvable in the fixture's identity table —
  // proving this is the overlap rule firing, not a missing-identity fallback.
  strictEqual(Object.keys(fixture.tileIdentities).length, 2);
});

test("replay: participant join", () => {
  const fixture = loadObservationFixture(fixturePath("participant-join.json"));
  const events = replayFixture(fixture);
  deepStrictEqual(events, [
    {
      schema: "bridge-session/v1",
      sessionId: "sess_replay_0000000000000004",
      sequence: 1,
      observedAt: "2026-09-02T14:00:05.000Z",
      type: "participant_joined",
      feishuUserId: "ou_00000000000000000000000000000a",
      displayName: "Test Participant One",
    },
  ]);
});

test("replay: participant leave", () => {
  const fixture = loadObservationFixture(fixturePath("participant-leave.json"));
  const events = replayFixture(fixture);
  deepStrictEqual(events, [
    {
      schema: "bridge-session/v1",
      sessionId: "sess_replay_0000000000000005",
      sequence: 1,
      observedAt: "2026-09-02T14:00:00.000Z",
      type: "participant_joined",
      feishuUserId: "ou_00000000000000000000000000000a",
      displayName: "Test Participant One",
    },
    {
      schema: "bridge-session/v1",
      sessionId: "sess_replay_0000000000000005",
      sequence: 2,
      observedAt: "2026-09-02T14:00:00.000Z",
      type: "participant_joined",
      feishuUserId: "ou_00000000000000000000000000000b",
      displayName: "Test Participant Two",
    },
    {
      schema: "bridge-session/v1",
      sessionId: "sess_replay_0000000000000005",
      sequence: 3,
      observedAt: "2026-09-02T14:00:30.000Z",
      type: "participant_left",
      feishuUserId: "ou_00000000000000000000000000000b",
    },
  ]);
});

test("replay: meeting ended", () => {
  const fixture = loadObservationFixture(fixturePath("meeting-ended.json"));
  const events = replayFixture(fixture);
  deepStrictEqual(events, [
    {
      schema: "bridge-session/v1",
      sessionId: "sess_replay_0000000000000006",
      sequence: 1,
      observedAt: "2026-09-02T14:30:00.000Z",
      type: "left",
      reason: "ended",
    },
  ]);
});

test("replay: missing chat control never blocks, reports unavailable", () => {
  const fixture = loadObservationFixture(fixturePath("missing-chat-control.json"));
  const events = replayFixture(fixture);
  deepStrictEqual(events, [
    {
      schema: "bridge-session/v1",
      sessionId: "sess_replay_0000000000000007",
      sequence: 1,
      observedAt: "2026-09-02T14:00:02.000Z",
      type: "chat_disclosure",
      outcome: "unavailable",
    },
  ]);
});

// ---------------------------------------------------------------------------
// Cross-cutting: every replayed stream clears the real bridge-session/v1
// validator, and evidence output is byte-identical given the same clock.
// ---------------------------------------------------------------------------

const ALL_FIXTURES = [
  "one-active-speaker.json",
  "speaker-switch.json",
  "two-highlighted-tiles.json",
  "participant-join.json",
  "participant-leave.json",
  "meeting-ended.json",
  "missing-chat-control.json",
];

test("replay: every fixture's stream passes the session-scoped bridge validator", () => {
  for (const name of ALL_FIXTURES) {
    const fixture = loadObservationFixture(fixturePath(name));
    const validator = createBridgeSessionValidator(fixture.sessionId);
    for (const event of replayFixture(fixture)) {
      const result = validator.acceptEvent(event);
      strictEqual(result.ok, true, `${name}: ${JSON.stringify(result)}`);
    }
  }
});

test("replay: evidence JSONL is byte-identical for the same fixture and clock", () => {
  const fixture = loadObservationFixture(fixturePath("participant-leave.json"));
  const first = replayFixtureToEvidence(fixture, createSequentialClock("2026-09-02T00:00:00Z"));
  const second = replayFixtureToEvidence(fixture, createSequentialClock("2026-09-02T00:00:00Z"));
  strictEqual(first, second);
  assertEndsWithNewline(first);
});

test("replay: evidence differs when the clock differs, proving no hidden Date.now() fallback", () => {
  const fixture = loadObservationFixture(fixturePath("meeting-ended.json"));
  const a = replayFixtureToEvidence(fixture, createSequentialClock("2026-09-02T00:00:00Z"));
  const b = replayFixtureToEvidence(fixture, createSequentialClock("2030-01-01T00:00:00Z"));
  notStrictEqual(a, b);
});

test("replay: evidence JSONL lines carry only recorder-shaped records", () => {
  const fixture = loadObservationFixture(fixturePath("one-active-speaker.json"));
  const jsonl = replayFixtureToEvidence(fixture, createSequentialClock("2026-09-02T00:00:00Z"));
  const lines = jsonl.trimEnd().split("\n");
  strictEqual(lines.length, 1);
  const record = JSON.parse(lines[0] ?? "{}") as {
    direction: string;
    recordedAt: string;
    message: { type: string };
  };
  strictEqual(record.direction, "event");
  strictEqual(record.message.type, "active_speaker");
  strictEqual(record.recordedAt, "2026-09-02T00:00:00.000Z");
});

function assertEndsWithNewline(jsonl: string): void {
  strictEqual(jsonl.endsWith("\n"), true);
}
