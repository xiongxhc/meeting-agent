import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { RedactedSecret, type MeetingAgentConfig } from "../src/config.ts";
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
    } finally {
      application.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
