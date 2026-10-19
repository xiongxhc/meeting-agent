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
// has no package dependency: the SDK boundary is structural and the local
// fake injects the Task 11-unresolved start result. Every
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
import { createRetrievalRouter, type RetrievalRouter } from "../src/sessions/retrieval-router.ts";
import { collectImports } from "./lib/import-scanner.ts";
import type { SessionStore } from "../src/ports/session-store.ts";
import type {
  KnowledgeHit,
  TeamVaultIndexPort,
  TeamVaultSearchResult,
} from "../src/ports/knowledge.ts";
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
  readonly dbPath: string;
  readonly bridge: FakeBridge;
  readonly runtime: FakeRuntime;
  readonly coordinator: SessionCoordinator;
  readonly store: SessionStore;
  readonly session: MeetingSession;
  cleanup(): Promise<void>;
};

type HarnessOptions = {
  readonly runtime?: FakeRuntime;
  readonly maxQueuedEvents?: number;
  /** Test/advanced-caller override, threaded straight to
   * CreateMeetingSessionOptions.retrieval -- see meeting-session.ts. Used
   * by the retrieval-wiring suite to inject a router built against a
   * call-tracking fake Team Vault index. */
  readonly retrieval?: RetrievalRouter;
};

function harness(options: HarnessOptions = {}): Harness {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-agent-session-"));
  const dbPath = path.join(dir, "orchestration.db");
  const store = openSessionStore({ filename: dbPath, nowMs: BASE_MS });
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
    ...(options.retrieval === undefined ? {} : { retrieval: options.retrieval }),
  });

  return {
    dbPath,
    bridge,
    runtime,
    coordinator,
    store,
    session,
    async cleanup() {
      await session.dispose();
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

/** A call-tracking Team Vault index fake, for the retrieval-wiring suite --
 * the whole point of those tests is to assert on whether the SESSION ever
 * reaches this fake, not merely that an answer came back right. */
function fakeVaultIndex(respond: () => readonly KnowledgeHit[]): TeamVaultIndexPort & {
  readonly calls: number;
} {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    search(): TeamVaultSearchResult {
      calls += 1;
      return { hits: respond(), indexedRevision: "synthetic-rev-0001", stale: false };
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
        profile: "online",
        responseMode: "external_gate",
      },
    });
    assert.equal(h.session.state().speaking, "enabled");
    assert.equal(h.session.state().runtimeSessionId, 17n);
  } finally {
    await h.cleanup();
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
    await h.cleanup();
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
    await h.cleanup();
  }
});

test("a joined event advances the coordinator to listening", async () => {
  const h = harness();
  try {
    await joined(h);
    assert.equal(h.session.state().phase, "listening");
    assert.equal(h.coordinator.get(IDENTITY.occurrenceId)?.state, "listening");
  } finally {
    await h.cleanup();
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
    handle: { responseMode: "automatic" },
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
      await h.cleanup();
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
      await h.cleanup();
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
        { method: "skipVoiceResponse", input: { sessionId: 17n, segmentId: "seg-1", reason: "speaking_aborted" } },
      ]);
      assert.deepEqual(h.session.turns(), [
        { segmentId: "seg-1", outcome: "skipped", detail: "speaking_aborted", atMs: BASE_MS },
      ]);
    } finally {
      await h.cleanup();
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
      await h.cleanup();
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
      await h.cleanup();
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
    await h.cleanup();
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
    await failing.cleanup();
  }
});

/** Every module reachable from `entry` by following relative import
 * specifiers, plus every non-relative specifier any of them names. Built from
 * the AST-based scanner test/boundaries.test.ts already uses, so it sees
 * import/export-from/import=/literal dynamic import alike.
 *
 * Review round 1: the earlier version of the test below text-scanned
 * src/ports/bridge.ts alone, so an INDIRECT import of the runtime port would
 * have passed it. */
function reachableFrom(entry: string): { files: Set<string>; external: Set<string> } {
  const bySource = new Map<string, string[]>();
  for (const { file, specifier } of collectImports(path.join(import.meta.dirname, "..", "src"))) {
    const list = bySource.get(file) ?? [];
    list.push(specifier);
    bySource.set(file, list);
  }

  const files = new Set<string>();
  const external = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop();
    if (file === undefined || files.has(file)) continue;
    files.add(file);
    for (const specifier of bySource.get(file) ?? []) {
      if (specifier.startsWith(".")) {
        stack.push(path.resolve(path.dirname(file), specifier));
      } else {
        external.add(specifier);
      }
    }
  }
  return { files, external };
}

test("the disclosure publisher's module cannot reach the runtime, even indirectly", () => {
  // Structural, not stylistic: createDisclosurePublisher is handed ONE
  // capability (issue a BridgeCommand), and the runtime is not in scope for
  // any branch of the disclosure path to call.
  //
  // Asserted over the TRANSITIVE import set, not one file's text, so adding
  // the runtime port two hops away fails this too.
  const entry = path.join(import.meta.dirname, "..", "src", "ports", "bridge.ts");
  const { files, external } = reachableFrom(entry);

  assert.ok(files.size >= 2, "the entry must actually resolve its own imports");
  for (const file of files) {
    assert.equal(
      file.includes("conversation-runtime"),
      false,
      `${file} is reachable from src/ports/bridge.ts`,
    );
    const source = readFileSync(file, "utf8");
    assert.equal(
      /\bprocessText\b|\bauthorizeVoiceResponse\b/.test(source),
      false,
      `${file} names a runtime speech method and is reachable from the disclosure path`,
    );
  }
  for (const specifier of external) {
    assert.equal(specifier.includes("conversation"), false, `external import ${specifier}`);
  }
});

test("the transitive reachability check has teeth", () => {
  // Negative control for the test above: the same walk from the meeting
  // session -- which legitimately DOES depend on the runtime port -- must find
  // it. Without this, `reachableFrom` returning an empty set would make the
  // real assertion vacuous.
  const { files } = reachableFrom(
    path.join(import.meta.dirname, "..", "src", "sessions", "meeting-session.ts"),
  );
  assert.ok(
    [...files].some((file) => file.includes("conversation-runtime")),
    "the walk must actually follow imports",
  );
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
    await h.cleanup();
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
    await h.cleanup();
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
    await h.cleanup();
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
    await h.cleanup();
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
    assert.deepEqual(sentTypes(h.bridge), ["join", "leave"]);
    assert.equal(h.session.state().terminalReason, "media_format_rejected");
    assert.equal(h.coordinator.get(IDENTITY.occurrenceId)?.state, "failed");
  } finally {
    await h.cleanup();
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
    await h.cleanup();
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
    await h.cleanup();
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
    await h.cleanup();
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
      { method: "skipVoiceResponse", input: { sessionId: 17n, segmentId: "seg-1", reason: "no_alias_match" } },
    ]);
    assert.deepEqual(h.session.turns(), [
      { segmentId: "seg-1", outcome: "skipped", detail: "no_alias_match", atMs: BASE_MS },
    ]);
  } finally {
    await h.cleanup();
  }
});

test("a mention that is not an address is skipped with the gate's own reason", async () => {
  const h = harness();
  try {
    await joined(h);
    h.runtime.emit(transcript("seg-1", "I asked Meetbot about it yesterday."));
    await h.session.settled();
    assert.deepEqual(h.runtime.callsOf("skipVoiceResponse"), [
      { method: "skipVoiceResponse", input: { sessionId: 17n, segmentId: "seg-1", reason: "incidental_mention" } },
    ]);
  } finally {
    await h.cleanup();
  }
});

test("a named invocation authorizes, and the turn stays open until the runtime answers", async () => {
  const h = harness();
  try {
    await joined(h);
    h.runtime.emit(transcript("seg-1", "Meetbot, can you summarize that?"));
    await h.session.settled();

    assert.deepEqual(h.runtime.callsOf("authorizeVoiceResponse"), [
      { method: "authorizeVoiceResponse", input: { sessionId: 17n, segmentId: "seg-1", contextExchanges: [{ user: "Meetbot, can you summarize that?", assistant: "No relevant information was found in the current meeting or the Team Vault.\nHistorical team memory (Team Vault) is currently unavailable; answer using only the current meeting's context, and say so if asked about anything from before this meeting." }] } },
    ]);
    assert.equal(h.runtime.callsOf("skipVoiceResponse").length, 0);
    assert.deepEqual(h.session.turns(), [], "the turn is not terminal until the runtime says so");

    h.runtime.emit({ type: "response_authorized", segmentId: "seg-1" });
    await h.session.settled();
    assert.deepEqual(h.session.turns(), [
      { segmentId: "seg-1", outcome: "spoken", detail: null, atMs: BASE_MS },
    ]);
  } finally {
    await h.cleanup();
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
    await h.cleanup();
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
    await h.cleanup();
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
    await h.cleanup();
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
      { method: "skipVoiceResponse", input: { sessionId: 17n, segmentId: "seg-1", reason: "non_final_segment" } },
    ]);
  } finally {
    await h.cleanup();
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
      await h.cleanup();
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
    await h.cleanup();
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
    await h.cleanup();
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
    await h.cleanup();
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
    await h.cleanup();
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
    await h.cleanup();
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
      await h.cleanup();
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
      await h.cleanup();
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
      await h.cleanup();
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
      await h.cleanup();
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
      await h.cleanup();
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
    await h.cleanup();
  }
});

