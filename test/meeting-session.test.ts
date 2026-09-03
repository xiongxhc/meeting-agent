// The per-meeting session: the seam where the bridge control plane
// (bridge-session/v1) and the Conversation Runtime control plane meet.
//
// What this suite exists to prove, in the order the risk sits:
//
//   1. THE AGENT CANNOT SPEAK UNDER A PROFILE NOBODY CHOSE. Join opens exactly
//      one runtime session, pinned to profile "online" and response mode
//      "external_gate". A runtime that answers with anything else -- another
//      profile, another response mode, a status short of "ready" -- aborts
//      SPEAKING and leaves CAPTURE running. Both halves are asserted; a test
//      that only checked "it stopped" would pass on a session that tore itself
//      down and lost the meeting.
//
//   2. AN AUDIO FRAME CANNOT REACH THE COORDINATOR. Not "does not today":
//      cannot. The only door in is the frozen validator's closed type table,
//      so a frame-shaped message is rejected at the boundary and never becomes
//      a routable value. The suite pins the contract's two type lists so that
//      ADDING a frame-carrying member is itself a test failure, and probes the
//      door with a frame, a frame smuggled as an extra field, and a frame
//      wearing a known type's name.
//
//   3. NO BRANCH SYNTHESIZES A SPOKEN DISCLOSURE. Disclosure is meeting-chat
//      text, posted by the bridge, across all three contract outcomes (sent /
//      unavailable / failed) and when the transport itself fails. In every one
//      of those, the runtime is asserted to have received no speech call at
//      all -- and failing to disclose never blocks joining.
//
//   4. EXACTLY ONE TERMINAL EVENT PER TURN, UNDER RACES. Not "the happy path
//      produced one record": the racing test floods a single segment with
//      every terminal signal at once, in several orders, plus redelivery, and
//      asserts one record each time.
//
//   5. A `left` IS TERMINAL, INCLUDING `bridge_failure`. bridge-session/v1 has
//      no re-open; resuming means a new session against a new lease.
//
// Every test runs against the in-repo fakes in test/lib/session-fakes.ts. There
// is no dependency on `@conversation/runtime` -- it is not built yet. Every
// database lives in a fresh temp directory and is removed afterwards; nothing
// here touches a live TeamMem installation, and no fixture carries real tenant
// or person data.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  BRIDGE_COMMAND_TYPES,
  BRIDGE_EVENT_TYPES,
  BRIDGE_SESSION_SCHEMA,
} from "../src/contracts/bridge-session-v1.ts";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { createRuntimeInvocationSink } from "../src/adapters/conversation-runtime-client.ts";
import { buildMeetingIdentity, type MeetingIdentity } from "../src/domain/meeting.ts";
import { createCoordinator, type SessionCoordinator } from "../src/sessions/coordinator.ts";
import type { SessionStore } from "../src/ports/session-store.ts";
import { createMeetingSession, type MeetingSession } from "../src/sessions/meeting-session.ts";
import { fakeBridge, fakeClock, fakeRuntime, type FakeBridge, type FakeRuntime } from "./lib/session-fakes.ts";

const BASE_MS = 1_756_800_000_000;
const LEASE_TTL_MS = 30_000;
const BRIDGE_SESSION_ID = "sess_0000000000000001";
const DISCLOSURE_TEXT =
  "A meeting agent is present in this test meeting and will produce a transcript.";

