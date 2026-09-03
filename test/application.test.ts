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
        bridgeFor: () => ({ bridge, bridgeId: "synthetic-mac-bridge", bridgeSessionId: "application-bridge-session" }),
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
      const session = application.createSession(identity);
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
    const app = createMeetingAgentApplication({ config, adapters: { bridgeFor: () => ({ bridge, bridgeId: "bridge", bridgeSessionId: "application-close-bridge" }), runtimeFor: () => runtime } });
    const session = app.createSession(buildMeetingIdentity({ providerMeetingId: "close", meetingNo: "1", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "close", organizer: null }));
    await session.join();
    await app.close();
    await session.settled();
    assert.equal(bridge.subscriberCount(), 0);
    assert.equal(runtime.subscriberCount(), 0);
    assert.equal(runtime.callsOf("close").length, 1);
    assert.throws(() => app.createSession(buildMeetingIdentity({ providerMeetingId: "later", meetingNo: "2", occurrenceStartedAt: "2026-09-02T14:01:00Z", title: "later", organizer: null })), /closed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