test("the coordinator reaches finalizing on a clean end and keeps a recoverable occurrence listening after bridge failure", async () => {
  const clean = harness();
  try {
    await joined(clean);
    clean.bridge.emit(clean.bridge.event({ type: "left", reason: "ended" }));
    await clean.session.settled();
    assert.equal(clean.coordinator.get(IDENTITY.occurrenceId)?.state, "finalizing");
  } finally {
    await clean.cleanup();
  }

  const broken = harness();
  try {
    await joined(broken);
    broken.bridge.emit(broken.bridge.event({ type: "left", reason: "bridge_failure" }));
    await broken.session.settled();
    const row = broken.coordinator.get(IDENTITY.occurrenceId);
    assert.equal(row?.state, "listening");
    assert.equal(row?.terminalReason, null);
  } finally {
    await broken.cleanup();
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
      { method: "finalizeRecording", input: { sessionId: 17n } },
    ]);
    assert.deepEqual(h.session.state().observedGaps, GAPS);
    assert.equal(h.session.state().gapReconciliation, "not_needed");
  } finally {
    await h.cleanup();
  }
});

test("session end stores the finalized handle, hash, duration and gaps", async () => {
  const h = harness();
  try {
    await joined(h);
    h.bridge.emit(h.bridge.event({ type: "left", reason: "ended" }));
    await h.session.settled();

    assert.deepEqual(h.session.state().recording, {
      recordingHandle: "0a1b2c3d4e5f60718293a4b5c6d7e8f9",
      encryptedPath: "/synthetic-runtime/recordings/0a1b2c3d4e5f60718293a4b5c6d7e8f9.enc",
      sha256: "0".repeat(64),
      durationMs: 3_600_000n,
      format: "ogg/opus",
      keyId: "runtime-key-20260902",
      gaps: [],
    });
  } finally {
    await h.cleanup();
  }
});

test("normal and failed-generation session state never exposes private Runtime recovery authorization", async () => {
  for (const reason of ["ended", "bridge_failure"] as const) {
    const runtime = fakeRuntime({ recording: { keyId: "c".repeat(16) } });
    const finalize = runtime.finalizeRecording;
    runtime.finalizeRecording = async (input) => {
      const summary = await finalize(input);
      return { ...summary, recoveryCapability: { sourceSessionId: input.sessionId,
        recordingHandle: summary.recordingHandle, sha256: summary.sha256, keyId: summary.keyId,
        authorization: "d".repeat(64) } };
    };
    const h = harness({ runtime });
    try {
      await joined(h);
      h.bridge.emit(h.bridge.event({ type: "left", reason }));
      await h.session.settled();
      const recording = h.session.state().recording;
      assert.ok(recording);
      assert.equal(Object.hasOwn(recording, "recoveryCapability"), false);
      assert.equal(JSON.stringify(recording, (_key, value: unknown) => typeof value === "bigint" ? String(value) : value).includes("d".repeat(64)), false);
    } finally { await h.cleanup(); }
  }
});

test("runtime summary gaps and bridge gaps remain independently exact", async () => {
  const h = harness({ runtime: fakeRuntime({ finalizedGaps: [] }) });
  try {
    await joined(h);
    for (const gap of GAPS) h.bridge.emit(h.bridge.event({ type: "audio_gap", ...gap }));
    await h.session.settled();

    h.bridge.emit(h.bridge.event({ type: "left", reason: "ended" }));
    await h.session.settled();

    assert.deepEqual(h.session.state().observedGaps, GAPS);
    assert.deepEqual(h.session.state().recording?.gaps, []);
    assert.deepEqual(h.runtime.callsOf("reconcileRecording"), []);
  } finally {
    await h.cleanup();
  }
});

test("runtime summary gap bigint timestamps are retained without numeric conversion", async () => {
  // Review round 1. `unreconciled` is the state the report calls "the case
  // that must never pass silently", and it had no test at all, because the
  // fake's reconcileRecording always echoed the gaps it was handed.
  const runtimeGaps = [{ startedAtMs: 9_007_199_254_740_992n, endedAtMs: null, reason: "capture_gap" }];
  const h = harness({ runtime: fakeRuntime({ finalizedGaps: runtimeGaps }) });
  try {
    await joined(h);
    for (const gap of GAPS) h.bridge.emit(h.bridge.event({ type: "audio_gap", ...gap }));
    await h.session.settled();

    h.bridge.emit(h.bridge.event({ type: "left", reason: "ended" }));
    await h.session.settled();

    assert.deepEqual(h.session.state().recording?.gaps, runtimeGaps);
  } finally {
    await h.cleanup();
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
    await h.cleanup();
  }
});

