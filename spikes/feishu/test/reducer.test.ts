import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { test } from "node:test";

import { createBridgeSessionValidator } from "../src/protocol.ts";
import type { ChatControlPort, SpeakerIdentityPort } from "../src/reducer.ts";
import { createObservationReducer } from "../src/reducer.ts";

// ---------------------------------------------------------------------------
// This is the reference implementation of the ambiguity policy: a highlighted
// tile the reducer cannot confidently resolve, or more than one tile lit at
// once, must never carry a chosen participant. Every test in this file that
// touches active_speaker asserts that directly.
// ---------------------------------------------------------------------------

const SESSION_ID = "sess_reducer_unit_0000000001";

function stubSpeakerIdentity(table: Record<string, string>): SpeakerIdentityPort {
  return {
    identifyTile(tileId) {
      const feishuUserId = table[tileId];
      return feishuUserId === undefined ? null : { feishuUserId };
    },
  };
}

function stubChatControl(available: boolean): ChatControlPort {
  return {
    postDisclosure() {
      return available
        ? { outcome: "sent", detail: null }
        : { outcome: "unavailable", detail: "no chat control" };
    },
  };
}

function newReducer(options: {
  speakerIdentity?: SpeakerIdentityPort;
  chatControl?: ChatControlPort;
}) {
  return createObservationReducer({
    sessionId: SESSION_ID,
    speakerIdentity: options.speakerIdentity ?? stubSpeakerIdentity({}),
    chatControl: options.chatControl ?? stubChatControl(true),
  });
}

/** Every event produced anywhere in this file must clear the real stream validator. */
function assertPassesStreamValidator(events: readonly unknown[]): void {
  const validator = createBridgeSessionValidator(SESSION_ID);
  for (const event of events) {
    const result = validator.acceptEvent(event);
    strictEqual(result.ok, true, JSON.stringify(result));
  }
}

test("reducer: single highlighted tile with a resolved identity is ui_exact", () => {
  const reducer = newReducer({
    speakerIdentity: stubSpeakerIdentity({ "tile-1": "ou_0000000000000001" }),
  });
  const events = reducer.reduce({
    kind: "speaker_highlight",
    observedAt: "2026-09-02T00:00:00.000Z",
    highlightedTileIds: ["tile-1"],
  });
  deepStrictEqual(events, [
    {
      schema: "bridge-session/v1",
      sessionId: SESSION_ID,
      sequence: 1,
      observedAt: "2026-09-02T00:00:00.000Z",
      type: "active_speaker",
      confidence: "ui_exact",
      feishuUserId: "ou_0000000000000001",
    },
  ]);
  assertPassesStreamValidator(events);
});

test("reducer: single highlighted tile with no resolvable identity is ambiguous, never guessed", () => {
  const reducer = newReducer({ speakerIdentity: stubSpeakerIdentity({}) });
  const events = reducer.reduce({
    kind: "speaker_highlight",
    observedAt: "2026-09-02T00:00:00.000Z",
    highlightedTileIds: ["tile-unknown"],
  });
  deepStrictEqual(events, [
    {
      schema: "bridge-session/v1",
      sessionId: SESSION_ID,
      sequence: 1,
      observedAt: "2026-09-02T00:00:00.000Z",
      type: "active_speaker",
      confidence: "ambiguous",
      feishuUserId: null,
    },
  ]);
  assertPassesStreamValidator(events);
});

test("reducer: two highlighted tiles are ambiguous even when both identities resolve", () => {
  const reducer = newReducer({
    speakerIdentity: stubSpeakerIdentity({
      "tile-1": "ou_0000000000000001",
      "tile-2": "ou_0000000000000002",
    }),
  });
  const events = reducer.reduce({
    kind: "speaker_highlight",
    observedAt: "2026-09-02T00:00:00.000Z",
    highlightedTileIds: ["tile-1", "tile-2"],
  });
  strictEqual(events.length, 1);
  const [event] = events;
  ok(event !== undefined);
  strictEqual(event.type, "active_speaker");
  strictEqual((event as { confidence: string }).confidence, "ambiguous");
  strictEqual((event as { feishuUserId: unknown }).feishuUserId, null);
  assertPassesStreamValidator(events);
});

