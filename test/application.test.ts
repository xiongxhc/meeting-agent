import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { RedactedSecret, type MeetingAgentConfig } from "../src/application.ts";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import { createMeetingAgentApplication } from "../src/application.ts";
import { fakeBridge, fakeClock, fakeRuntime } from "./lib/session-fakes.ts";
import type { BridgeProcessSlot } from "../src/ports/bridge-process.ts";

function fakeSlot(bridge: ReturnType<typeof fakeBridge>, bridgeId = "bridge"): BridgeProcessSlot {
  return { physicalClientId: bridgeId, bridgeId, async launch(binding) {
    const event = bridge.event.bind(bridge);
    bridge.event = (payload) => ({ ...event(payload), sessionId: binding.bridgeSessionId });
    return { bridge, async shutdown() { return { reaped: true, exitDiagnostic: null, failure: null, outcome: {
      schema: "bridge-process-outcome/v1", ...binding, outcome: "departure_confirmed", reason: "departure_observed", observedAt: "2026-09-02T14:01:00.000Z",
    } }; } };
  } };
}

function deferredVoid(): { readonly promise: Promise<void>; resolve(): void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: () => resolvePromise() };
}

function flushMacrotask(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

test("the supported application composition constructs isolated sessions from injected bridge/runtime adapters", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-agent-application-"));
  try {
    const config: MeetingAgentConfig = {
      feishu: { appId: "synthetic-app", appSecret: new RedactedSecret("synthetic-secret") },
      conversationRuntime: { endpoint: "https://runtime.example.invalid/", profile: "online" },
      agentIdentity: { aliases: ["Meetbot"] },
      dataPaths: {
        recordingsDir: path.join(dir, "recordings"),
        outboxDir: path.join(dir, "outbox"),
        receiptsDir: path.join(dir, "receipts"),
        teamVaultDir: path.join(dir, "vault"),
      },
    };
    writeFileSync(path.join(dir, "secret"), "not used by the application\n");
    const bridge = fakeBridge("application-bridge-session");
    const runtime = fakeRuntime();
    const application = createMeetingAgentApplication({
      config,
      clock: fakeClock(),
      bridgeLeaseTtlMs: 30_000,
      maxConcurrentSessions: 2,
      adapters: {
        bridgeSlots: [fakeSlot(bridge)], bridgeIdFor: () => "bridge",
        runtimeFor: () => runtime,
      },
    });
    try {
      const identity = buildMeetingIdentity({
        providerMeetingId: "application-occurrence",
        meetingNo: "000000001",
        occurrenceStartedAt: "2026-09-02T14:00:00Z",
        title: "Synthetic application composition",
        organizer: null,
      });
      const session = await application.createSession(identity);
      await session.join();
      bridge.emit(bridge.event({ type: "joined", meetingOccurrenceId: identity.occurrenceId }));
      await session.settled();

      assert.equal(application.coordinator.get(identity.occurrenceId)?.state, "listening");
      assert.equal(runtime.callsOf("startVoiceSession").length, 1);

      const firstClose = application.close();
      const secondClose = application.close();
      assert.equal(secondClose, firstClose, "concurrent close callers must await the same cleanup");
      await firstClose;
      await session.settled();
      assert.equal(bridge.subscriberCount(), 0);
      assert.equal(runtime.subscriberCount(), 0);
      assert.equal(runtime.callsOf("close").length, 1);
      const verificationStore = openSessionStore({
        filename: path.join(config.dataPaths.outboxDir, "orchestration.db"),
      });
      try {
        assert.equal(verificationStore.getActiveLease(identity.occurrenceId), null);
      } finally {
        verificationStore.close();
      }
    } finally {
      await application.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the public composition retains configuration exports and closes owned sessions before its store", async () => {
  assert.equal(typeof RedactedSecret, "function");
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-agent-application-close-"));
  try {
    const config: MeetingAgentConfig = {
      feishu: { appId: "synthetic-app", appSecret: new RedactedSecret("synthetic-secret") },
      conversationRuntime: { endpoint: "https://runtime.example.invalid/", profile: "online" },
      agentIdentity: { aliases: ["Meetbot"] },
      dataPaths: { recordingsDir: path.join(dir, "recordings"), outboxDir: path.join(dir, "outbox"), receiptsDir: path.join(dir, "receipts"), teamVaultDir: path.join(dir, "vault") },
    };
    const bridge = fakeBridge("application-close-bridge");
    const runtime = fakeRuntime();
    const app = createMeetingAgentApplication({ config, adapters: { bridgeSlots: [fakeSlot(bridge)], bridgeIdFor: () => "bridge", runtimeFor: () => runtime } });
    const session = await app.createSession(buildMeetingIdentity({ providerMeetingId: "close", meetingNo: "1", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "close", organizer: null }));
    await session.join();
    await app.close();
    await session.settled();
    assert.equal(bridge.subscriberCount(), 0);
    assert.equal(runtime.subscriberCount(), 0);
    assert.equal(runtime.callsOf("close").length, 1);
    await assert.rejects(app.createSession(buildMeetingIdentity({ providerMeetingId: "later", meetingNo: "2", occurrenceStartedAt: "2026-09-02T14:01:00Z", title: "later", organizer: null })), /closed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("application close waits for a stalled join to cancel and clean up before resolving", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-agent-application-join-race-"));
  try {
    const config: MeetingAgentConfig = {
      feishu: { appId: "synthetic-app", appSecret: new RedactedSecret("synthetic-secret") },
      conversationRuntime: { endpoint: "https://runtime.example.invalid/", profile: "online" },
      agentIdentity: { aliases: ["Meetbot"] },
      dataPaths: { recordingsDir: path.join(dir, "recordings"), outboxDir: path.join(dir, "outbox"), receiptsDir: path.join(dir, "receipts"), teamVaultDir: path.join(dir, "vault") },
    };
    const bridge = fakeBridge("application-stalled-join");
    const runtime = fakeRuntime();
    const stalledJoinSend = deferredVoid();
    const realSend = bridge.send.bind(bridge);
    bridge.send = async (message) => {
      if (message.type === "join") await stalledJoinSend.promise;
      await realSend(message);
    };
    const app = createMeetingAgentApplication({
      config,
      adapters: {
        bridgeSlots: [fakeSlot(bridge)], bridgeIdFor: () => "bridge",
        runtimeFor: () => runtime,
      },
    });
    const identity = buildMeetingIdentity({ providerMeetingId: "stalled", meetingNo: "1", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "stalled", organizer: null });
    const session = await app.createSession(identity);
    const joinPromise = session.join();
    await flushMacrotask();

    let closeResolved = false;
    const closePromise = app.close().then(() => { closeResolved = true; });
    await flushMacrotask();
    assert.equal(closeResolved, false, "close must retain an in-flight join until it cannot create side effects");

    stalledJoinSend.resolve();
    await assert.rejects(joinPromise, /disposed|cancelled/i);
    await closePromise;
    assert.equal(runtime.callsOf("startVoiceSession").length, 0);
    assert.deepEqual(bridge.sent.map((command) => command.type), ["join", "leave"]);
    assert.equal(bridge.subscriberCount(), 0);
    assert.equal(runtime.subscriberCount(), 0);

    const verificationStore = openSessionStore({ filename: path.join(config.dataPaths.outboxDir, "orchestration.db") });
    try {
      assert.equal(verificationStore.getActiveLease(identity.occurrenceId), null);
      assert.equal(verificationStore.getSession(identity.occurrenceId)?.state, "failed");
    } finally {
      verificationStore.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("terminal cleanup retains a session until its stalled connect_media send settles", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-agent-application-terminal-join-race-"));
  const stalledConnectMedia = deferredVoid();
  let joinPromise: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;
  try {
    const config: MeetingAgentConfig = {
      feishu: { appId: "synthetic-app", appSecret: new RedactedSecret("synthetic-secret") },
      conversationRuntime: { endpoint: "https://runtime.example.invalid/", profile: "online" },
      agentIdentity: { aliases: ["Meetbot"] },
      dataPaths: { recordingsDir: path.join(dir, "recordings"), outboxDir: path.join(dir, "outbox"), receiptsDir: path.join(dir, "receipts"), teamVaultDir: path.join(dir, "vault") },
    };
    const bridge = fakeBridge("application-terminal-join-race");
    const runtime = fakeRuntime();
    const realSend = bridge.send.bind(bridge);
    let connectMediaStarted = false;
    bridge.send = async (message) => {
      if (message.type === "connect_media") {
        connectMediaStarted = true;
        await stalledConnectMedia.promise;
      }
      await realSend(message);
    };
    const app = createMeetingAgentApplication({
      config,
      adapters: {
        bridgeSlots: [fakeSlot(bridge)], bridgeIdFor: () => "bridge",
        runtimeFor: () => runtime,
      },
    });
    try {
      const identity = buildMeetingIdentity({ providerMeetingId: "terminal-race", meetingNo: "1", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "terminal race", organizer: null });
      const session = await app.createSession(identity);
      joinPromise = session.join();
      await flushMacrotask();
      assert.equal(connectMediaStarted, true, "the join must be stalled inside connect_media");

      bridge.emit(bridge.event({ type: "left", reason: "removed" }));
      await session.settled();

      let closeResolved = false;
      closePromise = app.close().then(() => { closeResolved = true; });
      await flushMacrotask();
      assert.equal(closeResolved, false, "close must wait for the live connect_media send");
      assert.equal(app.liveSessionCount(), 1, "terminal cleanup must retain the in-flight join");
      assert.deepEqual(bridge.sent.map((command) => command.type), ["join"]);

      stalledConnectMedia.resolve();
      await assert.rejects(joinPromise, /disposed|cancelled/i);
      await closePromise;

      assert.equal(app.liveSessionCount(), 0);
      assert.deepEqual(bridge.sent.map((command) => command.type), ["join", "connect_media"]);
      assert.equal(runtime.callsOf("startVoiceSession").length, 1);
      assert.equal(runtime.callsOf("close").length, 1);
      assert.equal(bridge.subscriberCount(), 0);
      assert.equal(runtime.subscriberCount(), 0);

      const commandsAfterClose = bridge.sent.length;
      const runtimeCallsAfterClose = runtime.calls.length;
      await flushMacrotask();
      assert.equal(bridge.sent.length, commandsAfterClose, "no bridge side effect may finish after close");
      assert.equal(runtime.calls.length, runtimeCallsAfterClose, "no runtime side effect may finish after close");

      const verificationStore = openSessionStore({ filename: path.join(config.dataPaths.outboxDir, "orchestration.db") });
      try {
        assert.equal(verificationStore.getActiveLease(identity.occurrenceId), null);
        assert.equal(verificationStore.getSession(identity.occurrenceId)?.state, "failed");
        assert.equal(verificationStore.getSession(identity.occurrenceId)?.terminalReason, "removed");
      } finally {
        verificationStore.close();
      }
    } finally {
      stalledConnectMedia.resolve();
      if (joinPromise !== null) await Promise.allSettled([joinPromise]);
      if (closePromise !== null) await Promise.allSettled([closePromise]);
      await app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("duplicate join rejection preserves the first stalled join for application close", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-agent-application-duplicate-join-race-"));
  const stalledJoinSend = deferredVoid();
  let firstJoinPromise: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;
  try {
    const config: MeetingAgentConfig = {
      feishu: { appId: "synthetic-app", appSecret: new RedactedSecret("synthetic-secret") },
      conversationRuntime: { endpoint: "https://runtime.example.invalid/", profile: "online" },
      agentIdentity: { aliases: ["Meetbot"] },
      dataPaths: { recordingsDir: path.join(dir, "recordings"), outboxDir: path.join(dir, "outbox"), receiptsDir: path.join(dir, "receipts"), teamVaultDir: path.join(dir, "vault") },
    };
    const bridge = fakeBridge("application-duplicate-join-race");
    const runtime = fakeRuntime();
    const realSend = bridge.send.bind(bridge);
    let firstJoinSendStarted = false;
    bridge.send = async (message) => {
      if (message.type === "join") {
        firstJoinSendStarted = true;
        await stalledJoinSend.promise;
      }
      await realSend(message);
    };
    const app = createMeetingAgentApplication({
      config,
      adapters: {
        bridgeSlots: [fakeSlot(bridge)], bridgeIdFor: () => "bridge",
        runtimeFor: () => runtime,
      },
    });
    try {
      const identity = buildMeetingIdentity({ providerMeetingId: "duplicate-race", meetingNo: "1", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "duplicate race", organizer: null });
      const session = await app.createSession(identity);
      firstJoinPromise = session.join();
      await flushMacrotask();
      assert.equal(firstJoinSendStarted, true, "the first join must be stalled inside its send");

      await assert.rejects(session.join(), /already joined|joining/i);

      let closeResolved = false;
      closePromise = app.close().then(() => { closeResolved = true; });
      await flushMacrotask();
      assert.equal(closeResolved, false, "close must still wait for the first join after a duplicate rejection");
      assert.equal(app.liveSessionCount(), 1);
      assert.equal(bridge.sent.length, 0);
      assert.equal(runtime.callsOf("startVoiceSession").length, 0);

      stalledJoinSend.resolve();
      await assert.rejects(firstJoinPromise, /disposed|cancelled/i);
      await closePromise;

      assert.equal(app.liveSessionCount(), 0);
      assert.deepEqual(bridge.sent.map((command) => command.type), ["join", "leave"]);
      assert.equal(runtime.callsOf("startVoiceSession").length, 0);
      assert.equal(runtime.callsOf("close").length, 0);
      assert.equal(bridge.subscriberCount(), 0);
      assert.equal(runtime.subscriberCount(), 0);

      const commandsAfterClose = bridge.sent.length;
      const runtimeCallsAfterClose = runtime.calls.length;
      await flushMacrotask();
      assert.equal(bridge.sent.length, commandsAfterClose, "the first join cannot finish a bridge side effect after close");
      assert.equal(runtime.calls.length, runtimeCallsAfterClose, "the first join cannot start runtime after close");

      const verificationStore = openSessionStore({ filename: path.join(config.dataPaths.outboxDir, "orchestration.db") });
      try {
        assert.equal(verificationStore.getActiveLease(identity.occurrenceId), null);
        assert.equal(verificationStore.getSession(identity.occurrenceId)?.state, "failed");
        assert.equal(verificationStore.getSession(identity.occurrenceId)?.terminalReason, "join_failed");
      } finally {
        verificationStore.close();
      }
    } finally {
      stalledJoinSend.resolve();
      if (firstJoinPromise !== null) await Promise.allSettled([firstJoinPromise]);
      if (closePromise !== null) await Promise.allSettled([closePromise]);
      await app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("completed and explicitly disposed sessions leave application tracking immediately", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-agent-application-retention-"));
  try {
    const config: MeetingAgentConfig = {
      feishu: { appId: "synthetic-app", appSecret: new RedactedSecret("synthetic-secret") },
      conversationRuntime: { endpoint: "https://runtime.example.invalid/", profile: "online" },
      agentIdentity: { aliases: ["Meetbot"] },
      dataPaths: { recordingsDir: path.join(dir, "recordings"), outboxDir: path.join(dir, "outbox"), receiptsDir: path.join(dir, "receipts"), teamVaultDir: path.join(dir, "vault") },
    };
    let generation = 0;
    const bridges = new Map<string, ReturnType<typeof fakeBridge>>();
    const app = createMeetingAgentApplication({
      config,
      adapters: {
        bridgeSlots: [{ physicalClientId: "bridge", bridgeId: "bridge", async launch(binding) {
          generation += 1;
          const id = `retention-${generation}`;
          const bridge = fakeBridge(id);
          bridges.set(id, bridge);
          return fakeSlot(bridge).launch(binding);
        } }], bridgeIdFor: () => "bridge",
        runtimeFor: () => fakeRuntime(),
      },
    });
    const completedIdentity = buildMeetingIdentity({ providerMeetingId: "completed", meetingNo: "1", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "completed", organizer: null });
    const completed = await app.createSession(completedIdentity);
    assert.equal(app.liveSessionCount(), 1);
    await completed.join();
    const completedBridge = bridges.get("retention-1")!;
    completedBridge.emit(completedBridge.event({ type: "joined", meetingOccurrenceId: completedIdentity.occurrenceId }));
    completedBridge.emit(completedBridge.event({ type: "left", reason: "ended" }));
    await completed.settled();
    assert.equal(app.liveSessionCount(), 0);

    const disposedIdentity = buildMeetingIdentity({ providerMeetingId: "disposed", meetingNo: "2", occurrenceStartedAt: "2026-09-02T14:01:00Z", title: "disposed", organizer: null });
    const disposed = await app.createSession(disposedIdentity);
    assert.equal(app.liveSessionCount(), 1);
    await disposed.dispose();
    assert.equal(app.liveSessionCount(), 0);
    await app.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