const IDENTITY: MeetingIdentity = buildMeetingIdentity({
  providerMeetingId: "synthetic-meeting-0001",
  meetingNo: "000000000",
  occurrenceStartedAt: "2026-09-02T14:00:00Z",
  title: "Synthetic planning sync",
  organizer: {
    feishuUserId: "ou_synthetic_organizer_0001",
    displayName: "Synthetic Organizer",
    source: "reservation",
  },
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Harness = {
  readonly bridge: FakeBridge;
  readonly runtime: FakeRuntime;
  readonly coordinator: SessionCoordinator;
  readonly store: SessionStore;
  readonly session: MeetingSession;
  cleanup(): void;
};

type HarnessOptions = {
  readonly runtime?: FakeRuntime;
  readonly maxQueuedEvents?: number;
};

function harness(options: HarnessOptions = {}): Harness {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-agent-session-"));
  const store = openSessionStore({ filename: path.join(dir, "orchestration.db"), nowMs: BASE_MS });
  const clock = fakeClock(BASE_MS);
  const coordinator = createCoordinator({
    store,
    clock,
    bridgeLeaseTtlMs: LEASE_TTL_MS,
    maxConcurrentSessions: 2,
  });
  coordinator.discover(IDENTITY);

  const bridge = fakeBridge(BRIDGE_SESSION_ID);
  const runtime = options.runtime ?? fakeRuntime();
  const session = createMeetingSession({
    identity: IDENTITY,
    bridge,
    runtime,
    coordinator,
    clock,
    agentIdentity: { aliases: ["Meetbot"] },
    bridgeId: "bridge-mac-synthetic",
    bridgeSessionId: BRIDGE_SESSION_ID,
    disclosureText: DISCLOSURE_TEXT,
    ...(options.maxQueuedEvents === undefined ? {} : { maxQueuedEvents: options.maxQueuedEvents }),
  });

  return {
    bridge,
    runtime,
    coordinator,
    store,
    session,
    cleanup() {
      session.dispose();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Joins, then delivers `joined` so the session is in its listening phase --
 * the state most tests actually care about. */
async function joined(h: Harness): Promise<void> {
  await h.session.join();
  h.bridge.emit(h.bridge.event({ type: "joined", meetingOccurrenceId: IDENTITY.occurrenceId }));
  await h.session.settled();
}

function sentTypes(bridge: FakeBridge): string[] {
  return bridge.sent.map((message) => message.type);
}

function commandOfType(bridge: FakeBridge, type: string): Record<string, unknown> {
  const found = bridge.sent.find((message) => message.type === type);
  assert.ok(found !== undefined, `expected the session to have sent a "${type}" command`);
  return found as unknown as Record<string, unknown>;
}

function transcript(segmentId: string, text: string, final = true) {
  return {
    type: "transcript_final" as const,
    segment: {
      segmentId,
      text,
      final,
      startedAt: "2026-09-02T14:05:00Z",
      endedAt: "2026-09-02T14:05:04Z",
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Join: one runtime session, pinned profile and response mode
// ---------------------------------------------------------------------------

test("join starts exactly ONE runtime session, pinned to online / external_gate", async () => {
  const h = harness();
  try {
    await h.session.join();

    const starts = h.runtime.callsOf("startVoiceSession");
    assert.equal(starts.length, 1, "join must open exactly one runtime session");
    assert.deepEqual(starts[0], {
      method: "startVoiceSession",
      input: {
        occurrenceId: IDENTITY.occurrenceId,
        profile: "online",
        responseMode: "external_gate",
      },
    });
    assert.equal(h.session.state().speaking, "enabled");
    assert.equal(h.session.state().runtimeSessionId, "rt_sess_0000000000000001");
  } finally {
    h.cleanup();
  }
});

test("join issues the bridge commands in the contract's canonical order", async () => {
  const h = harness();
  try {
    await h.session.join();
    assert.deepEqual(sentTypes(h.bridge), ["join", "connect_media", "post_disclosure"]);
    assert.equal(commandOfType(h.bridge, "join")["schema"], BRIDGE_SESSION_SCHEMA);
    assert.equal(commandOfType(h.bridge, "join")["sessionId"], BRIDGE_SESSION_ID);
    assert.equal(commandOfType(h.bridge, "join")["meetingNo"], IDENTITY.meetingNo);
  } finally {
    h.cleanup();
  }
});

test("join takes a bridge lease and carries its id on the join command", async () => {
  const h = harness();
  try {
    await h.session.join();
    const lease = h.coordinator.activeBridgeLease(IDENTITY.occurrenceId);
    assert.ok(lease !== null);
    assert.equal(lease.bridgeSessionId, BRIDGE_SESSION_ID);
    assert.equal(commandOfType(h.bridge, "join")["leaseId"], lease.leaseId);
  } finally {
    h.cleanup();
  }
});

test("a joined event advances the coordinator to listening", async () => {
  const h = harness();
  try {
    await joined(h);
    assert.equal(h.session.state().phase, "listening");
    assert.equal(h.coordinator.get(IDENTITY.occurrenceId)?.state, "listening");
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 1b. Profile / status mismatch: abort SPEAKING, keep CAPTURE
// ---------------------------------------------------------------------------

const MISMATCHES: ReadonlyArray<{
  readonly label: string;
  readonly handle: Record<string, unknown>;
  readonly reason: string;
}> = [
  { label: "a profile the session did not pin", handle: { profile: "offline" }, reason: "profile_mismatch" },
  {
    label: "a response mode that would let the runtime speak for itself",
    handle: { responseMode: "autonomous" },
    reason: "response_mode_mismatch",
  },
  { label: "a degraded status", handle: { status: "degraded" }, reason: "runtime_degraded" },
  { label: "an unavailable status", handle: { status: "unavailable" }, reason: "runtime_unavailable" },
];

for (const { label, handle, reason } of MISMATCHES) {
  test(`mismatch (${label}) aborts SPEAKING`, async () => {
    const h = harness({ runtime: fakeRuntime({ handle: handle as never }) });
    try {
      await joined(h);
      assert.equal(h.session.state().speaking, "aborted");
      assert.equal(h.session.state().speakingAbortReason, reason);
    } finally {
      h.cleanup();
    }
  });

  test(`mismatch (${label}) leaves CAPTURE active`, async () => {
    const h = harness({ runtime: fakeRuntime({ handle: handle as never }) });
    try {
      await joined(h);

      // The session is still live: it joined, it connected media, it did not
      // leave, it holds its lease, and it is still consuming bridge events.
      assert.equal(h.session.state().phase, "listening");
      assert.equal(h.session.state().terminalReason, null);
      assert.deepEqual(sentTypes(h.bridge), ["join", "connect_media", "post_disclosure"]);
      assert.ok(h.coordinator.activeBridgeLease(IDENTITY.occurrenceId) !== null);

      h.bridge.emit(h.bridge.event({ type: "media_connected", endpoint: "udp://127.0.0.1:40001" }));
      h.bridge.emit(
        h.bridge.event({
          type: "audio_gap",
          direction: "capture",
          startedAt: "2026-09-02T14:10:00Z",
          endedAt: "2026-09-02T14:10:02Z",
        }),
      );
      await h.session.settled();
      assert.equal(h.session.state().mediaConnected, true);
      assert.equal(h.session.state().observedGaps.length, 1);

      // And the recording is still finalized at the end.
      h.bridge.emit(h.bridge.event({ type: "left", reason: "ended" }));
      await h.session.settled();
      assert.ok(h.session.state().recording !== null);
    } finally {
      h.cleanup();
    }
  });

  test(`mismatch (${label}) means an invoked segment is skipped, never authorized`, async () => {
    const h = harness({ runtime: fakeRuntime({ handle: handle as never }) });
    try {
      await joined(h);
      h.runtime.emit(transcript("seg-1", "Meetbot, can you summarize that?"));
      await h.session.settled();

      assert.equal(h.runtime.callsOf("authorizeVoiceResponse").length, 0);
      assert.deepEqual(h.runtime.callsOf("skipVoiceResponse"), [
        { method: "skipVoiceResponse", segmentId: "seg-1", reason: "speaking_aborted" },
      ]);
      assert.deepEqual(h.session.turns(), [
        { segmentId: "seg-1", outcome: "skipped", detail: "speaking_aborted", atMs: BASE_MS },
      ]);
    } finally {
      h.cleanup();
    }
  });
}

// ---------------------------------------------------------------------------
// 2. Disclosure: bridge chat only, never speech
// ---------------------------------------------------------------------------

const DISCLOSURE_OUTCOMES = ["sent", "unavailable", "failed"] as const;

for (const outcome of DISCLOSURE_OUTCOMES) {
  test(`disclosure outcome "${outcome}" is recorded, and nothing is spoken`, async () => {
    const h = harness();
    try {
      await joined(h);
      assert.equal(h.session.state().disclosure, "pending");

      h.bridge.emit(h.bridge.event({ type: "chat_disclosure", outcome }));
      await h.session.settled();

      assert.equal(h.session.state().disclosure, outcome);
      assert.equal(commandOfType(h.bridge, "post_disclosure")["text"], DISCLOSURE_TEXT);

      // The whole point: the only chat attempt was the bridge's, and the
      // runtime was never asked to say or process anything.
      assert.equal(h.runtime.callsOf("processText").length, 0);
      assert.equal(h.runtime.callsOf("authorizeVoiceResponse").length, 0);
      assert.equal(sentTypes(h.bridge).filter((type) => type === "post_disclosure").length, 1);
    } finally {
      h.cleanup();
    }
  });

  test(`disclosure outcome "${outcome}" never ends the session or stops capture`, async () => {
    const h = harness();
    try {
      await joined(h);
      h.bridge.emit(h.bridge.event({ type: "chat_disclosure", outcome }));
      await h.session.settled();

      assert.equal(h.session.state().phase, "listening");
      assert.equal(h.session.state().terminalReason, null);
      assert.equal(h.session.state().speaking, "enabled");
    } finally {
      h.cleanup();
    }
  });
}

test("a disclosure the transport could not even send never blocks joining", async () => {
  const h = harness();
  try {
    // The third send is post_disclosure; join and connect_media go first.
    await h.session.join();
    assert.deepEqual(sentTypes(h.bridge), ["join", "connect_media", "post_disclosure"]);
  } finally {
    h.cleanup();
  }

  const failing = harness();
  try {
    failing.bridge.failSendOfType("post_disclosure", new Error("synthetic transport failure"));
    await failing.session.join();

    // join() resolved. The session is live, media is connected, the runtime
    // session is open -- only the disclosure is marked failed.
    assert.equal(failing.session.state().disclosure, "failed");
    assert.equal(failing.session.state().terminalReason, null);
    assert.equal(failing.runtime.callsOf("startVoiceSession").length, 1);
    assert.equal(failing.runtime.callsOf("processText").length, 0);
    assert.deepEqual(sentTypes(failing.bridge), ["join", "connect_media"]);
  } finally {
    failing.cleanup();
  }
});

test("the disclosure publisher's module cannot reach the runtime at all", () => {
  // Structural, not stylistic: createDisclosurePublisher is handed ONE
  // capability (issue a BridgeCommand), and src/ports/bridge.ts imports
  // nothing from the runtime port, so there is no branch of the disclosure
  // path from which a spoken disclosure could be synthesized.
  const source = readFileSync(
    path.join(import.meta.dirname, "..", "src", "ports", "bridge.ts"),
    "utf8",
  );
  assert.equal(source.includes("conversation-runtime"), false);
  assert.equal(/\bprocessText\b|\bauthorizeVoiceResponse\b/.test(source), false);
});

// ---------------------------------------------------------------------------
// 3. An audio frame cannot reach the coordinator
// ---------------------------------------------------------------------------

test("the contract declares no frame-carrying member in either direction", () => {
  // Pinned exactly. Adding a member that could carry audio bytes is a failing
  // test here before it is anything else -- which is what makes the property
  // structural rather than a comment.
  assert.deepEqual([...BRIDGE_COMMAND_TYPES], [
    "join",
    "connect_media",
    "post_disclosure",
    "leave",
    "release_lease",
  ]);
  assert.deepEqual([...BRIDGE_EVENT_TYPES], [
    "joined",
    "left",
    "participant_joined",
    "participant_left",
    "active_speaker",
    "audio_gap",
    "chat_disclosure",
    "media_connected",
    "media_disconnected",
    "command_result",
    "reconnecting",
    "reconnected",
  ]);
});

test("a frame-shaped message is rejected at the boundary and never routed", async () => {
  const h = harness();
  try {
    await joined(h);
    const before = h.session.state().routedEventTypes.length;

    h.bridge.emit({
      schema: BRIDGE_SESSION_SCHEMA,
      sessionId: BRIDGE_SESSION_ID,
      sequence: 900,
      observedAt: "2026-09-02T14:20:00Z",
      type: "audio_frame",
      direction: "capture",
      payload: [1, 2, 3, 4],
    });
    await h.session.settled();

    assert.deepEqual(h.session.state().rejectedInbound, [{ code: "unknown_type", path: "/type" }]);
    assert.equal(h.session.state().routedEventTypes.length, before);
  } finally {
    h.cleanup();
  }
});

test("a frame smuggled as an extra field on a known event is rejected whole", async () => {
  const h = harness();
  try {
    await joined(h);
    h.bridge.emit(
      h.bridge.event({
        type: "media_connected",
        endpoint: "udp://127.0.0.1:40001",
        payload: [1, 2, 3, 4],
      }),
    );
    await h.session.settled();

    // Rejected, not partially applied: mediaConnected did NOT flip.
    assert.deepEqual(h.session.state().rejectedInbound, [{ code: "unknown_field", path: "/payload" }]);
    assert.equal(h.session.state().mediaConnected, false);
  } finally {
    h.cleanup();
  }
});

test("every event the session ever routes is a declared contract type", async () => {
  const h = harness();
  try {
    await joined(h);
    for (const payload of [
      { type: "media_connected", endpoint: "udp://127.0.0.1:40001" },
      { type: "participant_joined", feishuUserId: "ou_synthetic_1", displayName: "Synthetic One" },
      { type: "active_speaker", feishuUserId: "ou_synthetic_1", confidence: "ui_exact" },
      { type: "active_speaker", feishuUserId: null, confidence: "ambiguous" },
      { type: "audio_gap", direction: "capture", startedAt: "2026-09-02T14:10:00Z", endedAt: null },
      { type: "reconnecting", attempt: 1 },
      { type: "reconnected", attempt: 1 },
      { type: "media_disconnected", reason: "peer_reset" },
      { type: "participant_left", feishuUserId: "ou_synthetic_1" },
    ]) {
      h.bridge.emit(h.bridge.event(payload));
    }
    await h.session.settled();

    for (const type of h.session.state().routedEventTypes) {
      assert.ok(
        BRIDGE_EVENT_TYPES.includes(type),
        `the session routed "${type}", which the contract does not declare`,
      );
    }
    assert.equal(h.session.state().rejectedInbound.length, 0);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. connect_media: the runtime-issued descriptor, verbatim
// ---------------------------------------------------------------------------

test("connect_media carries the runtime's media descriptor verbatim", async () => {
  const h = harness();
  try {
    await h.session.join();
    const command = commandOfType(h.bridge, "connect_media");
    assert.equal(command["endpoint"], "udp://127.0.0.1:40001");
    assert.equal(command["sessionToken"], "synthetic-media-token-not-a-secret");
    assert.equal(command["format"], "pcm_s16le/48000/1/20ms");
    assert.equal(command["expiresAt"], "2026-09-02T15:00:00Z");
  } finally {
    h.cleanup();
  }
});

test("a media descriptor the bridge could not parse never leaves the coordinator", async () => {
  // The obsolete three-part form. The contract validator refuses it, so the
  // command is never handed to the transport at all, and the session fails
  // closed rather than opening a media socket the bridge can only reject.
  const h = harness({
    runtime: fakeRuntime({ handle: { media: {
      endpoint: "udp://127.0.0.1:40001",
      sessionToken: "synthetic-media-token-not-a-secret",
      format: "opus/48000/2",
      expiresAt: "2026-09-02T15:00:00Z",
    } } }),
  });
  try {
    await assert.rejects(() => h.session.join(), /media_format/);
    assert.deepEqual(sentTypes(h.bridge), ["join"]);
    assert.equal(h.session.state().terminalReason, "media_format_rejected");
    assert.equal(h.coordinator.get(IDENTITY.occurrenceId)?.state, "failed");
  } finally {
    h.cleanup();
  }
});

test("media_connected and command_result are both consumed and correlated", async () => {
  const h = harness();
  try {
    await joined(h);
    const connectMedia = commandOfType(h.bridge, "connect_media");

    h.bridge.emit(h.bridge.event({ type: "media_connected", endpoint: "udp://127.0.0.1:40001" }));
    h.bridge.emit(
      h.bridge.event({
        type: "command_result",
        commandId: connectMedia["commandId"],
        outcome: "ok",
        detail: null,
      }),
    );
    await h.session.settled();

    assert.equal(h.session.state().mediaConnected, true);
    assert.deepEqual(h.session.state().commandResults, [
      {
        commandId: connectMedia["commandId"],
        commandType: "connect_media",
        outcome: "ok",
        detail: null,
      },
    ]);
  } finally {
    h.cleanup();
  }
});

test("a rejected connect_media command aborts speaking but not capture", async () => {
  const h = harness();
  try {
    await joined(h);
    const connectMedia = commandOfType(h.bridge, "connect_media");
    h.bridge.emit(
      h.bridge.event({
        type: "command_result",
        commandId: connectMedia["commandId"],
        outcome: "rejected",
        detail: "unsupported_format",
      }),
    );
    await h.session.settled();

    assert.equal(h.session.state().speaking, "aborted");
    assert.equal(h.session.state().speakingAbortReason, "media_command_rejected");
    assert.equal(h.session.state().phase, "listening");
  } finally {
    h.cleanup();
  }
});

test("a command_result for a command this session never issued is rejected", async () => {
  const h = harness();
  try {
    await joined(h);
    h.bridge.emit(
      h.bridge.event({ type: "command_result", commandId: "cmd_never_issued", outcome: "ok", detail: null }),
    );
    await h.session.settled();

    assert.deepEqual(h.session.state().rejectedInbound, [
      { code: "unknown_command_id", path: "/commandId" },
    ]);
    assert.equal(h.session.state().commandResults.length, 0);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. Turns: skip, authorization, barge-in, provider outage
// ---------------------------------------------------------------------------

test("a normal transcript is skipped: the runtime is TOLD to stay silent", async () => {
  const h = harness();
  try {
    await joined(h);
    h.runtime.emit(transcript("seg-1", "So the migration lands on Thursday."));
    await h.session.settled();

    assert.equal(h.runtime.callsOf("authorizeVoiceResponse").length, 0);
    assert.deepEqual(h.runtime.callsOf("skipVoiceResponse"), [
      { method: "skipVoiceResponse", segmentId: "seg-1", reason: "no_alias_match" },
    ]);
    assert.deepEqual(h.session.turns(), [
      { segmentId: "seg-1", outcome: "skipped", detail: "no_alias_match", atMs: BASE_MS },
    ]);
  } finally {
    h.cleanup();
  }
});

test("a mention that is not an address is skipped with the gate's own reason", async () => {
  const h = harness();
  try {
    await joined(h);
    h.runtime.emit(transcript("seg-1", "I asked Meetbot about it yesterday."));
    await h.session.settled();
    assert.deepEqual(h.runtime.callsOf("skipVoiceResponse"), [
      { method: "skipVoiceResponse", segmentId: "seg-1", reason: "incidental_mention" },
    ]);
  } finally {
    h.cleanup();
  }
});

test("a named invocation authorizes, and the turn stays open until the runtime answers", async () => {
  const h = harness();
  try {
    await joined(h);
    h.runtime.emit(transcript("seg-1", "Meetbot, can you summarize that?"));
    await h.session.settled();

    assert.deepEqual(h.runtime.callsOf("authorizeVoiceResponse"), [
      { method: "authorizeVoiceResponse", segmentId: "seg-1" },
    ]);
    assert.equal(h.runtime.callsOf("skipVoiceResponse").length, 0);
    assert.deepEqual(h.session.turns(), [], "the turn is not terminal until the runtime says so");

    h.runtime.emit({ type: "response_authorized", segmentId: "seg-1" });
    await h.session.settled();
    assert.deepEqual(h.session.turns(), [
      { segmentId: "seg-1", outcome: "spoken", detail: null, atMs: BASE_MS },
    ]);
  } finally {
    h.cleanup();
  }
});

test("barge-in ends the turn as barged_in, not spoken", async () => {
  const h = harness();
  try {
    await joined(h);
    h.runtime.emit(transcript("seg-1", "Meetbot, can you summarize that?"));
    await h.session.settled();

    h.runtime.emit({ type: "barge_in", segmentId: "seg-1" });
    await h.session.settled();

    assert.deepEqual(h.session.turns(), [
      { segmentId: "seg-1", outcome: "barged_in", detail: null, atMs: BASE_MS },
    ]);
    assert.equal(h.session.state().speaking, "enabled", "barge-in ends a turn, not the session");
  } finally {
    h.cleanup();
  }
});

test("the runtime's own response_skipped ends the turn as skipped", async () => {
  const h = harness();
  try {
    await joined(h);
    h.runtime.emit(transcript("seg-1", "Meetbot, can you summarize that?"));
    await h.session.settled();
    h.runtime.emit({ type: "response_skipped", segmentId: "seg-1", reason: "no_response_needed" });
    await h.session.settled();

    assert.deepEqual(h.session.turns(), [
      { segmentId: "seg-1", outcome: "skipped", detail: "no_response_needed", atMs: BASE_MS },
    ]);
  } finally {
    h.cleanup();
  }
});

test("a provider outage fails every open turn and aborts speaking, leaving capture running", async () => {
  const h = harness();
  try {
    await joined(h);
    h.runtime.emit(transcript("seg-1", "Meetbot, can you summarize that?"));
    h.runtime.emit(transcript("seg-2", "Meetbot, what did we decide?"));
    await h.session.settled();
    assert.deepEqual(h.session.turns(), []);

    h.runtime.emit({ type: "provider_unavailable", detail: "upstream_5xx" });
    await h.session.settled();

    assert.deepEqual(h.session.turns(), [
      { segmentId: "seg-1", outcome: "failed", detail: "provider_unavailable", atMs: BASE_MS },
      { segmentId: "seg-2", outcome: "failed", detail: "provider_unavailable", atMs: BASE_MS },
    ]);
    assert.equal(h.session.state().speaking, "aborted");
    assert.equal(h.session.state().speakingAbortReason, "provider_unavailable");

    // Capture is untouched: the session is still listening and still recording.
    assert.equal(h.session.state().phase, "listening");
    h.bridge.emit(
      h.bridge.event({
        type: "audio_gap",
        direction: "capture",
        startedAt: "2026-09-02T14:30:00Z",
        endedAt: "2026-09-02T14:30:01Z",
      }),
    );
    await h.session.settled();
    assert.equal(h.session.state().observedGaps.length, 1);

    // And every later segment is skipped, never authorized.
    h.runtime.emit(transcript("seg-3", "Meetbot, can you summarize that?"));
    await h.session.settled();
    assert.equal(h.runtime.callsOf("authorizeVoiceResponse").length, 2, "no new authorization");
    assert.deepEqual(h.session.turns().at(-1), {
      segmentId: "seg-3",
      outcome: "skipped",
      detail: "speaking_aborted",
      atMs: BASE_MS,
    });
  } finally {
    h.cleanup();
  }
});

test("a non-final segment authorizes nothing, whatever it contains", async () => {
  const h = harness();
  try {
    await joined(h);
    h.runtime.emit(transcript("seg-1", "Meetbot, can you summarize that?", false));
    await h.session.settled();

    assert.equal(h.runtime.callsOf("authorizeVoiceResponse").length, 0);
    assert.deepEqual(h.runtime.callsOf("skipVoiceResponse"), [
      { method: "skipVoiceResponse", segmentId: "seg-1", reason: "non_final_segment" },
    ]);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6. Exactly one terminal event per turn, under races
// ---------------------------------------------------------------------------

const RACE_ORDERS: ReadonlyArray<readonly string[]> = [
  ["response_authorized", "barge_in", "response_skipped", "provider_unavailable"],
  ["barge_in", "response_authorized", "provider_unavailable", "response_skipped"],
  ["provider_unavailable", "response_authorized", "barge_in", "response_skipped"],
  ["response_skipped", "response_skipped", "response_authorized", "barge_in"],
];

for (const [index, order] of RACE_ORDERS.entries()) {
  test(`race ${index + 1}: every terminal signal at once yields exactly ONE turn record`, async () => {
    const h = harness();
    try {
      await joined(h);
      h.runtime.emit(transcript("seg-1", "Meetbot, can you summarize that?"));
      await h.session.settled();

      // Emitted synchronously, before the pump gets a chance to run between
      // them: all four are in the queue at the same time.
      for (const type of order) {
        if (type === "provider_unavailable") {
          h.runtime.emit({ type, detail: "upstream_5xx" });
        } else if (type === "response_skipped") {
          h.runtime.emit({ type, segmentId: "seg-1", reason: "no_response_needed" });
        } else if (type === "response_authorized" || type === "barge_in") {
          h.runtime.emit({ type, segmentId: "seg-1" });
        }
      }
      await h.session.settled();

      const forSegment = h.session.turns().filter((turn) => turn.segmentId === "seg-1");
      assert.equal(
        forSegment.length,
        1,
        `expected one terminal event, got ${JSON.stringify(forSegment)}`,
      );
      // And the winner is the first signal in the queue, deterministically.
      const expected =
        order[0] === "response_authorized"
          ? "spoken"
          : order[0] === "barge_in"
            ? "barged_in"
            : order[0] === "provider_unavailable"
              ? "failed"
              : "skipped";
      assert.equal(forSegment[0]?.outcome, expected);
    } finally {
      h.cleanup();
    }
  });
}

test("a redelivered finalized segment neither re-authorizes nor produces a second turn", async () => {
  const h = harness();
  try {
    await joined(h);
    h.runtime.emit(transcript("seg-1", "Meetbot, can you summarize that?"));
    h.runtime.emit(transcript("seg-1", "Meetbot, can you summarize that?"));
    h.runtime.emit(transcript("seg-1", "Meetbot, can you summarize that?"));
    await h.session.settled();

    assert.equal(h.runtime.callsOf("authorizeVoiceResponse").length, 1);

    h.runtime.emit({ type: "response_authorized", segmentId: "seg-1" });
    h.runtime.emit({ type: "response_authorized", segmentId: "seg-1" });
    await h.session.settled();

    assert.equal(h.session.turns().length, 1);
  } finally {
    h.cleanup();
  }
});

test("a terminal signal for a segment that was skipped does not add a second turn", async () => {
  const h = harness();
  try {
    await joined(h);
    h.runtime.emit(transcript("seg-1", "Nothing to see here."));
    await h.session.settled();
    assert.equal(h.session.turns().length, 1);

    h.runtime.emit({ type: "response_authorized", segmentId: "seg-1" });
    h.runtime.emit({ type: "barge_in", segmentId: "seg-1" });
    await h.session.settled();

    assert.deepEqual(h.session.turns(), [
      { segmentId: "seg-1", outcome: "skipped", detail: "no_alias_match", atMs: BASE_MS },
    ]);
  } finally {
    h.cleanup();
  }
});

test("the session end settles every still-open turn exactly once", async () => {
  const h = harness();
  try {
    await joined(h);
    h.runtime.emit(transcript("seg-1", "Meetbot, can you summarize that?"));
    h.runtime.emit(transcript("seg-2", "Meetbot, what did we decide?"));
    await h.session.settled();
    assert.deepEqual(h.session.turns(), []);

    h.bridge.emit(h.bridge.event({ type: "left", reason: "ended" }));
    await h.session.settled();

    assert.deepEqual(h.session.turns(), [
      { segmentId: "seg-1", outcome: "failed", detail: "session_ended", atMs: BASE_MS },
      { segmentId: "seg-2", outcome: "failed", detail: "session_ended", atMs: BASE_MS },
    ]);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 7. Bridge reconnect
// ---------------------------------------------------------------------------

test("reconnecting/reconnected is survivable: the session neither ends nor loses its lease", async () => {
  const h = harness();
  try {
    await joined(h);
    const leaseBefore = h.coordinator.activeBridgeLease(IDENTITY.occurrenceId);

    h.bridge.emit(h.bridge.event({ type: "reconnecting", attempt: 1 }));
    await h.session.settled();
    assert.equal(h.session.state().bridgeConnected, false);
    assert.equal(h.session.state().reconnectAttempts, 1);
    assert.equal(h.session.state().phase, "listening");

    h.bridge.emit(h.bridge.event({ type: "reconnected", attempt: 1 }));
    await h.session.settled();
    assert.equal(h.session.state().bridgeConnected, true);
    assert.equal(h.session.state().phase, "listening");

    const leaseAfter = h.coordinator.activeBridgeLease(IDENTITY.occurrenceId);
    assert.equal(leaseAfter?.leaseId, leaseBefore?.leaseId, "a reconnect is not a new lease");
  } finally {
    h.cleanup();
  }
});

test("a segment arriving mid-reconnect is still gated normally", async () => {
  const h = harness();
  try {
    await joined(h);
    h.bridge.emit(h.bridge.event({ type: "reconnecting", attempt: 2 }));
    await h.session.settled();

    h.runtime.emit(transcript("seg-1", "Meetbot, can you summarize that?"));
    await h.session.settled();
    assert.equal(h.runtime.callsOf("authorizeVoiceResponse").length, 1);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 8. A `left` is terminal -- including bridge_failure
// ---------------------------------------------------------------------------

const LEFT_REASONS = ["ended", "removed", "bridge_failure"] as const;

for (const reason of LEFT_REASONS) {
  test(`left(reason: "${reason}") is terminal for the session`, async () => {
    const h = harness();
    try {
      await joined(h);
      h.bridge.emit(h.bridge.event({ type: "left", reason }));
      await h.session.settled();

      assert.equal(h.session.state().phase, "ended");
      assert.equal(h.session.state().terminalReason, reason);
      assert.equal(h.coordinator.activeBridgeLease(IDENTITY.occurrenceId), null);
    } finally {
      h.cleanup();
    }
  });

  test(`left(reason: "${reason}") releases the lease with the matching reason`, async () => {
    const h = harness();
    try {
      await joined(h);
      h.bridge.emit(h.bridge.event({ type: "left", reason }));
      await h.session.settled();

      const leases = h.store.listLeases(IDENTITY.occurrenceId);
      assert.equal(leases.length, 1);
      assert.equal(leases[0]?.releaseReason, reason === "bridge_failure" ? "bridge_failure" : "left");
    } finally {
      h.cleanup();
    }
  });

  test(`after left(reason: "${reason}") the session is structurally deaf, not merely quiet`, async () => {
    const h = harness();
    try {
      await joined(h);
      h.bridge.emit(h.bridge.event({ type: "left", reason }));
      await h.session.settled();
      const routedAfterLeft = h.session.state().routedEventTypes.length;

      // Terminal unsubscribes both planes, so a later event is not ignored --
      // it is never delivered at all. That is the stronger property, and the
      // one that also rules out a leaked subscription outliving the session.
      assert.equal(h.bridge.subscriberCount(), 0);
      assert.equal(h.runtime.subscriberCount(), 0);

      h.bridge.emit(h.bridge.event({ type: "joined", meetingOccurrenceId: IDENTITY.occurrenceId }));
      h.bridge.emit(h.bridge.event({ type: "media_connected", endpoint: "udp://127.0.0.1:40001" }));
      h.runtime.emit(transcript("seg-1", "Meetbot, can you summarize that?"));
      await h.session.settled();

      assert.equal(h.session.state().routedEventTypes.length, routedAfterLeft);
      assert.equal(h.session.state().phase, "ended");
      assert.equal(h.runtime.callsOf("authorizeVoiceResponse").length, 0);
    } finally {
      h.cleanup();
    }
  });

  test(`events already queued when left(reason: "${reason}") arrives are counted, not acted on`, async () => {
    const h = harness();
    try {
      await joined(h);

      // All four land in the queue in one synchronous burst, so the three
      // after `left` are already inside the session when it goes terminal --
      // the one window where unsubscribing cannot help.
      h.bridge.emit(h.bridge.event({ type: "left", reason }));
      h.bridge.emit(h.bridge.event({ type: "media_connected", endpoint: "udp://127.0.0.1:40001" }));
      h.bridge.emit(
        h.bridge.event({
          type: "audio_gap",
          direction: "capture",
          startedAt: "2026-09-02T14:10:00Z",
          endedAt: null,
        }),
      );
      h.runtime.emit(transcript("seg-1", "Meetbot, can you summarize that?"));
      await h.session.settled();

      assert.equal(h.session.state().ignoredAfterTerminal, 3);
      assert.equal(h.session.state().mediaConnected, false);
      assert.deepEqual(h.session.state().observedGaps, []);
      assert.equal(h.runtime.callsOf("authorizeVoiceResponse").length, 0);
    } finally {
      h.cleanup();
    }
  });

  test(`left(reason: "${reason}") offers no re-open: join() is refused afterwards`, async () => {
    const h = harness();
    try {
      await joined(h);
      h.bridge.emit(h.bridge.event({ type: "left", reason }));
      await h.session.settled();

      await assert.rejects(() => h.session.join(), /terminal|already/i);
    } finally {
      h.cleanup();
    }
  });
}

test("an explicit leave asks the bridge, and the bridge's left is what ends the session", async () => {
  const h = harness();
  try {
    await joined(h);
    await h.session.leave("coordinator_stop");

    assert.equal(sentTypes(h.bridge).at(-1), "leave");
    assert.equal(h.session.state().phase, "listening", "the session ends on `left`, not on asking");

    h.bridge.emit(h.bridge.event({ type: "left", reason: "ended" }));
    await h.session.settled();
    assert.equal(h.session.state().phase, "ended");
  } finally {
    h.cleanup();
  }
});

test("the coordinator reaches finalizing on a clean end and failed on a bridge failure", async () => {
  const clean = harness();
  try {
    await joined(clean);
    clean.bridge.emit(clean.bridge.event({ type: "left", reason: "ended" }));
    await clean.session.settled();
    assert.equal(clean.coordinator.get(IDENTITY.occurrenceId)?.state, "finalizing");
  } finally {
    clean.cleanup();
  }

  const broken = harness();
  try {
    await joined(broken);
    broken.bridge.emit(broken.bridge.event({ type: "left", reason: "bridge_failure" }));
    await broken.session.settled();
    const row = broken.coordinator.get(IDENTITY.occurrenceId);
    assert.equal(row?.state, "failed");
    assert.equal(row?.terminalReason, "bridge_failure");
  } finally {
    broken.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 9. Exact gap recording and finalization
// ---------------------------------------------------------------------------

const GAPS = [
  { direction: "capture", startedAt: "2026-09-02T14:10:00Z", endedAt: "2026-09-02T14:10:02Z" },
  { direction: "playback", startedAt: "2026-09-02T14:20:00Z", endedAt: null },
  { direction: "capture", startedAt: "2026-09-02T14:30:00Z", endedAt: "2026-09-02T14:30:00Z" },
] as const;

test("gaps are recorded exactly as observed: same order, unmerged, endedAt null preserved", async () => {
  const h = harness();
  try {
    await joined(h);
    for (const gap of GAPS) h.bridge.emit(h.bridge.event({ type: "audio_gap", ...gap }));
    await h.session.settled();

    assert.deepEqual(h.session.state().observedGaps, GAPS);

    h.bridge.emit(h.bridge.event({ type: "left", reason: "ended" }));
    await h.session.settled();

    assert.deepEqual(h.runtime.callsOf("finalizeRecording"), [
      { method: "finalizeRecording", observedGaps: GAPS },
    ]);
    assert.deepEqual(h.session.state().recording?.gaps, GAPS);
    assert.equal(h.session.state().gapReconciliation, "not_needed");
  } finally {
    h.cleanup();
  }
});

test("session end stores the finalized handle, hash, duration and gaps", async () => {
  const h = harness();
  try {
    await joined(h);
    h.bridge.emit(h.bridge.event({ type: "left", reason: "ended" }));
    await h.session.settled();

    assert.deepEqual(h.session.state().recording, {
      handle: "rec_synthetic_0001",
      sha256: "0".repeat(64),
      durationMs: 3_600_000,
      gaps: [],
    });
  } finally {
    h.cleanup();
  }
});

test("a runtime whose gap accounting disagrees with the bridge is reconciled against the bridge", async () => {
  const h = harness({ runtime: fakeRuntime({ finalizedGaps: [] }) });
  try {
    await joined(h);
    for (const gap of GAPS) h.bridge.emit(h.bridge.event({ type: "audio_gap", ...gap }));
    await h.session.settled();

    h.bridge.emit(h.bridge.event({ type: "left", reason: "ended" }));
    await h.session.settled();

    assert.deepEqual(h.runtime.callsOf("reconcileRecording"), [
      { method: "reconcileRecording", gaps: GAPS },
    ]);
    assert.deepEqual(h.session.state().recording?.gaps, GAPS);
    assert.equal(h.session.state().gapReconciliation, "reconciled");
  } finally {
    h.cleanup();
  }
});

test("finalizeRecording runs exactly once, however many terminal signals arrive", async () => {
  const h = harness();
  try {
    await joined(h);
    h.bridge.emit(h.bridge.event({ type: "left", reason: "ended" }));
    h.bridge.emit(h.bridge.event({ type: "left", reason: "removed" }));
    await h.session.settled();
    await h.session.leave("coordinator_stop");
    await h.session.settled();

    assert.equal(h.runtime.callsOf("finalizeRecording").length, 1);
    assert.equal(h.session.state().terminalReason, "ended");
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 10. Bounded queues and per-session cancellation
// ---------------------------------------------------------------------------

test("queue overflow is observable and aborts speaking; it is never a silent drop", async () => {
  const h = harness({ maxQueuedEvents: 4 });
  try {
    await joined(h);

    // Nine events, delivered synchronously, into a queue bounded at four.
    for (let i = 0; i < 9; i += 1) {
      h.bridge.emit(
        h.bridge.event({
          type: "audio_gap",
          direction: "capture",
          startedAt: "2026-09-02T14:10:00Z",
          endedAt: null,
        }),
      );
    }
    await h.session.settled();

    const overflows = h.session.state().overflows;
    assert.ok(overflows.length > 0, "an overflow must be recorded, not swallowed");
    assert.equal(
      overflows.length + h.session.state().observedGaps.length,
      9,
      "every delivered event is either processed or recorded as dropped",
    );
    for (const overflow of overflows) {
      assert.equal(overflow.source, "bridge");
      assert.equal(overflow.queueDepth, 4);
    }
    assert.equal(h.session.state().speaking, "aborted");
    assert.equal(h.session.state().speakingAbortReason, "queue_overflow");
  } finally {
    h.cleanup();
  }
});

test("the queue bound is per session, and the default admits an ordinary meeting's traffic", async () => {
  const h = harness();
  try {
    await joined(h);
    assert.equal(h.session.state().maxQueuedEvents, 256);
    for (let i = 0; i < 200; i += 1) {
      h.bridge.emit(
        h.bridge.event({
          type: "audio_gap",
          direction: "capture",
          startedAt: "2026-09-02T14:10:00Z",
          endedAt: null,
        }),
      );
    }
    await h.session.settled();
    assert.deepEqual(h.session.state().overflows, []);
    assert.equal(h.session.state().observedGaps.length, 200);
    assert.equal(h.session.state().speaking, "enabled");
  } finally {
    h.cleanup();
  }
});

test("dispose cancels the session: subscriptions drop and later events do nothing", async () => {
  const h = harness();
  try {
    await joined(h);
    assert.equal(h.bridge.subscriberCount(), 1);
    assert.equal(h.runtime.subscriberCount(), 1);

    h.session.dispose();
    assert.equal(h.bridge.subscriberCount(), 0);
    assert.equal(h.runtime.subscriberCount(), 0);

    const routed = h.session.state().routedEventTypes.length;
    h.bridge.emit(h.bridge.event({ type: "media_connected", endpoint: "udp://127.0.0.1:40001" }));
    h.runtime.emit(transcript("seg-1", "Meetbot, can you summarize that?"));
    await h.session.settled();

    assert.equal(h.session.state().routedEventTypes.length, routed);
    assert.equal(h.runtime.callsOf("authorizeVoiceResponse").length, 0);
  } finally {
    h.cleanup();
  }
});

test("dispose is idempotent and safe before join", () => {
  const h = harness();
  try {
    h.session.dispose();
    h.session.dispose();
    assert.equal(h.session.state().phase, "created");
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 11. The invocation sink adapter
// ---------------------------------------------------------------------------

test("the runtime invocation sink forwards the gate's decision under the gate's segmentId", async () => {
  const runtime = fakeRuntime();
  const errors: Array<{ segmentId: string; error: unknown }> = [];
  const sink = createRuntimeInvocationSink(runtime, (segmentId, error) => {
    errors.push({ segmentId, error });
  });

  sink.skipVoiceResponse("seg-1", "incidental_mention");
  sink.authorizeVoiceResponse("seg-2", "Meetbot");
  await Promise.resolve();

  assert.deepEqual(runtime.calls, [
    { method: "skipVoiceResponse", segmentId: "seg-1", reason: "incidental_mention" },
    { method: "authorizeVoiceResponse", segmentId: "seg-2" },
  ]);
  assert.deepEqual(errors, []);
});

test("a runtime that cannot be told to stay silent surfaces the failure rather than swallowing it", async () => {
  const boom = new Error("synthetic runtime failure");
  const errors: Array<{ segmentId: string; error: unknown }> = [];
  const sink = createRuntimeInvocationSink(
    {
      authorizeVoiceResponse: async () => {
        throw boom;
      },
      skipVoiceResponse: async () => {
        throw boom;
      },
    },
    (segmentId, error) => {
      errors.push({ segmentId, error });
    },
  );

  sink.skipVoiceResponse("seg-1", "no_alias_match");
  sink.authorizeVoiceResponse("seg-2", "Meetbot");
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(errors, [
    { segmentId: "seg-1", error: boom },
    { segmentId: "seg-2", error: boom },
  ]);
});

test("a runtime call that fails inside the session is recorded, and the session keeps capturing", async () => {
  const runtime = fakeRuntime();
  const boom = new Error("synthetic runtime failure");
  runtime.authorizeVoiceResponse = async () => {
    throw boom;
  };
  const h = harness({ runtime });
  try {
    await joined(h);
    h.runtime.emit(transcript("seg-1", "Meetbot, can you summarize that?"));
    await h.session.settled();
    await Promise.resolve();

    assert.equal(h.session.state().runtimeErrors.length, 1);
    assert.equal(h.session.state().runtimeErrors[0]?.segmentId, "seg-1");
    assert.equal(h.session.state().phase, "listening");
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 12. The event loop survives a bad event
//
// Found in this task's own self-review, not by the brief. Every handler runs
// inside one shared pump. A handler that throws -- and the coordinator throws
// by design, on any transition its graph does not allow -- would escape as an
// unhandled rejection, killing the drain for every later event and taking the
// process with it under Node's default. One malformed or duplicated event must
// cost that event, never the meeting.
// ---------------------------------------------------------------------------

test("a duplicate joined event is recorded as a routing error, not thrown", async () => {
  const h = harness();
  try {
    await joined(h);
    h.bridge.emit(h.bridge.event({ type: "joined", meetingOccurrenceId: IDENTITY.occurrenceId }));
    await h.session.settled();

    // "listening" -> "listening" is not a legal edge; the coordinator refuses
    // it, and that refusal is captured instead of escaping.
    assert.equal(h.session.state().routingErrors.length, 1);
    assert.equal(h.session.state().routingErrors[0]?.source, "bridge");
    assert.equal(h.session.state().phase, "listening");
  } finally {
    h.cleanup();
  }
});

test("the pump keeps draining after a handler throws", async () => {
  const h = harness();
  try {
    await joined(h);
    h.bridge.emit(h.bridge.event({ type: "joined", meetingOccurrenceId: IDENTITY.occurrenceId }));
    h.bridge.emit(h.bridge.event({ type: "media_connected", endpoint: "udp://127.0.0.1:40001" }));
    h.runtime.emit(transcript("seg-1", "Meetbot, can you summarize that?"));
    await h.session.settled();

    assert.equal(h.session.state().routingErrors.length, 1);
    assert.equal(h.session.state().mediaConnected, true, "the next event still ran");
    assert.equal(h.runtime.callsOf("authorizeVoiceResponse").length, 1);
  } finally {
    h.cleanup();
  }
});

test("a left before the session ever listened still ends it and fails the coordinator", async () => {
  const h = harness();
  try {
    // join(), but no `joined` event: the coordinator is still in "joining".
    await h.session.join();
    assert.equal(h.coordinator.get(IDENTITY.occurrenceId)?.state, "joining");

    h.bridge.emit(h.bridge.event({ type: "left", reason: "ended" }));
    await h.session.settled();

    assert.equal(h.session.state().phase, "ended");
    assert.equal(h.session.state().terminalReason, "ended");
    // "joining" -> "finalizing" is not a legal edge, so the session must not
    // leave the coordinator stranded mid-join: it fails it with the reason the
    // bridge gave.
    const row = h.coordinator.get(IDENTITY.occurrenceId);
    assert.equal(row?.state, "failed");
    assert.equal(row?.terminalReason, "ended");
    assert.deepEqual(h.session.state().routingErrors, []);
    assert.ok(h.session.state().recording !== null);
  } finally {
    h.cleanup();
  }
});

test("a finalization failure is recorded and never escapes the pump", async () => {
  const runtime = fakeRuntime();
  runtime.finalizeRecording = async () => {
    throw new Error("synthetic finalization failure");
  };
  const h = harness({ runtime });
  try {
    await joined(h);
    h.bridge.emit(h.bridge.event({ type: "left", reason: "ended" }));
    await h.session.settled();

    assert.equal(h.session.state().phase, "ended");
    assert.equal(h.session.state().recording, null);
    assert.equal(h.session.state().routingErrors.length, 1);
  } finally {
    h.cleanup();
  }
});