test("reducer: an unchanged highlight does not re-emit active_speaker", () => {
  const reducer = newReducer({
    speakerIdentity: stubSpeakerIdentity({ "tile-1": "ou_0000000000000001" }),
  });
  const first = reducer.reduce({
    kind: "speaker_highlight",
    observedAt: "2026-09-02T00:00:00.000Z",
    highlightedTileIds: ["tile-1"],
  });
  const second = reducer.reduce({
    kind: "speaker_highlight",
    observedAt: "2026-09-02T00:00:01.000Z",
    highlightedTileIds: ["tile-1"],
  });
  strictEqual(first.length, 1);
  strictEqual(second.length, 0);
});

test("reducer: no highlighted tile emits nothing", () => {
  const reducer = newReducer({});
  const events = reducer.reduce({
    kind: "speaker_highlight",
    observedAt: "2026-09-02T00:00:00.000Z",
    highlightedTileIds: [],
  });
  deepStrictEqual(events, []);
});

test("reducer: roster snapshot diff emits leaves before joins, each in id order", () => {
  const reducer = newReducer({});
  const initial = reducer.reduce({
    kind: "roster_snapshot",
    observedAt: "2026-09-02T00:00:00.000Z",
    participants: [
      { feishuUserId: "ou_0000000000000002", displayName: "Test Participant Two" },
      { feishuUserId: "ou_0000000000000001", displayName: "Test Participant One" },
    ],
  });
  deepStrictEqual(
    initial.map((e) => ({ type: e.type, feishuUserId: (e as { feishuUserId: string }).feishuUserId })),
    [
      { type: "participant_joined", feishuUserId: "ou_0000000000000001" },
      { type: "participant_joined", feishuUserId: "ou_0000000000000002" },
    ],
  );

  const afterLeave = reducer.reduce({
    kind: "roster_snapshot",
    observedAt: "2026-09-02T00:00:10.000Z",
    participants: [
      { feishuUserId: "ou_0000000000000001", displayName: "Test Participant One" },
    ],
  });
  deepStrictEqual(afterLeave, [
    {
      schema: "bridge-session/v1",
      sessionId: SESSION_ID,
      sequence: 3,
      observedAt: "2026-09-02T00:00:10.000Z",
      type: "participant_left",
      feishuUserId: "ou_0000000000000002",
    },
  ]);
  assertPassesStreamValidator([...initial, ...afterLeave]);
});

test("reducer: one frame that both loses and gains a participant emits the leave first", () => {
  // The ordering claim is only exercised when a leave and a join fall in the
  // same frame; two separate frames would pass whatever the order.
  const reducer = newReducer({});
  reducer.reduce({
    kind: "roster_snapshot",
    observedAt: "2026-09-02T00:00:00.000Z",
    participants: [
      { feishuUserId: "ou_0000000000000001", displayName: "Test Participant One" },
      { feishuUserId: "ou_0000000000000002", displayName: "Test Participant Two" },
    ],
  });
  const swapped = reducer.reduce({
    kind: "roster_snapshot",
    observedAt: "2026-09-02T00:00:10.000Z",
    participants: [
      { feishuUserId: "ou_0000000000000003", displayName: "Test Participant Three" },
      { feishuUserId: "ou_0000000000000001", displayName: "Test Participant One" },
    ],
  });
  deepStrictEqual(
    swapped.map((e) => [e.type, (e as { feishuUserId: string }).feishuUserId]),
    [
      ["participant_left", "ou_0000000000000002"],
      ["participant_joined", "ou_0000000000000003"],
    ],
  );
  assertPassesStreamValidator(swapped);
});

test("reducer: an unchanged roster emits nothing", () => {
  const reducer = newReducer({});
  const roster = {
    kind: "roster_snapshot" as const,
    observedAt: "2026-09-02T00:00:00.000Z",
    participants: [
      { feishuUserId: "ou_0000000000000001", displayName: "Test Participant One" },
    ],
  };
  reducer.reduce(roster);
  const second = reducer.reduce({ ...roster, observedAt: "2026-09-02T00:00:05.000Z" });
  deepStrictEqual(second, []);
});

test("reducer: meeting_ended emits left with reason ended", () => {
  const reducer = newReducer({});
  const events = reducer.reduce({
    kind: "meeting_ended",
    observedAt: "2026-09-02T00:30:00.000Z",
  });
  deepStrictEqual(events, [
    {
      schema: "bridge-session/v1",
      sessionId: SESSION_ID,
      sequence: 1,
      observedAt: "2026-09-02T00:30:00.000Z",
      type: "left",
      reason: "ended",
    },
  ]);
  assertPassesStreamValidator(events);
});

