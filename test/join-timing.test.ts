import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import { createCoordinator } from "../src/sessions/coordinator.ts";
import { createMeetingSession } from "../src/sessions/meeting-session.ts";
import { JOIN_TIMING_PHASES, markJoinTiming, type JoinTimingObserver, type JoinTimingPhase } from "../src/sessions/join-timing.ts";
import type { VoiceSessionHandle } from "../src/ports/conversation-runtime.ts";
import type { BridgeCommandMessageV2 } from "../src/contracts/bridge-session-v2.ts";
import { fakeRuntime } from "./lib/session-fakes.ts";

const SESSION_PHASES: readonly JoinTimingPhase[] = ["join_entered", "lease_acquired", "reconciliation_started", "timed_control_ready",
  "subscriptions_ready", "join_send_started", "join_send_resolved", "runtime_admission_started", "runtime_admission_resolved", "connect_media_send_started"];

type Mode = "success" | "join" | "runtime";
async function probe(mode: Mode, observer: JoinTimingObserver | undefined, vaultDir?: string) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "join-timing-"));
  const store = openSessionStore({ filename: path.join(directory, "state.db") }); const clock = { now: () => 1000 };
  const identity = buildMeetingIdentity({ providerMeetingId: "synthetic", meetingNo: "000000000", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "Synthetic", organizer: null });
  const coordinator = createCoordinator({ store, clock, bridgeLeaseTtlMs: 30000, maxConcurrentSessions: 1 }); coordinator.discover(identity);
  const lifecycle: string[] = [];
  const original = new Error("PRIVATE-ORIGINAL");
  const handle = { timingContract: "capture-clock/v1", sessionId: 42n, bridgeSessionId: "private-bridge", mediaLease: { sessionId: 42n, mediaProtocolVersion: 3, timingContract: "capture-clock/v1", captureFormat: "pcm_s16le/24000/1/20ms", credential: "PRIVATE-CAPABILITY", connectEndpoint: "PRIVATE-ENDPOINT", expiresAtMs: 60000n, reconnectWindowMs: 10000n } };
  // Interleave a microtask chain with the join so any added await on the join path changes this order.
  const ticks: string[] = [];
  const runtime = { ...fakeRuntime(), currentSessionId: 42n,
    async startVoiceSession() { lifecycle.push(`runtime_start@${ticks.length}`); if (mode === "runtime") throw original; return handle as VoiceSessionHandle; },
    subscribe: () => () => { lifecycle.push("runtime_unsubscribe"); } };
  const bridge = { subscribe() { return () => { lifecycle.push("bridge_unsubscribe"); }; },
    async send(command: BridgeCommandMessageV2) { lifecycle.push(`${command.type}@${ticks.length}`); if (command.type === "join" && mode === "join") throw original; } };
  const session = createMeetingSession({ identity, runtime, bridge, coordinator, clock, agentIdentity: { aliases: ["Meetbot"] }, bridgeId: "mac",
    bridgeSessionId: "private-bridge", disclosureText: "Disclosure", timedEvidence: { store }, ...(vaultDir === undefined ? {} : { teamVaultDir: vaultDir }),
    ...(observer === undefined ? {} : { joinTiming: observer }) });
  let caught: unknown;
  const join = session.join();
  void (async () => { for (let index = 0; index < 64; index += 1) { ticks.push("t"); await null; } })();
  try { await join; } catch (error) { caught = error; }
  const state = session.state();
  await session.dispose(); store.close(); rmSync(directory, { recursive: true });
  return { caught, original, lifecycle, terminalReason: state.terminalReason, phase: state.phase };
}

test("the phase list is fixed and the helper is a no-op without an observer", () => {
  assert.equal(new Set(JOIN_TIMING_PHASES).size, JOIN_TIMING_PHASES.length);
  assert.equal(markJoinTiming(undefined, "join_entered"), undefined);
  let calls = 0;
  assert.equal(markJoinTiming(() => { calls += 1; throw new Error("PRIVATE-OBSERVER"); }, "join_entered"), undefined);
  assert.equal(calls, 1);
});

test("a successful timed join reports every session phase once, in order, and the vault build settles once, off the join path", async () => {
  const seen: JoinTimingPhase[] = [];
  const vault = mkdtempSync(path.join(os.tmpdir(), "join-timing-vault-"));
  try {
    const result = await probe("success", (phase) => { seen.push(phase); }, vault);
    assert.equal(result.caught, undefined);
    for (let waited = 0; !seen.includes("vault_index_built") && waited < 5000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(seen.filter((phase) => phase !== "vault_index_built"), ["vault_index_started", ...SESSION_PHASES]);
    assert.equal(seen.filter((phase) => phase === "vault_index_built").length, 1);
  } finally { rmSync(vault, { recursive: true }); }
});

for (const [mode, last] of [["join", "join_send_started"], ["runtime", "runtime_admission_started"]] as const) {
  test(`a ${mode} rejection stops the phases at ${last} and keeps the original rejection`, async () => {
    const seen: JoinTimingPhase[] = [];
    const result = await probe(mode, (phase) => { seen.push(phase); });
    assert.equal(result.caught, result.original);
    assert.deepEqual(seen, SESSION_PHASES.slice(0, SESSION_PHASES.indexOf(last) + 1));
  });
}

for (const mode of ["success", "join", "runtime"] as const) {
  test(`observing a ${mode} join changes neither its commands, their microtask positions, its outcome nor its rejection`, async () => {
    const plain = await probe(mode, undefined);
    const recorded = await probe(mode, () => { process.hrtime.bigint(); });
    const throwing = await probe(mode, () => { throw new Error("PRIVATE-OBSERVER"); });
    for (const observed of [recorded, throwing]) {
      assert.deepEqual(observed.lifecycle, plain.lifecycle);
      assert.equal(observed.terminalReason, plain.terminalReason);
      assert.equal(observed.phase, plain.phase);
      assert.equal(observed.caught === observed.original, plain.caught === plain.original);
    }
  });
}

test("observer cost per mark is bounded", () => {
  const rows: bigint[] = [];
  const observer: JoinTimingObserver = () => { rows.push(process.hrtime.bigint()); };
  const marks = 20_000;
  const started = process.hrtime.bigint();
  for (let index = 0; index < marks; index += 1) markJoinTiming(observer, JOIN_TIMING_PHASES[index % JOIN_TIMING_PHASES.length]!);
  const perMarkUs = Number(process.hrtime.bigint() - started) / 1000 / marks;
  assert.equal(rows.length, marks);
  // A join emits at most JOIN_TIMING_PHASES.length marks; 50 µs each bounds the total well under a millisecond.
  assert.ok(perMarkUs < 50, `mean ${perMarkUs} µs per mark`);
});