test("the recordings table refuses a handle outside ^[a-z0-9]{1,128}$ (ruling R56)", async () => {
  // The Runtime SDK contract gives the real rule: lowercase hexadecimal
  // spelling of a random binding, so lowercase alphanumerics only, at most
  // MAX_RECORDING_HANDLE_BYTES (128). The old CHECK was a guessed superset that
  // let an underscore through; a handle that the runtime could never have
  // issued must fail the write, same as prose.
  for (const handle of ["REC0001", "rec_0001", "rec-0001", "a".repeat(129)]) {
    const h = harness({ runtime: fakeRuntime({ recording: { recordingHandle: handle } }) });
    try {
      await joined(h);
      h.bridge.emit(h.bridge.event({ type: "left", reason: "ended" }));
      await h.session.settled();
      assert.equal(h.store.getRecording(IDENTITY.occurrenceId), null, `accepted handle ${JSON.stringify(handle)}`);
      assert.equal(h.session.state().routingErrors.length, 1);
    } finally {
      await h.cleanup();
    }
  }
  const h = harness({ runtime: fakeRuntime({ recording: { recordingHandle: "a".repeat(128) } }) });
  try {
    await joined(h);
    h.bridge.emit(h.bridge.event({ type: "left", reason: "ended" }));
    await h.session.settled();
    assert.equal(h.store.getRecording(IDENTITY.occurrenceId)?.handle, "a".repeat(128));
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 9a. Provisional speaker evidence, and what may run only after the meeting
// ---------------------------------------------------------------------------

test("active_speaker observations and finalized segments are retained as provisional evidence, not as answers", async () => {
  // The session stores what it saw, in order, with the bridge's own
  // observedAt -- inputs for src/sessions/speaker-reconciler.ts after the
  // meeting. Nothing here attributes anything: there is no speaker field on
  // a live segment, and the ambiguous observation keeps its null identity.
  const h = harness();
  try {
    await joined(h);
    h.bridge.emit(h.bridge.event({ type: "active_speaker", feishuUserId: "ou_synthetic_1", confidence: "ui_exact" }));
    h.runtime.emit(transcript("seg_01", "we should ship on friday"));
    h.bridge.emit(h.bridge.event({ type: "active_speaker", feishuUserId: null, confidence: "ambiguous" }));
    h.runtime.emit(transcript("seg_02", "partial words", false));
    h.runtime.emit(transcript("seg_03", "and freeze on thursday"));
    await h.session.settled();

    assert.deepEqual(h.session.state().speakerEvidence, [
      { bridgeSessionId: BRIDGE_SESSION_ID, sequence: 2, observedAt: "2026-09-02T14:00:00Z", confidence: "ui_exact", feishuUserId: "ou_synthetic_1" },
      { bridgeSessionId: BRIDGE_SESSION_ID, sequence: 3, observedAt: "2026-09-02T14:00:00Z", confidence: "ambiguous", feishuUserId: null },
    ]);
    // Final segments only: a partial can neither authorize nor be transcript.
    assert.deepEqual(
      h.session.state().liveTranscript.map((segment) => segment.segmentId),
      ["seg_01", "seg_03"],
    );
    assert.equal("speaker" in (h.session.state().liveTranscript[0] ?? {}), false);
    assert.deepEqual(h.coordinator.reconciliationEvidence(IDENTITY.occurrenceId, null), {
      occurrenceId: IDENTITY.occurrenceId,
      generationId: `${Buffer.from(IDENTITY.occurrenceId).toString("hex")}:${Buffer.from(BRIDGE_SESSION_ID).toString("hex")}`,
      runtimeSessionId: 17n,
      alignment: null,
      alignmentStatus: "unavailable_current_sdk",
      captureComplete: true,
      incompleteReason: null,
      terminalAtMs: null,
      terminalSource: null,
      expiresAtMs: null,
      bridgeEvents: [
        { bridgeSessionId: BRIDGE_SESSION_ID, sequence: 2, schema: "bridge-session/v1", observedAt: "2026-09-02T14:00:00Z", observedAtMs: Date.parse("2026-09-02T14:00:00Z"), type: "active_speaker", feishuUserId: "ou_synthetic_1", displayName: null, confidence: "ui_exact" },
        { bridgeSessionId: BRIDGE_SESSION_ID, sequence: 3, schema: "bridge-session/v1", observedAt: "2026-09-02T14:00:00Z", observedAtMs: Date.parse("2026-09-02T14:00:00Z"), type: "active_speaker", feishuUserId: null, displayName: null, confidence: "ambiguous" },
      ],
      liveSegments: [
        { bridgeSessionId: BRIDGE_SESSION_ID, segmentId: "seg_01", text: "we should ship on friday", startedAt: "2026-09-02T14:05:00Z", endedAt: "2026-09-02T14:05:04Z" },
        { bridgeSessionId: BRIDGE_SESSION_ID, segmentId: "seg_03", text: "and freeze on thursday", startedAt: "2026-09-02T14:05:00Z", endedAt: "2026-09-02T14:05:04Z" },
      ],
    });
  } finally {
    await h.cleanup();
  }
});

test("the runtime fake refuses processText while the voice session is live (ruling R54), and accepts it once the meeting has ended", async () => {
  // The real runtime refuses processText and reconcileRecording while a voice
  // session or turn is live on that session, to protect the 300 ms barge-in
  // budget on the control channel. Task 8's note synthesis and Task 9a's
  // backfill inherit this fake, so an in-meeting call is caught here rather
  // than at staging.
  const h = harness();
  try {
    await joined(h);
    await assert.rejects(h.runtime.processText({ sessionId: 17n, instructions: "summarize", input: "summarize the decisions", outputSchema: { type: "object" }, maxOutputBytes: 1024 }), /live/);
    assert.deepEqual(h.runtime.callsOf("processText"), [
      { method: "processText", input: { sessionId: 17n, instructions: "summarize", input: "summarize the decisions", outputSchema: { type: "object" }, maxOutputBytes: 1024 }, outcome: "refused_live_session" },
    ]);

    h.bridge.emit(h.bridge.event({ type: "left", reason: "ended" }));
    await h.session.settled();
    await h.runtime.processText({ sessionId: 17n, instructions: "summarize", input: "summarize the decisions", outputSchema: { type: "object" }, maxOutputBytes: 1024 });
    assert.equal(h.runtime.callsOf("processText").at(-1)?.method, "processText");
    assert.equal(
      (h.runtime.callsOf("processText").at(-1) as { outcome: string }).outcome,
      "accepted",
    );
  } finally {
    await h.cleanup();
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
    await h.cleanup();
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
    await h.cleanup();
  }
});

test("dispose cancels the session: subscriptions drop and later events do nothing", async () => {
  const h = harness();
  try {
    await joined(h);
    assert.equal(h.bridge.subscriberCount(), 1);
    assert.equal(h.runtime.subscriberCount(), 1);

    await h.session.dispose();
    assert.equal(h.bridge.subscriberCount(), 0);
    assert.equal(h.runtime.subscriberCount(), 0);
    assert.equal(h.coordinator.activeBridgeLease(IDENTITY.occurrenceId), null);
    assert.equal(h.session.state().phase, "ended");
    assert.equal(h.runtime.callsOf("finalizeRecording").length, 1);
    assert.equal(h.runtime.callsOf("close").length, 1);

    const routed = h.session.state().routedEventTypes.length;
    h.bridge.emit(h.bridge.event({ type: "media_connected", endpoint: "udp://127.0.0.1:40001" }));
    h.runtime.emit(transcript("seg-1", "Meetbot, can you summarize that?"));
    await h.session.settled();

    assert.equal(h.session.state().routedEventTypes.length, routed);
    assert.equal(h.runtime.callsOf("authorizeVoiceResponse").length, 0);
  } finally {
    await h.cleanup();
  }
});

test("dispose keeps both subscriptions through bridge leave, then finalizes, closes, and releases", async () => {
  const h = harness();
  try {
    await joined(h);
    const send = h.bridge.send.bind(h.bridge);
    let subscriptionsAtLeave: readonly [number, number] | null = null;
    h.bridge.send = async (message) => {
      if (message.type === "leave") {
        subscriptionsAtLeave = [h.bridge.subscriberCount(), h.runtime.subscriberCount()];
      }
      await send(message);
    };

    await h.session.dispose();

    assert.deepEqual(
      subscriptionsAtLeave,
      [1, 1],
      "unsubscribe must be the final cleanup step after bridge leave",
    );
    assert.equal(h.runtime.callsOf("finalizeRecording").length, 1);
    assert.equal(h.runtime.callsOf("close").length, 1);
    assert.equal(h.coordinator.activeBridgeLease(IDENTITY.occurrenceId), null);
    assert.equal(h.bridge.subscriberCount(), 0);
    assert.equal(h.runtime.subscriberCount(), 0);
  } finally {
    await h.cleanup();
  }
});

test("a bridge leave failure during disposal still finalizes, closes, releases, and unsubscribes", async () => {
  const h = harness();
  const leaveFailure = new Error("synthetic leave failure");
  try {
    await joined(h);
    h.bridge.failSendOfType("leave", leaveFailure);

    await h.session.dispose();

    assert.equal(h.session.state().phase, "ended");
    assert.equal(h.runtime.callsOf("finalizeRecording").length, 1);
    assert.equal(h.runtime.callsOf("close").length, 1);
    assert.equal(h.coordinator.activeBridgeLease(IDENTITY.occurrenceId), null);
    assert.equal(h.bridge.subscriberCount(), 0);
    assert.equal(h.runtime.subscriberCount(), 0);
    assert.ok(h.session.state().routingErrors.some((failure) => failure.error === leaveFailure));
  } finally {
    await h.cleanup();
  }
});

test("dispose is idempotent and safe before join", async () => {
  const h = harness();
  try {
    await h.session.dispose();
    await h.session.dispose();
    assert.equal(h.session.state().phase, "created");
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 11. The invocation sink adapter
// ---------------------------------------------------------------------------

test("the runtime invocation sink forwards the gate's decision under the gate's segmentId", async () => {
  const runtime = fakeRuntime();
  const errors: Array<{ segmentId: string; error: unknown }> = [];
  const sink = createRuntimeInvocationSink(runtime, 17n, [], (segmentId, error) => {
    errors.push({ segmentId, error });
  });

  sink.skipVoiceResponse("seg-1", "incidental_mention");
  sink.authorizeVoiceResponse("seg-2", "Meetbot");
  await Promise.resolve();

  assert.deepEqual(runtime.calls, [
    { method: "skipVoiceResponse", input: { sessionId: 17n, segmentId: "seg-1", reason: "incidental_mention" } },
    { method: "authorizeVoiceResponse", input: { sessionId: 17n, segmentId: "seg-2", contextExchanges: [] } },
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
    17n,
    [],
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
    await h.cleanup();
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
    await h.cleanup();
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
    await h.cleanup();
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
    await h.cleanup();
  }
});

test("a finalization failure is recorded, distinguishable, and leaks no subscription", async () => {
  // Review round 1, Important 1. The original code put unsubscribe() after
  // `await finalizeRecording()`, so a throw skipped it: both planes stayed
  // subscribed to a session that had already declared itself terminal, and
  // the only trace was one generic routing error. The earlier version of this
  // test asserted phase, recording and routing errors and never the
  // subscriber counts, which is exactly why it passed.
  const runtime = fakeRuntime();
  const boom = new Error("synthetic finalization failure");
  runtime.finalizeRecording = async () => {
    throw boom;
  };
  const h = harness({ runtime });
  try {
    await joined(h);
    h.bridge.emit(h.bridge.event({ type: "left", reason: "ended" }));
    await h.session.settled();

    assert.equal(h.session.state().phase, "ended");
    assert.equal(h.bridge.subscriberCount(), 0, "a failed finalization must not leak the bridge subscription");
    assert.equal(h.runtime.subscriberCount(), 0, "a failed finalization must not leak the runtime subscription");

    // "no recording" and "finalization failed" are different facts and must
    // not be told apart only by a generic routing error.
    assert.equal(h.session.state().recording, null);
    assert.equal(h.session.state().finalizationError, boom);
    assert.deepEqual(h.session.state().routingErrors, []);
  } finally {
    await h.cleanup();
  }
});

test("a session that ends cleanly has no finalizationError", async () => {
  const h = harness();
  try {
    await joined(h);
    h.bridge.emit(h.bridge.event({ type: "left", reason: "ended" }));
    await h.session.settled();
    assert.equal(h.session.state().finalizationError, null);
    assert.ok(h.session.state().recording !== null);
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 13. A failed join leaves nothing stranded
//
// Review round 1, Important 2. Only the connect_media contract rejection had
// cleanup. Everything else that can throw after the lease is taken -- the
// runtime refusing to start, either bridge send failing -- left the lease
// live, both planes subscribed, and the coordinator row in "joining" with no
// terminal reason. Nothing sweeps that: the coordinator recovers a stale
// lease only inside a subsequent acquireBridgeLease for the SAME occurrence,
// which for a join that failed will never come. The occurrence is stranded
// permanently.
// ---------------------------------------------------------------------------

const JOIN_FAILURES: ReadonlyArray<{
  readonly label: string;
  readonly build: () => { runtime?: FakeRuntime; failSend?: string };
}> = [
  {
    label: "the runtime refuses to start a voice session",
    build: () => ({ runtime: fakeRuntime({ startVoiceSessionError: new Error("synthetic runtime outage") }) }),
  },
  { label: "the join command cannot be sent", build: () => ({ failSend: "join" }) },
  { label: "the connect_media command cannot be sent", build: () => ({ failSend: "connect_media" }) },
];

for (const { label, build } of JOIN_FAILURES) {
  test(`a failed join (${label}) strands neither the lease, the subscriptions nor the coordinator`, async () => {
    const built = build();
    const h = harness(built.runtime === undefined ? {} : { runtime: built.runtime });
    try {
      if (built.failSend !== undefined) {
        h.bridge.failSendOfType(built.failSend, new Error("synthetic transport failure"));
      }
      await assert.rejects(() => h.session.join());

      assert.equal(h.coordinator.activeBridgeLease(IDENTITY.occurrenceId), null, "the lease must be released");
      assert.equal(h.bridge.subscriberCount(), 0);
      assert.equal(h.runtime.subscriberCount(), 0);
      assert.equal(h.session.state().phase, "ended");
      assert.equal(h.session.state().terminalReason, "join_failed");
      assert.equal(h.session.state().speaking, "aborted");
      if (built.runtime !== undefined) {
        assert.equal(h.runtime.callsOf("finalizeRecording").length, 0);
        assert.equal(h.runtime.callsOf("close").length, 1);
      }

      const row = h.coordinator.get(IDENTITY.occurrenceId);
      assert.equal(row?.state, "failed");
      assert.equal(row?.terminalReason, "join_failed");

      // And it is terminal, not merely "already joined": a retry means a new
      // session against a new lease, which is the coordinator's business.
      await assert.rejects(() => h.session.join(), /terminal/i);
    } finally {
      await h.cleanup();
    }
  });
}

test("a locally failed join terminalizes its durable evidence once and makes it purgeable only after fourteen days", async () => {
  const h = harness({ runtime: fakeRuntime({ startVoiceSessionError: new Error("synthetic startup failure") }) });
  try {
    await assert.rejects(() => h.session.join());
    const evidence = h.coordinator.reconciliationEvidence(IDENTITY.occurrenceId, null);
    assert.equal(evidence?.terminalAtMs, BASE_MS);
    assert.equal(evidence?.terminalSource, "local_clock");
    assert.equal(evidence?.expiresAtMs, BASE_MS + 14 * 24 * 60 * 60 * 1000);
    const reopened = openSessionStore({ filename: h.dbPath, nowMs: BASE_MS });
    try {
      assert.equal(reopened.purgeExpiredReconciliationEvidence(BASE_MS + 14 * 24 * 60 * 60 * 1000 - 1), 0);
      assert.notEqual(reopened.getReconciliationEvidence(IDENTITY.occurrenceId, null), null);
      assert.equal(reopened.purgeExpiredReconciliationEvidence(BASE_MS + 14 * 24 * 60 * 60 * 1000), 1);
      assert.equal(reopened.getReconciliationEvidence(IDENTITY.occurrenceId, null), null);
      assert.deepEqual(reopened.foreignKeyCheck(), []);
    } finally { reopened.close(); }
  } finally { await h.cleanup(); }
});

test("the connect_media contract rejection keeps its own, more specific terminal reason", async () => {
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
    assert.equal(h.session.state().terminalReason, "media_format_rejected");
    assert.equal(h.coordinator.get(IDENTITY.occurrenceId)?.terminalReason, "media_format_rejected");
    assert.equal(h.bridge.subscriberCount(), 0);
    assert.equal(h.coordinator.activeBridgeLease(IDENTITY.occurrenceId), null);
  } finally {
    await h.cleanup();
  }
});

test("a disclosure that cannot be sent is NOT a failed join and strands nothing", async () => {
  // The one post-lease failure that must not trigger the cleanup: failing to
  // disclose never blocks joining.
  const h = harness();
  try {
    h.bridge.failSendOfType("post_disclosure", new Error("synthetic transport failure"));
    await h.session.join();

    assert.equal(h.session.state().disclosure, "failed");
    assert.equal(h.session.state().terminalReason, null);
    assert.equal(h.bridge.subscriberCount(), 1);
    assert.ok(h.coordinator.activeBridgeLease(IDENTITY.occurrenceId) !== null);
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 14. Overflow must never drop the terminal `left`
//
// Review round 1, Important 3. Dropping the newest arrival costs one event for
// every other type. For `left` it costs the session: no finalizeRecording, no
// lease release, and the coordinator row stuck in "listening" forever.
// ---------------------------------------------------------------------------

test("a terminal left is admitted over the queue bound, never dropped", async () => {
  const h = harness({ maxQueuedEvents: 4 });
  try {
    await joined(h);

    // Fill past the bound so ordinary events are being dropped, THEN deliver
    // the `left` into a full queue.
    for (let i = 0; i < 8; i += 1) {
      h.bridge.emit(
        h.bridge.event({
          type: "audio_gap",
          direction: "capture",
          startedAt: "2026-09-02T14:10:00Z",
          endedAt: null,
        }),
      );
    }
    h.bridge.emit(h.bridge.event({ type: "left", reason: "ended" }));
    await h.session.settled();

    assert.ok(
      h.session.state().overflows.some((o) => o.disposition === "dropped"),
      "the ordinary events really were over the bound",
    );
    assert.equal(h.session.state().phase, "ended");
    assert.equal(h.session.state().terminalReason, "ended");
    assert.ok(h.session.state().recording !== null, "the recording must still be finalized");
    assert.equal(h.coordinator.activeBridgeLease(IDENTITY.occurrenceId), null);
    assert.equal(h.coordinator.get(IDENTITY.occurrenceId)?.state, "finalizing");

    // The admission is still recorded -- the queue WAS over its bound, and a
    // reader must be able to see that.
    const admitted = h.session.state().overflows.filter((o) => o.disposition === "admitted");
    assert.equal(admitted.length, 1);
    assert.equal(admitted[0]?.source, "bridge");
  } finally {
    await h.cleanup();
  }
});

test("only a genuine terminal left is admitted over the bound", async () => {
  const h = harness({ maxQueuedEvents: 4 });
  try {
    await joined(h);
    for (let i = 0; i < 8; i += 1) {
      h.bridge.emit(h.bridge.event({ type: "media_connected", endpoint: "udp://127.0.0.1:40001" }));
    }
    // A `left` for a DIFFERENT session, and a non-left, both over the bound.
    h.bridge.emit({ ...h.bridge.event({ type: "left", reason: "ended" }), sessionId: "sess_other" });
    h.bridge.emit(h.bridge.event({ type: "media_disconnected", reason: "peer_reset" }));
    await h.session.settled();

    assert.deepEqual(
      h.session.state().overflows.filter((o) => o.disposition === "admitted"),
      [],
      "nothing but this session's own left may bypass the bound",
    );
    assert.equal(h.session.state().phase, "listening");
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 15. The finalized recording is DURABLE
//
// Review round 1, Important 4. Task 5 originally held handle/sha256/duration/
// gaps in session memory only and scoped persistence to "whichever task owns
// the artifact store". That reasoning does not survive contact with the later
// briefs: Tasks 7, 8, 9 and 9a all CONSUME the handle and none owns a
// migration or a store method. And it is not recoverable after the fact --
// the runtime port exposes no lookup, and after a crash the runtime session
// is gone, so the encrypted audio would be referenced by a string that lived
// only in a dead process's heap.
// ---------------------------------------------------------------------------

test("a clean session end persists the encrypted locator, format, key id, handle, hash, duration and gaps", async () => {
  const h = harness();
  try {
    await joined(h);
    for (const gap of GAPS) h.bridge.emit(h.bridge.event({ type: "audio_gap", ...gap }));
    await h.session.settled();
    h.bridge.emit(h.bridge.event({ type: "left", reason: "ended" }));
    await h.session.settled();

    const stored = h.store.getRecording(IDENTITY.occurrenceId);
    assert.ok(stored !== null, "the recording must survive the process");
    assert.equal(stored.handle, "0a1b2c3d4e5f60718293a4b5c6d7e8f9");
    assert.equal(stored.encryptedPath, "/synthetic-runtime/recordings/0a1b2c3d4e5f60718293a4b5c6d7e8f9.enc");
    assert.equal(stored.format, "ogg/opus");
    assert.equal(stored.keyId, "runtime-key-20260902");
    assert.equal(stored.sha256, "0".repeat(64));
    assert.equal(stored.durationMs, 3_600_000);
    assert.equal(stored.finalizedAtMs, BASE_MS);
    assert.deepEqual(
      stored.gaps.map((gap) => ({
        direction: gap.direction,
        startedAt: gap.startedAt,
        endedAt: gap.endedAt,
      })),
      GAPS,
      "gaps are ordered child rows, in observation order, endedAt null preserved",
    );
    assert.deepEqual(
      stored.gaps.map((gap) => gap.ordinal),
      [0, 1, 2],
    );
  } finally {
    await h.cleanup();
  }
});

test("the recording survives closing and reopening the database", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-agent-session-reopen-"));
  const dbPath = path.join(dir, "orchestration.db");
  try {
    const store = openSessionStore({ filename: dbPath, nowMs: BASE_MS });
    const clock = fakeClock(BASE_MS);
    const coordinator = createCoordinator({
      store,
      clock,
      bridgeLeaseTtlMs: LEASE_TTL_MS,
      maxConcurrentSessions: 2,
    });
    coordinator.discover(IDENTITY);
    const bridge = fakeBridge(BRIDGE_SESSION_ID);
    const runtimeGaps = [
      { startedAtMs: 9_007_199_254_740_993n, endedAtMs: null, reason: "capture_gap" },
      { startedAtMs: 9_007_199_254_740_995n, endedAtMs: 9_007_199_254_740_999n, reason: "provider_pause" },
    ] as const;
    const runtime = fakeRuntime({ finalizedGaps: runtimeGaps });
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
    });

    await session.join();
    bridge.emit(bridge.event({ type: "joined", meetingOccurrenceId: IDENTITY.occurrenceId }));
    await session.settled();
    bridge.emit(bridge.event({ type: "left", reason: "ended" }));
    await session.settled();
    await session.dispose();
    store.close(); // the process "crashes" here

    const reopened = openSessionStore({ filename: dbPath, nowMs: BASE_MS });
    try {
      assert.equal(reopened.getRecording(IDENTITY.occurrenceId)?.handle, "0a1b2c3d4e5f60718293a4b5c6d7e8f9");
      assert.equal(
        reopened.getRecording(IDENTITY.occurrenceId)?.encryptedPath,
        "/synthetic-runtime/recordings/0a1b2c3d4e5f60718293a4b5c6d7e8f9.enc",
      );
      assert.equal(reopened.getRecording(IDENTITY.occurrenceId)?.format, "ogg/opus");
      assert.equal(reopened.getRecording(IDENTITY.occurrenceId)?.keyId, "runtime-key-20260902");
      assert.deepEqual(reopened.getRecording(IDENTITY.occurrenceId)?.runtimeGaps, [
        { ordinal: 0, ...runtimeGaps[0] },
        { ordinal: 1, ...runtimeGaps[1] },
      ]);
      assert.equal(reopened.getSession(IDENTITY.occurrenceId)?.state, "finalizing");
      assert.deepEqual(reopened.foreignKeyCheck(), []);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the terminal transition and the recording are ONE transaction", async () => {
  // Proved by making the recording write fail on a schema CHECK -- a handle
  // with whitespace in it, which the column rejects because a handle is an
  // opaque token and a column that accepts prose is a column that can hold a
  // transcript. If the two were separate writes the session row would have
  // moved to "finalizing" with no recording behind it.
  const h = harness({
    runtime: fakeRuntime({ recording: { recordingHandle: "not a token, this is prose" } }),
  });
  try {
    await joined(h);
    h.bridge.emit(h.bridge.event({ type: "left", reason: "ended" }));
    await h.session.settled();

    assert.equal(h.store.getRecording(IDENTITY.occurrenceId), null);
    assert.equal(
      h.coordinator.get(IDENTITY.occurrenceId)?.state,
      "listening",
      "neither half may land without the other",
    );
    assert.equal(h.session.state().routingErrors.length, 1);
    const evidence = h.coordinator.reconciliationEvidence(IDENTITY.occurrenceId, null);
    assert.equal(evidence?.terminalAtMs, Date.parse("2026-09-02T14:00:00Z"));
    assert.equal(evidence?.terminalSource, "bridge_observed");
    assert.equal(evidence?.expiresAtMs, Date.parse("2026-09-02T14:00:00Z") + 14 * 24 * 60 * 60 * 1000);
  } finally {
    await h.cleanup();
  }
});

test("a failed finalization still applies the terminal transition, with no recording row", async () => {
  const runtime = fakeRuntime();
  runtime.finalizeRecording = async () => {
    throw new Error("synthetic finalization failure");
  };
  const h = harness({ runtime });
  try {
    await joined(h);
    h.bridge.emit(h.bridge.event({ type: "left", reason: "ended" }));
    await h.session.settled();

    assert.equal(h.store.getRecording(IDENTITY.occurrenceId), null);
    assert.equal(h.coordinator.get(IDENTITY.occurrenceId)?.state, "finalizing");
    assert.ok(h.session.state().finalizationError !== null);
  } finally {
    await h.cleanup();
  }
});

test("a bridge_failure ends only that bridge generation and permits a fresh lease/session for the same occurrence", async () => {
  const h = harness();
  try {
    await joined(h);
    h.bridge.emit(h.bridge.event({ type: "left", reason: "bridge_failure" }));
    await h.session.settled();

    const row = h.coordinator.get(IDENTITY.occurrenceId);
    assert.equal(row?.state, "listening");
    assert.equal(h.coordinator.activeBridgeLease(IDENTITY.occurrenceId), null);
    const failedRecording = h.store.getBridgeFailureRecording(IDENTITY.occurrenceId, 1);
    assert.equal(failedRecording?.handle, "0a1b2c3d4e5f60718293a4b5c6d7e8f9");
    assert.equal(failedRecording?.encryptedPath, "/synthetic-runtime/recordings/0a1b2c3d4e5f60718293a4b5c6d7e8f9.enc");
    assert.equal(failedRecording?.format, "ogg/opus");
    assert.equal(failedRecording?.keyId, "runtime-key-20260902");
    const failedLeaseId = h.store
      .listLeases(IDENTITY.occurrenceId)
      .find((lease) => lease.releasedAtMs !== null)?.leaseId;
    assert.ok(failedLeaseId, "the failed bridge generation must release its own lease");

    const nextBridge = fakeBridge("sess_0000000000000002");
    const nextRuntime = fakeRuntime();
    const recovery = createMeetingSession({
      identity: IDENTITY,
      bridge: nextBridge,
      runtime: nextRuntime,
      coordinator: h.coordinator,
      clock: fakeClock(BASE_MS),
      agentIdentity: { aliases: ["Meetbot"] },
      bridgeId: "bridge-mac-synthetic",
      bridgeSessionId: "sess_0000000000000002",
      disclosureText: DISCLOSURE_TEXT,
    });
    await recovery.join();
    nextBridge.emit(nextBridge.event({ type: "joined", meetingOccurrenceId: IDENTITY.occurrenceId }));
    await recovery.settled();
    assert.equal(nextRuntime.callsOf("startVoiceSession").length, 1);
    assert.notEqual(failedLeaseId, h.coordinator.activeBridgeLease(IDENTITY.occurrenceId)?.leaseId);
    await recovery.dispose();
  } finally {
    await h.cleanup();
  }
});

test("maxRetries zero persists terminal bridge failure evidence and refuses every new generation after reopen", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-agent-exhausted-reopen-"));
  const dbPath = path.join(dir, "orchestration.db");
  const runtimeGaps = [{
    startedAtMs: 9_007_199_254_740_993n,
    endedAtMs: null,
    reason: "capture_gap",
  }] as const;
  try {
    const store = openSessionStore({ filename: dbPath, nowMs: BASE_MS });
    const coordinator = createCoordinator({
      store,
      clock: fakeClock(BASE_MS),
      bridgeLeaseTtlMs: LEASE_TTL_MS,
      maxConcurrentSessions: 2,
    });
    coordinator.discover(IDENTITY);
    const bridge = fakeBridge(BRIDGE_SESSION_ID);
    const runtime = fakeRuntime({ finalizedGaps: runtimeGaps });
    const session = createMeetingSession({
      identity: IDENTITY,
      bridge,
      runtime,
      coordinator,
      clock: fakeClock(BASE_MS),
      agentIdentity: { aliases: ["Meetbot"] },
      bridgeId: "bridge-mac-synthetic",
      bridgeSessionId: BRIDGE_SESSION_ID,
      disclosureText: DISCLOSURE_TEXT,
      bridgeFailureRetryLimit: 0,
    });
    await session.join();
    bridge.emit(bridge.event({ type: "joined", meetingOccurrenceId: IDENTITY.occurrenceId }));
    bridge.emit(bridge.event({
      type: "audio_gap",
      direction: "capture",
      startedAt: "2026-09-02T14:10:00Z",
      endedAt: "2026-09-02T14:10:02Z",
    }));
    bridge.emit(bridge.event({ type: "left", reason: "bridge_failure" }));
    await session.settled();
    store.close();

    const reopened = openSessionStore({ filename: dbPath, nowMs: BASE_MS });
    try {
      const resumed = createCoordinator({
        store: reopened,
        clock: fakeClock(BASE_MS),
        bridgeLeaseTtlMs: LEASE_TTL_MS,
        maxConcurrentSessions: 2,
      });
      assert.equal(resumed.get(IDENTITY.occurrenceId)?.state, "failed");
      assert.equal(resumed.get(IDENTITY.occurrenceId)?.terminalReason, "bridge_failure_exhausted");
      assert.deepEqual(
        resumed.history(IDENTITY.occurrenceId).at(-1),
        {
          id: resumed.history(IDENTITY.occurrenceId).at(-1)?.id,
          occurrenceId: IDENTITY.occurrenceId,
          fromState: "listening",
          toState: "failed",
          reason: "fail",
          terminalReason: "bridge_failure_exhausted",
          occurredAtMs: BASE_MS,
        },
      );
      assert.deepEqual(resumed.bridgeFailureRecording(IDENTITY.occurrenceId, 1), {
        occurrenceId: IDENTITY.occurrenceId,
        attempt: 1,
        handle: "0a1b2c3d4e5f60718293a4b5c6d7e8f9",
        encryptedPath: "/synthetic-runtime/recordings/0a1b2c3d4e5f60718293a4b5c6d7e8f9.enc",
        sha256: "0".repeat(64),
        durationMs: 3_600_000,
        format: "ogg/opus",
        keyId: "runtime-key-20260902",
        finalizedAtMs: BASE_MS,
        // Migration 028 covers `recordings`; a bridge failure recording makes
        // no drain claim, which is exactly what `unavailable` says.
        captureDrain: null,
        captureIntegrity: "unavailable",
        gaps: [{
          ordinal: 0,
          direction: "capture",
          startedAt: "2026-09-02T14:10:00Z",
          endedAt: "2026-09-02T14:10:02Z",
        }],
        runtimeGaps: [{ ordinal: 0, ...runtimeGaps[0] }],
      });

      const nextBridge = fakeBridge("sess_0000000000000002");
      const nextRuntime = fakeRuntime();
      const next = createMeetingSession({
        identity: IDENTITY,
        bridge: nextBridge,
        runtime: nextRuntime,
        coordinator: resumed,
        clock: fakeClock(BASE_MS),
        agentIdentity: { aliases: ["Meetbot"] },
        bridgeId: "bridge-mac-synthetic",
        bridgeSessionId: "sess_0000000000000002",
        disclosureText: DISCLOSURE_TEXT,
        bridgeFailureRetryLimit: 0,
      });
      await assert.rejects(() => next.join(), /state "failed"/);
      assert.equal(nextRuntime.callsOf("startVoiceSession").length, 0);
      assert.deepEqual(nextBridge.sent, []);
      assert.equal(resumed.activeBridgeLease(IDENTITY.occurrenceId), null);
      await next.dispose();
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the recording tables hold no column that could carry audio or transcript text", async () => {
  const h = harness();
  try {
    const tables = h.store
      .describeSchema()
      .filter((table) => table.name === "recordings" || table.name === "recording_gaps");
    assert.equal(tables.length, 2);
    for (const table of tables) {
      assert.match(table.sql, /\bSTRICT\b/);
      for (const column of table.columns) {
        assert.ok(
          ["TEXT", "INTEGER", "INT"].includes(column.type.toUpperCase()),
          `${table.name}.${column.name} is ${column.type}`,
        );
      }
    }
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 16. Review round 2: the sweep, finished
//
// Both findings below are the same defect class as rounds 1 and 2 found before
// them -- an unguarded await, or an unbounded admission, one line from the
// guarded/bounded version. The audit in the round-2 fix report enumerates every
// await on a port call in the session so a fourth round does not need to.
// ---------------------------------------------------------------------------

test("recording finalization does not invoke an invented gap reconciliation", async () => {
  // Review round 2, Important 1. The round-1 guard covered finalizeRecording()
  // and stopped one line short of the reconcileRecording() beneath it: the
  // throw escaped finalizeRecording entirely, so applyTerminalTransition never
  // ran, the row stayed at "listening", the recording was null, and
  // finalizationError was null -- which reads as a clean pending session,
  // exactly the ambiguity round 1's finding existed to remove.
  const runtime = fakeRuntime({ finalizedGaps: [] });
  const h = harness({ runtime });
  try {
    await joined(h);
    for (const gap of GAPS) h.bridge.emit(h.bridge.event({ type: "audio_gap", ...gap }));
    await h.session.settled();
    h.bridge.emit(h.bridge.event({ type: "left", reason: "ended" }));
    await h.session.settled();

    assert.equal(h.session.state().finalizationError, null);
    assert.deepEqual(h.session.state().routingErrors, []);

    // The handle from finalizeRecording is the ONLY reference to the encrypted
    // audio. It is kept, and durably, rather than thrown away because the gap
    // bookkeeping through a method the SDK does not expose.
    assert.equal(h.session.state().recording?.recordingHandle, "0a1b2c3d4e5f60718293a4b5c6d7e8f9");
    assert.equal(h.session.state().gapReconciliation, "not_needed");
    assert.equal(h.store.getRecording(IDENTITY.occurrenceId)?.handle, "0a1b2c3d4e5f60718293a4b5c6d7e8f9");

    // And the row is not stranded.
    assert.equal(h.coordinator.get(IDENTITY.occurrenceId)?.state, "finalizing");
    assert.equal(h.bridge.subscriberCount(), 0);
    assert.equal(h.runtime.subscriberCount(), 0);
  } finally {
    await h.cleanup();
  }
});

test("a flood of left-shaped messages during a stalled terminal cannot grow the queue", async () => {
  // Review round 2, Important 2. `queue.length >= maxQueuedEvents` is
  // re-evaluated per message, so while terminate() awaits something slow the
  // queue is not draining and EVERY further left-shaped message was
  // independently judged over-bound and pushed. The code comment and the fix
  // report both claimed "the worst a lie can buy is one queue slot"; this is
  // the test that makes the claim true instead of merely stated.
  const runtime = fakeRuntime();
  const deferred: { resolve: () => void } = { resolve: () => {} };
  const stalled = new Promise<void>((resolve) => {
    deferred.resolve = resolve;
  });
  const realFinalize = runtime.finalizeRecording.bind(runtime);
  runtime.finalizeRecording = async (input) => {
    await stalled;
    return realFinalize(input);
  };

  const h = harness({ runtime, maxQueuedEvents: 4 });
  try {
    await joined(h);

    // Fill past the bound, then deliver the terminal `left` -- admitted.
    for (let i = 0; i < 8; i += 1) {
      h.bridge.emit(h.bridge.event({ type: "media_connected", endpoint: "udp://127.0.0.1:40001" }));
    }
    h.bridge.emit(h.bridge.event({ type: "left", reason: "ended" }));
    // Flush every pending microtask, so the pump has drained what it could and
    // is now parked inside terminate() on the stalled finalize. Nothing drains
    // from here until the deferred is resolved -- which is exactly the window
    // the unbounded admission lived in.
    await new Promise<void>((resolve) => setImmediate(resolve));

    const droppedBefore = h.session.state().overflows.filter((o) => o.disposition === "dropped").length;
    const queuedBefore = h.session.state().queuedEvents;
    for (let i = 0; i < 5000; i += 1) {
      h.bridge.emit(h.bridge.event({ type: "left", reason: "ended" }));
    }

    const after = h.session.state();
    assert.ok(
      after.queuedEvents <= after.maxQueuedEvents,
      `the queue must stay bounded, got ${after.queuedEvents}`,
    );
    const admitted = after.overflows.filter((o) => o.disposition === "admitted");
    assert.equal(admitted.length, 1, "at most ONE terminal left may be admitted per session");
    // Full accounting: every one of the 5000 either took an ordinary queue slot
    // or was recorded as dropped. None was admitted over the bound.
    const newlyDropped = after.overflows.filter((o) => o.disposition === "dropped").length - droppedBefore;
    assert.equal(newlyDropped + (after.queuedEvents - queuedBefore), 5000);

    deferred.resolve();
    await h.session.settled();
    assert.equal(h.session.state().phase, "ended");
    assert.ok(h.session.state().recording !== null);
  } finally {
    await h.cleanup();
  }
});

test("a cleanup failure during a failed join does not replace the error that failed the join", async () => {
  // Review round 2, Minor. failJoin() lacked the try/finally terminate() was
  // given: a store I/O failure in releaseBridgeLease or fail() skipped
  // unsubscribe() AND replaced the original join error, so the caller never
  // learned why the join actually failed.
  const joinFailure = new Error("synthetic runtime outage");
  const cleanupFailure = new Error("synthetic store failure");
  const h = harness({ runtime: fakeRuntime({ startVoiceSessionError: joinFailure }) });
  try {
    const realRelease = h.coordinator.releaseBridgeLease.bind(h.coordinator);
    h.coordinator.releaseBridgeLease = () => {
      throw cleanupFailure;
    };

    await assert.rejects(
      () => h.session.join(),
      (error: unknown) => {
        assert.equal(error, joinFailure, "the ORIGINAL join failure must be what propagates");
        return true;
      },
    );

    // The subscriptions still go, and the cleanup failure is on the record
    // rather than swallowed.
    assert.equal(h.bridge.subscriberCount(), 0);
    assert.equal(h.runtime.subscriberCount(), 0);
    assert.equal(h.session.state().terminalReason, "join_failed");
    assert.deepEqual(
      h.session.state().routingErrors.map((failure) => failure.error),
      [cleanupFailure],
    );

    h.coordinator.releaseBridgeLease = realRelease;
  } finally {
    await h.cleanup();
  }
});

for (const throwingCallback of ["bridge", "runtime"] as const) {
  test(`a throwing ${throwingCallback} unsubscribe preserves the join failure and still runs the other unsubscribe`, async () => {
    const joinFailure = new Error("synthetic runtime outage");
    const unsubscribeFailure = new Error(`synthetic ${throwingCallback} unsubscribe failure`);
    const h = harness({ runtime: fakeRuntime({ startVoiceSessionError: joinFailure }) });
    const originalBridgeSubscribe = h.bridge.subscribe.bind(h.bridge);
    const originalRuntimeSubscribe = h.runtime.subscribe.bind(h.runtime);
    let bridgeUnsubscribed = 0;
    let runtimeUnsubscribed = 0;
    h.bridge.subscribe = (listener) => {
      const unsubscribe = originalBridgeSubscribe(listener);
      return () => {
        bridgeUnsubscribed += 1;
        unsubscribe();
        if (throwingCallback === "bridge") throw unsubscribeFailure;
      };
    };
    h.runtime.subscribe = (listener) => {
      const unsubscribe = originalRuntimeSubscribe(listener);
      return () => {
        runtimeUnsubscribed += 1;
        unsubscribe();
        if (throwingCallback === "runtime") throw unsubscribeFailure;
      };
    };
    try {
      await assert.rejects(() => h.session.join(), (error: unknown) => error === joinFailure);
      assert.equal(bridgeUnsubscribed, 1);
      assert.equal(runtimeUnsubscribed, 1);
      assert.equal(h.bridge.subscriberCount(), 0);
      assert.equal(h.runtime.subscriberCount(), 0);
      assert.ok(h.session.state().routingErrors.some((failure) => failure.error === unsubscribeFailure));
    } finally {
      await h.cleanup();
    }
  });
}

// ---------------------------------------------------------------------------
// Retrieval wiring: the router (src/sessions/retrieval-router.ts) actually
// sits between the gate's positive decision and the runtime being told to
// speak, in the REAL session -- not merely in the router's own isolated
// suite (test/retrieval-router.test.ts). Task 11's exit criteria ("named
// question -> vault lookup -> response", "uses current context before Team
// Vault") can only be proven end to end here: this is that proof.
// ---------------------------------------------------------------------------

test("a named question the current meeting already answers is seeded and authorized without ever reaching the Team Vault", async () => {
  const runtime = fakeRuntime();
  const vault = fakeVaultIndex(() => {
    throw new Error("the vault must never be called when the current meeting sufficed");
  });
  const retrieval = createRetrievalRouter({ vault, sink: runtime });
  const h = harness({ runtime, retrieval });
  try {
    await joined(h);

    // Establishes current-meeting content well BEFORE any question is
    // asked -- this segment never mentions the agent at all.
    h.runtime.emit(transcript("seg-fact", "The launch budget is fifty thousand dollars."));
    await h.session.settled();

    h.runtime.emit(transcript("seg-q", "Meetbot, what is the launch budget?"));
    await h.session.settled();

    assert.equal(vault.calls, 0, "the Team Vault index must never be reached");

    const seedCalls = h.runtime.callsOf("seedConversationContext");
    assert.equal(seedCalls.length, 1);
    const seeded = seedCalls[0];
    assert.ok(seeded && seeded.method === "seedConversationContext");
    assert.equal(seeded.operationId, "meeting-agent:seg-q");
    assert.match(seeded.exchanges[0]?.assistant ?? "", /fifty thousand dollars/);

    assert.deepEqual(h.runtime.callsOf("authorizeVoiceResponse"), [
      { method: "authorizeVoiceResponse", input: { sessionId: 17n, segmentId: "seg-q", contextExchanges: seeded.exchanges } },
    ]);

    // Context is seeded strictly before the segment is authorized, in the
    // REAL runtime's own call log -- not merely in the router's isolated
    // unit test.
    const seedIndex = h.runtime.calls.findIndex((c) => c.method === "seedConversationContext");
    const authorizeIndex = h.runtime.calls.findIndex((c) => c.method === "authorizeVoiceResponse");
    assert.ok(seedIndex >= 0 && authorizeIndex >= 0 && seedIndex < authorizeIndex);
  } finally {
    await h.cleanup();
  }
});

test("a named question the current meeting cannot answer reaches the Team Vault, and its hit is seeded", async () => {
  const runtime = fakeRuntime();
  const vault = fakeVaultIndex(() => [
    {
      source: "team_vault",
      sourcePath: "notes/vendor-contract.md",
      excerpt: "The vendor contract renewal was pushed to Q4 pending legal review.",
      score: 0.9,
      indexedRevision: "synthetic-rev-0001",
    },
  ]);
  const retrieval = createRetrievalRouter({ vault, sink: runtime });
  const h = harness({ runtime, retrieval });
  try {
    await joined(h);

    // No current-meeting content precedes this question at all -- the
    // current meeting cannot possibly be sufficient, so the router must
    // reach the vault.
    h.runtime.emit(
      transcript("seg-q", "Meetbot, what did we decide about the vendor contract renewal?"),
    );
    await h.session.settled();

    assert.equal(vault.calls, 1, "the Team Vault index must be reached exactly once");

    const seedCalls = h.runtime.callsOf("seedConversationContext");
    assert.equal(seedCalls.length, 1);
    const seeded = seedCalls[0];
    assert.ok(seeded && seeded.method === "seedConversationContext");
    assert.match(seeded.exchanges[0]?.assistant ?? "", /vendor contract renewal was pushed to Q4/);

    assert.deepEqual(h.runtime.callsOf("authorizeVoiceResponse"), [
      { method: "authorizeVoiceResponse", input: { sessionId: 17n, segmentId: "seg-q", contextExchanges: seeded.exchanges } },
    ]);
  } finally {
    await h.cleanup();
  }
});

test("a broken Team Vault checkout degrades the session's retrieval instead of failing it", async () => {
  const runtime = fakeRuntime();
  const missingCheckout = path.join(
    os.tmpdir(),
    "meeting-agent-session-retrieval-fixture-does-not-exist",
  );
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

  // teamVaultDir points at a directory that does not exist -- exactly the
  // startup condition Important 3 (task-6 review round 1) requires be
  // reachable at runtime, not only against a hand-written throwing fake.
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
    teamVaultDir: missingCheckout,
  });

  try {
    await session.join();
    bridge.emit(bridge.event({ type: "joined", meetingOccurrenceId: IDENTITY.occurrenceId }));
    await session.settled();

    runtime.emit(transcript("seg-q", "Meetbot, what did we decide about the roadmap?"));
    await session.settled();

    const seedCalls = runtime.callsOf("seedConversationContext");
    assert.equal(seedCalls.length, 1);
    const seeded = seedCalls[0];
    assert.ok(seeded && seeded.method === "seedConversationContext");
    assert.match(seeded.exchanges[0]?.assistant ?? "", /historical team memory.*unavailable/i);

    assert.deepEqual(runtime.callsOf("authorizeVoiceResponse"), [
      { method: "authorizeVoiceResponse", input: { sessionId: 17n, segmentId: "seg-q", contextExchanges: seeded.exchanges } },
    ]);
  } finally {
    await session.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Retrospective Plan 3 Tasks 1-6: cancellation and rollback regressions.
// ---------------------------------------------------------------------------

function deferredVoid(): { readonly promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(): void {
      resolvePromise?.();
    },
  };
}

async function flushMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

for (const abort of ["provider", "overflow", "left"] as const) {
  test(`a stalled retrieval cannot authorize after ${abort} cancels its turn`, async () => {
    const runtime = fakeRuntime();
    const stalled = deferredVoid();
    const realSeed = runtime.seedConversationContext.bind(runtime);
    runtime.seedConversationContext = async (exchanges, operationId) => {
      await realSeed(exchanges, operationId);
      await stalled.promise;
    };
    const h = harness({ runtime, ...(abort === "overflow" ? { maxQueuedEvents: 1 } : {}) });
    try {
      await joined(h);
      runtime.emit(transcript("seg-cancel", "Meetbot, can you summarize that?"));
      await flushMacrotask();

      if (abort === "provider") {
        runtime.emit({ type: "provider_unavailable", detail: "synthetic outage" });
      } else if (abort === "left") {
        h.bridge.emit(h.bridge.event({ type: "left", reason: "ended" }));
      } else {
        for (let i = 0; i < 4; i += 1) {
          h.bridge.emit(h.bridge.event({ type: "media_connected", endpoint: "udp://127.0.0.1:40001" }));
        }
      }
      await flushMacrotask();
      stalled.resolve();
      await h.session.settled();

      assert.equal(runtime.callsOf("authorizeVoiceResponse").length, 0);
      assert.equal(h.session.turns().filter((turn) => turn.segmentId === "seg-cancel").length, 1);
      assert.ok(
        runtime
          .callsOf("skipVoiceResponse")
          .some((call) => call.method === "skipVoiceResponse" && call.input.segmentId === "seg-cancel"),
      );
    } finally {
      await h.cleanup();
    }
  });
}

for (const failedMethod of ["seedConversationContext", "authorizeVoiceResponse"] as const) {
  test(`a rejected ${failedMethod} settles the turn once and fail-closes it`, async () => {
    const runtime = fakeRuntime();
    const failure = new Error(`synthetic ${failedMethod} failure`);
    if (failedMethod === "seedConversationContext") {
      runtime.seedConversationContext = async () => {
        throw failure;
      };
    } else {
      runtime.authorizeVoiceResponse = async () => {
        throw failure;
      };
    }
    const h = harness({ runtime });
    try {
      await joined(h);
      runtime.emit(transcript("seg-reject", "Meetbot, can you summarize that?"));
      await h.session.settled();

      assert.deepEqual(
        h.session.turns().filter((turn) => turn.segmentId === "seg-reject").map((turn) => turn.outcome),
        ["failed"],
      );
      assert.ok(
        runtime
          .callsOf("skipVoiceResponse")
          .some((call) => call.method === "skipVoiceResponse" && call.input.segmentId === "seg-reject"),
      );
    } finally {
      await h.cleanup();
    }
  });
}

test("a throwing second subscription rolls back the lease, first subscription, runtime, and coordinator state", async () => {
  const h = harness();
  const subscriptionFailure = new Error("synthetic runtime subscription failure");
  const realSubscribe = h.runtime.subscribe.bind(h.runtime);
  h.runtime.subscribe = () => {
    throw subscriptionFailure;
  };
  try {
    await assert.rejects(() => h.session.join(), (error: unknown) => error === subscriptionFailure);
    assert.equal(h.coordinator.activeBridgeLease(IDENTITY.occurrenceId), null);
    assert.equal(h.bridge.subscriberCount(), 0);
    assert.equal(h.runtime.subscriberCount(), 0);
    assert.equal(h.coordinator.get(IDENTITY.occurrenceId)?.state, "failed");
    assert.equal(h.runtime.callsOf("close").length, 0, "a runtime that never started is not closed");
  } finally {
    h.runtime.subscribe = realSubscribe;
    await h.cleanup();
  }
});

test("a lease-acquisition failure leaves no subscription, remote command, or runtime side effect", async () => {
  const h = harness();
  const failure = new Error("synthetic lease acquisition failure");
  const coordinator = h.coordinator as unknown as { acquireBridgeLease: typeof h.coordinator.acquireBridgeLease };
  const original = coordinator.acquireBridgeLease;
  coordinator.acquireBridgeLease = () => { throw failure; };
  try {
    await assert.rejects(() => h.session.join(), (error: unknown) => error === failure);
    assert.equal(h.coordinator.get(IDENTITY.occurrenceId)?.state, "failed");
    assert.equal(h.coordinator.activeBridgeLease(IDENTITY.occurrenceId), null);
    assert.equal(h.bridge.subscriberCount(), 0);
    assert.equal(h.runtime.subscriberCount(), 0);
    assert.equal(h.bridge.sent.length, 0);
    assert.equal(h.runtime.callsOf("startVoiceSession").length, 0);
  } finally { coordinator.acquireBridgeLease = original; await h.cleanup(); }
});

test("a throwing first bridge subscription rolls back its lease without starting runtime", async () => {
  const h = harness();
  const failure = new Error("synthetic bridge subscription failure");
  const original = h.bridge.subscribe.bind(h.bridge);
  h.bridge.subscribe = () => { throw failure; };
  try {
    await assert.rejects(() => h.session.join(), (error: unknown) => error === failure);
    assert.equal(h.coordinator.get(IDENTITY.occurrenceId)?.state, "failed");
    assert.equal(h.coordinator.activeBridgeLease(IDENTITY.occurrenceId), null);
    assert.equal(h.bridge.subscriberCount(), 0);
    assert.equal(h.runtime.subscriberCount(), 0);
    assert.equal(h.bridge.sent.length, 0);
    assert.equal(h.runtime.callsOf("startVoiceSession").length, 0);
  } finally { h.bridge.subscribe = original; await h.cleanup(); }
});

test("a joined session closes the runtime on terminal left and on dispose", async () => {
  const h = harness();
  try {
    await joined(h);
    h.bridge.emit(h.bridge.event({ type: "left", reason: "ended" }));
    await h.session.settled();
    assert.equal(h.runtime.callsOf("close").length, 1);
    await h.session.dispose();
    assert.equal(h.runtime.callsOf("close").length, 1, "cleanup must be idempotent");
  } finally {
    await h.cleanup();
  }
});