test("reducer: a session is terminal after left — nothing follows it", () => {
  // The Swift second implementation needs this rule hardest: its observer
  // recovers from an unreadable client, so readable frames really do arrive
  // after it gave up. Both implementations must state the same rule.
  const reducer = newReducer({
    speakerIdentity: stubSpeakerIdentity({ "tile-1": "ou_0000000000000001" }),
  });
  const left = reducer.reduce({
    kind: "meeting_ended",
    observedAt: "2026-09-02T00:30:00.000Z",
  });
  strictEqual(left.length, 1);

  deepStrictEqual(
    reducer.reduce({
      kind: "roster_snapshot",
      observedAt: "2026-09-02T00:30:01.000Z",
      participants: [{ feishuUserId: "ou_0000000000000001", displayName: "Test Participant One" }],
    }),
    [],
  );
  deepStrictEqual(
    reducer.reduce({
      kind: "speaker_highlight",
      observedAt: "2026-09-02T00:30:02.000Z",
      highlightedTileIds: ["tile-1"],
    }),
    [],
  );
  deepStrictEqual(
    reducer.reduce({ kind: "meeting_ended", observedAt: "2026-09-02T00:30:03.000Z" }),
    [],
    "a meeting ends once; a repeated observation is not a second departure",
  );
});

test("reducer: disclosure attempt with chat control available reports sent", () => {
  const reducer = newReducer({ chatControl: stubChatControl(true) });
  const events = reducer.reduce({
    kind: "disclosure_attempt",
    observedAt: "2026-09-02T00:00:02.000Z",
    text: "synthetic disclosure text",
  });
  deepStrictEqual(events, [
    {
      schema: "bridge-session/v1",
      sessionId: SESSION_ID,
      sequence: 1,
      observedAt: "2026-09-02T00:00:02.000Z",
      type: "chat_disclosure",
      outcome: "sent",
    },
  ]);
  assertPassesStreamValidator(events);
});

test("reducer: disclosure attempt with no chat control reports unavailable, never blocking", () => {
  const reducer = newReducer({ chatControl: stubChatControl(false) });
  const events = reducer.reduce({
    kind: "disclosure_attempt",
    observedAt: "2026-09-02T00:00:02.000Z",
    text: "synthetic disclosure text",
  });
  deepStrictEqual(events, [
    {
      schema: "bridge-session/v1",
      sessionId: SESSION_ID,
      sequence: 1,
      observedAt: "2026-09-02T00:00:02.000Z",
      type: "chat_disclosure",
      outcome: "unavailable",
    },
  ]);
  assertPassesStreamValidator(events);
});

test("reducer: sequence is monotonic per session across mixed observation kinds", () => {
  const reducer = newReducer({
    speakerIdentity: stubSpeakerIdentity({ "tile-1": "ou_0000000000000001" }),
  });
  const events = [
    ...reducer.reduce({
      kind: "roster_snapshot",
      observedAt: "2026-09-02T00:00:00.000Z",
      participants: [{ feishuUserId: "ou_0000000000000001", displayName: "Test Participant One" }],
    }),
    ...reducer.reduce({
      kind: "speaker_highlight",
      observedAt: "2026-09-02T00:00:01.000Z",
      highlightedTileIds: ["tile-1"],
    }),
    ...reducer.reduce({
      kind: "meeting_ended",
      observedAt: "2026-09-02T00:00:02.000Z",
    }),
  ];
  deepStrictEqual(
    events.map((e) => e.sequence),
    [1, 2, 3],
  );
  assertPassesStreamValidator(events);
});

test("reducer refuses to construct an event that would fail its own contract", () => {
  // A port lying about a resolved identity (empty string) proves the reducer's
  // internal parseEventShape self-check is load-bearing, not decorative.
  const reducer = newReducer({
    speakerIdentity: { identifyTile: () => ({ feishuUserId: "" }) },
  });
  throws(() => {
    reducer.reduce({
      kind: "speaker_highlight",
      observedAt: "2026-09-02T00:00:00.000Z",
      highlightedTileIds: ["tile-1"],
    });
  });
});
