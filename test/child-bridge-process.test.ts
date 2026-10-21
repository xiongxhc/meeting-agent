import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, existsSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createChildBridgeSlot } from "../src/adapters/child-bridge-process.ts";
import { validateCustodyBinding } from "../src/contracts/bridge-process-outcome-v1.ts";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { parseEventV2 } from "../src/contracts/bridge-session-v2.ts";
import type { BridgeCommandMessage } from "../src/contracts/bridge-session-v1.ts";

const fixture = JSON.parse(readFileSync(new URL("../spikes/feishu/fixtures/process/config-v2.json", import.meta.url), "utf8"));
const binding = validateCustodyBinding(fixture.custody);
test("actual child private pipe handles fragmented outcome and rejects duplicate/truncated/wrong/oversized/absent results", async () => {
  for (const mode of ["fragmented", "duplicate", "duplicate-key", "conflicting", "truncated", "wrong", "oversized", "exit", "environment"]) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "custody-child-"));
    const configPath = path.join(dir, "static.json");
    const fields = { ...fixture }; delete fields.custody;
    writeFileSync(configPath, JSON.stringify({ ...fields, schema: "feishu-bridge-config/v1", bundleVersion: mode }), { mode: 0o600 });
    process.env.RUNTIME_SECRET = "synthetic-canary"; process.env.FEISHU_APP_SECRET = "synthetic-canary";
    process.env.DYLD_TEST_CANARY = "synthetic-canary";
    const oldNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = "--no-warnings";
    try {
      const slot = createChildBridgeSlot({ physicalClientId: binding.physicalClientId, bridgeId: "bridge", executable: process.execPath,
        argv: [path.resolve("test/fixtures/custody-child.mjs")], staticConfigPath: configPath, cooperativeGraceMs: 1000 });
      const child = await slot.launch(binding);
      const first = child.shutdown();
      assert.equal(child.shutdown(), first);
      const result = await first;
      assert.equal(result.reaped, true);
      if (["fragmented", "environment"].includes(mode)) {
        assert.equal(result.failure, null); assert.equal(result.outcome?.outcome, "no_join_action");
      } else { assert.notEqual(result.failure, null); assert.equal(result.outcome, null); }
      assert.deepEqual(readdirSync(dir), ["static.json"]);
    } finally {
      delete process.env.RUNTIME_SECRET; delete process.env.FEISHU_APP_SECRET; delete process.env.DYLD_TEST_CANARY;
      if (oldNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldNodeOptions;
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
test("ordinary nonzero exit is an independent durable diagnostic, never departure proof or veto", async () => {
  for (const mode of ["failed-outcome", "confirmed-exit2", "unconfirmed-exit2", "malformed-exit2", "wrong-exit2", "protocol-exit2", "forced-exit2", "signal-outcome"]) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "custody-exit-audit-"));
    const configPath = path.join(dir, "static.json"), filename = path.join(dir, "orchestration.db");
    const fields = { ...fixture }; delete fields.custody;
    writeFileSync(configPath, JSON.stringify({ ...fields, schema: "feishu-bridge-config/v1", bundleVersion: mode, evidenceRoot: dir }));
    const store = openSessionStore({ filename });
    try {
      store.claimPhysicalClient(binding, 1);
      const child = await createChildBridgeSlot({ physicalClientId: binding.physicalClientId, bridgeId: "bridge", executable: process.execPath,
        argv: [path.resolve("test/fixtures/custody-child.mjs")], staticConfigPath: configPath, cooperativeGraceMs: 1000 }).launch(binding);
      const result = await child.shutdown();
      assert.equal(result.reaped, true);
      const positive = ["failed-outcome", "confirmed-exit2"].includes(mode);
      if (positive) assert.equal(result.failure, null);
      else if (mode !== "unconfirmed-exit2") assert.notEqual(result.failure, null);
      assert.equal(result.exitDiagnostic, mode === "signal-outcome" ? null : "nonzero_exit");
      store.recordPhysicalOutcome(binding, result, 2); store.close();
      const reopened = openSessionStore({ filename });
      try {
        const row = reopened.listPhysicalCustody()[0]!;
        assert.equal(row.state, positive ? "cleared" : "quarantined");
        assert.equal(row.exitDiagnostic, result.exitDiagnostic);
        assert.equal(row.outcomeFailure, result.failure);
      } finally { reopened.close(); }
      const pid = Number(readFileSync(path.join(dir, "child.pid"), "utf8"));
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});
test("actual hung/flooding child is bounded and owned process is reaped", async () => {
  for (const mode of ["hung", "flood", "early-outcome"]) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "custody-hung-"));
    const configPath = path.join(dir, "static.json");
    const fields = { ...fixture }; delete fields.custody;
    writeFileSync(configPath, JSON.stringify({ ...fields, schema: "feishu-bridge-config/v1", bundleVersion: mode, evidenceRoot: dir }));
    try {
      const child = await createChildBridgeSlot({ physicalClientId: binding.physicalClientId, bridgeId: "bridge", executable: process.execPath,
        argv: [path.resolve("test/fixtures/custody-child.mjs")], staticConfigPath: configPath, cooperativeGraceMs: 1000 }).launch(binding);
      const start = performance.now(); const result = await child.shutdown();
      assert.equal(result.reaped, true); assert.notEqual(result.failure, null);
      assert.ok(performance.now() - start < 4500);
      const pid = Number(readFileSync(path.join(dir, "child.pid"), "utf8"));
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      const generated = readFileSync(path.join(dir, "child.config-path"), "utf8");
      assert.equal(existsSync(generated), false); assert.equal(existsSync(path.dirname(generated)), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("private launch rejects unsafe static input and malformed binding without changing operator config", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "custody-admission-"));
  const configPath = path.join(dir, "config.json"), linked = path.join(dir, "linked.json");
  const fields = { ...fixture }; delete fields.custody; fields.schema = "feishu-bridge-config/v1";
  writeFileSync(configPath, JSON.stringify(fields)); symlinkSync(configPath, linked);
  const options = { physicalClientId: binding.physicalClientId, bridgeId: "bridge", executable: process.execPath,
    argv: [path.resolve("test/fixtures/custody-child.mjs")], staticConfigPath: configPath };
  try {
    const before = readFileSync(configPath, "utf8");
    await assert.rejects(createChildBridgeSlot({ ...options, staticConfigPath: linked }).launch(binding));
    await assert.rejects(createChildBridgeSlot({ ...options, staticConfigPath: dir }).launch(binding));
    await assert.rejects(createChildBridgeSlot(options).launch({ ...binding, physicalClientId: "foreign" }));
    assert.equal(readFileSync(configPath, "utf8"), before);
    writeFileSync(configPath, "x".repeat(65_537));
    await assert.rejects(createChildBridgeSlot(options).launch(binding));
    assert.throws(() => createChildBridgeSlot({ ...options, executable: "relative" }));
    assert.throws(() => createChildBridgeSlot({ ...options, cooperativeGraceMs: 0 }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- bridge-session/v2 transport (D026) --------------------------------------

const audio = { captureDisplayId: 1, outputDeviceUid: "synthetic-output-device" };
const v2Child = path.resolve("test/fixtures/bridge-v2-child.mjs");
const v2Join = (commandId: string, meetingOccurrenceId = binding.occurrenceId) => ({ schema: "bridge-session/v2", sessionId: binding.bridgeSessionId, commandId,
  type: "join", meetingOccurrenceId, meetingNo: "000000001", leaseId: "lease-1" }) as unknown as BridgeCommandMessage;
const v2Lease = { sessionId: "7", bridgeSessionId: binding.bridgeSessionId, connectEndpoint: "wss://synthetic.invalid/media", credential: "synthetic-credential",
  expiresAtMs: "1000", reconnectWindowMs: "5000", mediaProtocolVersion: 2, captureFormat: "pcm_s16le/24000/1/20ms", timingContract: "capture-clock/v1" };
function staticFields(extra: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...fixture, schema: "feishu-bridge-config/v1", ...extra }; delete fields.custody; return fields;
}
function collect(bridge: { subscribe(listener: (raw: unknown) => void): () => void }, count: number, events: unknown[]): Promise<void> {
  const promise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`only ${events.length} of ${count} events arrived`)), 5000);
    const check = () => { if (events.length >= count) { clearTimeout(timer); unsubscribe(); resolve(); } };
    const unsubscribe = bridge.subscribe((raw) => { events.push(raw); check(); });
    check();
  });
  promise.catch(() => {}); // awaited by the test; never an unhandled rejection after a failed send
  return promise;
}

