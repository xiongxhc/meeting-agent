import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createMeetingAgentApplication, RedactedSecret, type MeetingAgentConfig } from "../src/application.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import { fakeBridge, fakeRuntime } from "./lib/session-fakes.ts";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import type { CustodyBinding } from "../src/contracts/bridge-process-outcome-v1.ts";
import type { OwnedBridgeProcess } from "../src/ports/bridge-process.ts";
import { createChildBridgeSlot } from "../src/adapters/child-bridge-process.ts";

function configAt(dir: string): MeetingAgentConfig {
  return {
    feishu: { appId: "synthetic", appSecret: new RedactedSecret("synthetic") },
    conversationRuntime: { endpoint: "https://runtime.example.invalid", profile: "online" },
    agentIdentity: { aliases: ["Meetbot"] },
    dataPaths: { recordingsDir: path.join(dir, "recordings"), outboxDir: path.join(dir, "outbox"), receiptsDir: path.join(dir, "receipts"), teamVaultDir: path.join(dir, "vault") },
  };
}
const identity = (id: string) => buildMeetingIdentity({ providerMeetingId: id, meetingNo: "000000001", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "synthetic", organizer: null });

test("duplicate provisioning labels reject before filesystem or launch side effects", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "custody-duplicate-config-"));
  let launched = false;
  const slot = { physicalClientId: "slot", bridgeId: "bridge", async launch(): Promise<OwnedBridgeProcess> { launched = true; throw new Error("not reached"); } };
  try {
    assert.throws(() => createMeetingAgentApplication({ config: configAt(dir), adapters: {
      bridgeSlots: [slot, { ...slot, bridgeId: "other" }], bridgeIdFor: () => "bridge", runtimeFor: () => fakeRuntime(),
    } }), /duplicate slot/);
    assert.equal(launched, false); assert.equal(existsSync(path.join(dir, "outbox")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("one unresolved physical slot does not block another independently configured slot", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "custody-two-slots-"));
  const logicalId = (id: string) => "逻辑桥".repeat(100) + id;
  const app = createMeetingAgentApplication({ config: configAt(dir), maxConcurrentSessions: 2, adapters: {
    bridgeSlots: ["first", "second"].map((id) => ({ physicalClientId: id, bridgeId: logicalId(id), async launch(binding) { return {
      bridge: fakeBridge(binding.bridgeSessionId), async shutdown() { return { reaped: true, exitDiagnostic: null, outcome: null, failure: "outcome_missing" as const }; },
    }; } })), bridgeIdFor: (meeting) => logicalId(meeting.providerMeetingId === "first" ? "first" : "second"), runtimeFor: () => fakeRuntime(),
  } });
  try {
    const first = await app.createSession(identity("first")); await first.dispose();
    await assert.rejects(app.createSession(identity("first")), /quarantined/);
    const second = await app.createSession(identity("second")); assert.equal(app.liveSessionCount(), 1); await second.dispose();
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("application refuses a second launch while the same physical slot has unresolved custody", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "physical-custody-app-"));
  let launches = 0;
  const app = createMeetingAgentApplication({ config: configAt(dir), adapters: {
    bridgeSlots: [{ physicalClientId: "same-physical-slot", bridgeId: "bridge", async launch(binding) {
      launches += 1; return { bridge: fakeBridge(binding.bridgeSessionId), async shutdown() { return { reaped: true, exitDiagnostic: null, outcome: null, failure: "outcome_missing" }; } };
    } }], bridgeIdFor: () => "bridge",
    runtimeFor: () => fakeRuntime(),
  } });
  try {
    await app.createSession(identity("first"));
    await assert.rejects(app.createSession(identity("second")), /physical_client_quarantined/);
    assert.equal(launches, 1, "durable refusal must happen before another process can launch");
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("close awaits a claimed pending launch, reaps the late child and persists before store close", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "custody-pending-launch-"));
  const config = configAt(dir);
  let resolveLaunch!: (child: OwnedBridgeProcess) => void;
  let claimed: CustodyBinding | undefined, stopped = 0, runtimeConstructed = 0;
  const pending = new Promise<OwnedBridgeProcess>((resolve) => { resolveLaunch = resolve; });
  const app = createMeetingAgentApplication({ config, adapters: {
    bridgeSlots: [{ physicalClientId: "slot", bridgeId: "bridge", launch(binding) {
      const verifier = openSessionStore({ filename: path.join(config.dataPaths.outboxDir, "orchestration.db") });
      try { assert.deepEqual(verifier.listPhysicalCustody().map((row) => row.physicalGenerationId), [binding.physicalGenerationId]); }
      finally { verifier.close(); }
      claimed = binding; return pending;
    } }], bridgeIdFor: () => "bridge", runtimeFor: () => { runtimeConstructed += 1; return fakeRuntime(); },
  } });
  try {
    const creation = app.createSession(identity("late"));
    const refused = assert.rejects(creation, /closed/);
    let closed = false;
    const closing = app.close().then(() => { closed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    assert.ok(claimed);
    resolveLaunch({ bridge: fakeBridge(claimed.bridgeSessionId), async shutdown() {
      stopped += 1;
      return { reaped: true, exitDiagnostic: null, failure: null, outcome: { schema: "bridge-process-outcome/v1", ...claimed!, outcome: "no_join_action", reason: "join_not_issued", observedAt: "2026-09-02T14:01:00Z" } };
    } });
    await refused; await closing;
    assert.equal(stopped, 1); assert.equal(runtimeConstructed, 0); assert.equal(app.liveSessionCount(), 0);
    const verifier = openSessionStore({ filename: path.join(config.dataPaths.outboxDir, "orchestration.db") });
    try { assert.equal(verifier.listPhysicalCustody()[0]?.state, "cleared"); }
    finally { verifier.close(); }
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("post-launch construction failure still awaits cleanup and failed outcome commit retains quarantine", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "custody-construction-"));
  const store = openSessionStore({ filename: path.join(dir, "db") });
  let stopped = 0;
  const app = createMeetingAgentApplication({ config: configAt(dir), store, adapters: {
    bridgeSlots: [{ physicalClientId: "slot", bridgeId: "bridge", async launch(binding) { return {
      bridge: fakeBridge(binding.bridgeSessionId), async shutdown() { stopped += 1; return { reaped: true, exitDiagnostic: null, failure: null, outcome: {
        schema: "bridge-process-outcome/v1", ...binding, outcome: "no_join_action", reason: "join_not_issued", observedAt: "2026-09-02T14:01:00Z",
      } }; },
    }; } }], bridgeIdFor: () => "bridge", runtimeFor: () => { throw new Error("synthetic construction failure"); },
  } });
  store.recordPhysicalOutcome = () => { throw new Error("synthetic commit failure"); };
  try {
    await assert.rejects(app.createSession(identity("failure")), /synthetic construction/);
    assert.equal(stopped, 1);
    await assert.rejects(app.close(), /cleanup_unconfirmed/);
    assert.equal(store.listPhysicalCustody()[0]?.state, "quarantined");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("application close cancels blocked real child sends alongside disposal and persists quarantine before closing", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "custody-application-child-"));
  const staticConfig = JSON.parse(readFileSync(new URL("../spikes/feishu/fixtures/process/config-v2.json", import.meta.url), "utf8"));
  delete staticConfig.custody;
  staticConfig.schema = "feishu-bridge-config/v1"; staticConfig.bundleVersion = "hung"; staticConfig.evidenceRoot = dir;
  const staticConfigPath = path.join(dir, "static.json"); writeFileSync(staticConfigPath, JSON.stringify(staticConfig));
  const config = configAt(dir);
  const realSlot = createChildBridgeSlot({ physicalClientId: "slot", bridgeId: "bridge", executable: process.execPath,
    argv: [path.resolve("test/fixtures/custody-child.mjs")], staticConfigPath, cooperativeGraceMs: 1000 });
  let sending!: () => void;
  const started = new Promise<void>((resolve) => { sending = resolve; });
  const app = createMeetingAgentApplication({ config, adapters: {
    bridgeSlots: [{ ...realSlot, async launch(binding) {
      const owned = await realSlot.launch(binding), send = owned.bridge.send.bind(owned.bridge);
      return { shutdown: owned.shutdown, bridge: { ...owned.bridge, async send(message) {
        if (message.type === "connect_media") {
          sending();
          // Fill only this owned synthetic child's stdin; no desktop/client is involved.
          for (let index = 0; index < 32; index += 1) await send({ ...message, commandId: `blocked-${index}`, sessionToken: "x".repeat(60_000) });
        }
        return send(message);
      } } };
    } }], bridgeIdFor: () => "bridge", runtimeFor: () => fakeRuntime(),
  } });
  try {
    const session = await app.createSession(identity("blocked-child"));
    let joinSettled = false;
    const joining = session.join();
    const joined = joining.then(() => { joinSettled = true; }, () => { joinSettled = true; });
    await started;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(joinSettled, false);
    const closeStart = performance.now();
    await app.close(); await joined;
    assert.ok(performance.now() - closeStart < 4500);
    assert.equal(joinSettled, true); assert.equal(app.liveSessionCount(), 0);
    const store = openSessionStore({ filename: path.join(config.dataPaths.outboxDir, "orchestration.db") });
    try { assert.equal(store.listPhysicalCustody()[0]?.state, "quarantined"); assert.notEqual(store.listPhysicalCustody()[0]?.outcomeRecordedAtMs, null); }
    finally { store.close(); }
    const pid = Number(readFileSync(path.join(dir, "child.pid"), "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