test("v1 default still rejects a v2 command and launches the child on feishu-bridge-config/v2", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bridge-v2-default-"));
  const configPath = path.join(dir, "static.json");
  writeFileSync(configPath, JSON.stringify(staticFields({ evidenceRoot: dir })), { mode: 0o600 });
  try {
    const child = await createChildBridgeSlot({ physicalClientId: binding.physicalClientId, bridgeId: "bridge", executable: process.execPath,
      argv: [v2Child], staticConfigPath: configPath, cooperativeGraceMs: 1000 }).launch(binding);
    await assert.rejects(child.bridge.send(v2Join("c1")), /bridge_control_rejected/);
    const result = await child.shutdown();
    assert.equal(result.reaped, true); assert.equal(result.failure, null); assert.equal(result.outcome?.outcome, "no_join_action");
    const launched = JSON.parse(readFileSync(path.join(dir, "child.config.json"), "utf8"));
    assert.equal(launched.schema, "feishu-bridge-config/v2"); assert.equal(Object.hasOwn(launched, "audio"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("protocol v2 accepts the session's v2 join, yields v2 events through subscribe and launches on feishu-bridge-config/v3 with audio", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bridge-v2-accept-"));
  const configPath = path.join(dir, "static.json");
  const fields = staticFields({ evidenceRoot: dir, audio });
  writeFileSync(configPath, JSON.stringify(fields), { mode: 0o600 });
  try {
    const child = await createChildBridgeSlot({ physicalClientId: binding.physicalClientId, bridgeId: "bridge", executable: process.execPath,
      argv: [v2Child], staticConfigPath: configPath, cooperativeGraceMs: 1000, protocol: "bridge-session/v2" }).launch(binding);
    const events: unknown[] = [];
    const first = collect(child.bridge, 3, events);
    await child.bridge.send(v2Join("c1"));
    await first;
    const typed = events.map((raw) => parseEventV2(raw));
    assert.deepEqual(typed.map((event) => event.type), ["joined", "ui_snapshot", "command_result"]);
    assert.deepEqual(typed.map((event) => event.sequence), [1, 2, 3]);
    assert.ok(typed.every((event) => event.schema === "bridge-session/v2" && event.sessionId === binding.bridgeSessionId));
    assert.deepEqual(events[2], { schema: "bridge-session/v2", sessionId: binding.bridgeSessionId, sequence: 3, observedAt: "2026-09-02T14:01:00.000Z", type: "command_result", commandId: "c1", outcome: "ok", detail: null });
    const second = collect(child.bridge, 4, events);
    await child.bridge.send({ schema: "bridge-session/v2", sessionId: binding.bridgeSessionId, commandId: "c2", type: "connect_media", mediaLease: v2Lease } as unknown as BridgeCommandMessage);
    await second;
    const media = parseEventV2(events[3]);
    assert.equal(media.type, "command_result");
    if (media.type === "command_result") { assert.equal(media.commandId, "c2"); assert.equal(media.outcome, "failed"); }
    await assert.rejects(child.bridge.send({ ...v2Join("c3"), schema: "bridge-session/v1" }), /bridge_control_rejected/);
    await assert.rejects(child.bridge.send(v2Join("c4", "other-meeting@2026-09-02T14:00:00Z")), /bridge_control_rejected/);
    await assert.rejects(child.bridge.send(v2Join("c1")), /bridge_control_rejected/);
    await assert.rejects(child.bridge.send({ schema: "bridge-session/v2", sessionId: binding.bridgeSessionId, commandId: "c5", type: "connect_media",
      endpoint: "wss://x", sessionToken: "t", format: "pcm_s16le/24000/1/20ms", expiresAt: "2026-09-02T14:01:00.000Z" } as unknown as BridgeCommandMessage), /bridge_control_rejected/);
    const result = await child.shutdown();
    assert.equal(result.reaped, true); assert.equal(result.failure, null); assert.equal(result.exitDiagnostic, null);
    assert.equal(result.outcome?.outcome, "departure_unconfirmed"); assert.equal(result.outcome?.bridgeSessionId, binding.bridgeSessionId);
    assert.equal(events.length, 4);
    const launched = JSON.parse(readFileSync(path.join(dir, "child.config.json"), "utf8"));
    assert.equal(launched.schema, "feishu-bridge-config/v3");
    assert.deepEqual(launched.custody, binding);
    assert.deepEqual(launched.audio, audio);
    assert.deepEqual(Object.keys(launched).sort(), [...Object.keys(fields), "custody"].sort());
    for (const key of Object.keys(fields)) if (key !== "schema") assert.deepEqual(launched[key], fields[key]);
    const generated = readFileSync(path.join(dir, "child.config-path"), "utf8");
    assert.equal(existsSync(generated), false); assert.equal(existsSync(path.dirname(generated)), false);
    assert.throws(() => process.kill(Number(readFileSync(path.join(dir, "child.pid"), "utf8")), 0), { code: "ESRCH" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("v2 slot refuses a static file without the exact audio object before any spawn, and v1 refuses audio", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bridge-v2-refuse-"));
  const configPath = path.join(dir, "static.json");
  const oldTmp = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  try {
    const cases: [string, Record<string, unknown>, "bridge-session/v1" | "bridge-session/v2"][] = [
      ["missing", staticFields({ evidenceRoot: dir }), "bridge-session/v2"],
      ["not-object", staticFields({ evidenceRoot: dir, audio: "1/uid" }), "bridge-session/v2"],
      ["array", staticFields({ evidenceRoot: dir, audio: [1, "uid"] }), "bridge-session/v2"],
      ["extra-key", staticFields({ evidenceRoot: dir, audio: { ...audio, extra: 1 } }), "bridge-session/v2"],
      ["missing-uid", staticFields({ evidenceRoot: dir, audio: { captureDisplayId: 1 } }), "bridge-session/v2"],
      ["display-zero", staticFields({ evidenceRoot: dir, audio: { ...audio, captureDisplayId: 0 } }), "bridge-session/v2"],
      ["display-bool", staticFields({ evidenceRoot: dir, audio: { ...audio, captureDisplayId: true } }), "bridge-session/v2"],
      ["display-fraction", staticFields({ evidenceRoot: dir, audio: { ...audio, captureDisplayId: 1.5 } }), "bridge-session/v2"],
      ["display-string", staticFields({ evidenceRoot: dir, audio: { ...audio, captureDisplayId: "1" } }), "bridge-session/v2"],
      ["display-overflow", staticFields({ evidenceRoot: dir, audio: { ...audio, captureDisplayId: 4_294_967_296 } }), "bridge-session/v2"],
      ["uid-empty", staticFields({ evidenceRoot: dir, audio: { ...audio, outputDeviceUid: "" } }), "bridge-session/v2"],
      ["uid-long", staticFields({ evidenceRoot: dir, audio: { ...audio, outputDeviceUid: "x".repeat(513) } }), "bridge-session/v2"],
      ["uid-nul", staticFields({ evidenceRoot: dir, audio: { ...audio, outputDeviceUid: "a b" } }), "bridge-session/v2"],
      ["uid-number", staticFields({ evidenceRoot: dir, audio: { ...audio, outputDeviceUid: 7 } }), "bridge-session/v2"],
      ["v1-with-audio", staticFields({ evidenceRoot: dir, audio }), "bridge-session/v1"],
    ];
    for (const [label, fields, protocol] of cases) {
      const bytes = JSON.stringify(fields);
      writeFileSync(configPath, bytes, { mode: 0o600 });
      await assert.rejects(createChildBridgeSlot({ physicalClientId: binding.physicalClientId, bridgeId: "bridge", executable: process.execPath,
        argv: [v2Child], staticConfigPath: configPath, cooperativeGraceMs: 1000, protocol }).launch(binding), /invalid_bridge_static_config/, label);
      assert.deepEqual(readdirSync(dir), ["static.json"], label);
      assert.equal(readFileSync(configPath, "utf8"), bytes, label);
    }
    assert.throws(() => createChildBridgeSlot({ physicalClientId: binding.physicalClientId, bridgeId: "bridge", executable: process.execPath,
      argv: [v2Child], staticConfigPath: configPath, protocol: "bridge-session/v3" as "bridge-session/v2" }), /invalid_bridge_launch_config/);
  } finally {
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v2 slot keeps the fd 3 outcome, environment allowlist and reap behaviour", async () => {
  for (const mode of ["allowlist", "hung"]) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "bridge-v2-owned-"));
    const configPath = path.join(dir, "static.json");
    writeFileSync(configPath, JSON.stringify(staticFields({ evidenceRoot: dir, audio, bundleVersion: mode })), { mode: 0o600 });
    process.env.RUNTIME_SECRET = "synthetic-canary"; process.env.FEISHU_APP_SECRET = "synthetic-canary"; process.env.DYLD_TEST_CANARY = "synthetic-canary";
    const oldNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = "--no-warnings";
    try {
      const child = await createChildBridgeSlot({ physicalClientId: binding.physicalClientId, bridgeId: "bridge", executable: process.execPath,
        argv: [v2Child], staticConfigPath: configPath, cooperativeGraceMs: 1000, protocol: "bridge-session/v2" }).launch(binding);
      const start = performance.now();
      const result = await child.shutdown();
      assert.equal(result.reaped, true);
      if (mode === "allowlist") {
        // The child exits 7 without an outcome when any canary reaches its environment.
        assert.equal(result.failure, null); assert.equal(result.exitDiagnostic, null); assert.equal(result.outcome?.outcome, "no_join_action");
      } else {
        assert.notEqual(result.failure, null); assert.equal(result.outcome, null);
        assert.ok(performance.now() - start < 4500);
      }
      assert.throws(() => process.kill(Number(readFileSync(path.join(dir, "child.pid"), "utf8")), 0), { code: "ESRCH" });
      const generated = readFileSync(path.join(dir, "child.config-path"), "utf8");
      assert.equal(existsSync(generated), false); assert.equal(existsSync(path.dirname(generated)), false);
    } finally {
      delete process.env.RUNTIME_SECRET; delete process.env.FEISHU_APP_SECRET; delete process.env.DYLD_TEST_CANARY;
      if (oldNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldNodeOptions;
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ---- live capture is not killed for control-plane noise; death is reported ----

async function noiseChild(mode: "noisy" | "garbage" | "crash" | "dense" | "spread", invalidLineWindowMs?: number) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bridge-v2-noise-"));
  const configPath = path.join(dir, "static.json");
  writeFileSync(configPath, JSON.stringify(staticFields({ evidenceRoot: dir, audio, bundleVersion: mode })), { mode: 0o600 });
  const child = await createChildBridgeSlot({ physicalClientId: binding.physicalClientId, bridgeId: "bridge", executable: process.execPath,
    argv: [v2Child], staticConfigPath: configPath, cooperativeGraceMs: 1000, protocol: "bridge-session/v2",
    ...(invalidLineWindowMs === undefined ? {} : { invalidLineWindowMs }) }).launch(binding);
  let closed = 0, eventsAtClose = -1;
  const events: unknown[] = [];
  const closedOnce = new Promise<void>((resolve) => {
    child.bridge.onClosed!(() => { closed += 1; eventsAtClose = events.length; resolve(); });
  });
  return { dir, child, events, closedOnce, closed: () => closed, eventsAtClose: () => eventsAtClose };
}

test("malformed, oversized and replayed control lines and stderr volume are dropped and counted; the capturing bridge keeps running", async () => {
  const c = await noiseChild("noisy");
  try {
    const first = collect(c.child.bridge, 3, c.events);
    await c.child.bridge.send(v2Join("c1"));
    await first;
    assert.deepEqual(c.events.map((raw) => parseEventV2(raw).type), ["joined", "ui_snapshot", "command_result"], "only valid lines are forwarded");
    const second = collect(c.child.bridge, 4, c.events);
    await c.child.bridge.send({ schema: "bridge-session/v2", sessionId: binding.bridgeSessionId, commandId: "c2", type: "connect_media", mediaLease: v2Lease } as unknown as BridgeCommandMessage);
    await second;
    assert.equal(c.closed(), 0, "the child was not killed");
    const noise = c.child.controlNoise!();
    assert.equal(noise.invalidLines, 3);
    assert.ok(noise.stderrBytes >= 65_536);
    const result = await c.child.shutdown();
    assert.equal(result.reaped, true);
    assert.equal(result.failure, "protocol_failed", "an invalid control line still blocks custody clearing");
  } finally { rmSync(c.dir, { recursive: true, force: true }); }
});

test("sustained protocol violation still ends the bridge, and the closure is reported", async () => {
  const c = await noiseChild("garbage");
  try {
    await c.child.bridge.send(v2Join("c1"));
    await c.closedOnce;
    assert.equal(c.closed(), 1);
    const result = await c.child.shutdown();
    assert.equal(result.reaped, true);
    assert.equal(result.failure, "protocol_failed");
  } finally { rmSync(c.dir, { recursive: true, force: true }); }
});

test("a bridge child that exits on its own reports closure once, after every event it wrote", async () => {
  const c = await noiseChild("crash");
  try {
    c.child.bridge.subscribe((raw) => { c.events.push(raw); });
    await c.child.bridge.send(v2Join("c1"));
    await c.closedOnce;
    assert.equal(c.eventsAtClose(), 3, "joined, ui_snapshot and command_result arrive before the closure");
    const result = await c.child.shutdown();
    assert.equal(result.reaped, true);
    assert.notEqual(result.failure, null, "no outcome, so custody stays quarantined");
    assert.equal(c.closed(), 1);
  } finally { rmSync(c.dir, { recursive: true, force: true }); }
});

test("invalid lines are limited by rate, not by a whole-meeting total: a spread-out trickle never ends capture, a dense burst does", async () => {
  const spread = await noiseChild("spread", 200);
  try {
    const all = collect(spread.child.bridge, 24, spread.events);
    await spread.child.bridge.send(v2Join("c1"));
    await all;
    assert.equal(spread.closed(), 0, "20 invalid lines, at most 10 per window, never end the bridge");
    assert.equal(spread.child.controlNoise!().invalidLines, 20);
    await spread.child.shutdown();
  } finally { rmSync(spread.dir, { recursive: true, force: true }); }
  const dense = await noiseChild("dense", 60_000);
  try {
    await dense.child.bridge.send(v2Join("c1"));
    await dense.closedOnce;
    assert.equal(dense.child.controlNoise!().invalidLines, 17, "the 17th invalid line inside one window ends it");
    assert.equal((await dense.child.shutdown()).failure, "protocol_failed");
  } finally { rmSync(dense.dir, { recursive: true, force: true }); }
});
