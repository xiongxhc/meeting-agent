import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, chmodSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { normalizeInvite } from "../src/ports/feishu-ingress.ts";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { replayNeedsJoinDecision } from "../src/ports/session-store.ts";

// Listener-free component facts. No SDK, application, stage or process inventory.
async function helpers() {
  const filename = path.join(import.meta.dirname, "ingress-run.mjs");
  assert.ok(existsSync(filename), "ingress campaign is not implemented");
  return import(filename);
}
const copy = <T>(value: T): T => structuredClone(value);
const identity = { occurrenceId: "synthetic@2026-10-06T10:00:00Z", region: "feishu", tenantKey: "synthetic",
  appId: "cli_0123456789abcdef", providerMeetingId: "synthetic", meetingNo: "123456789",
  occurrenceStartedAt: "2026-10-06T10:00:00Z", title: "First accepted title", acceptedAtMs: 100 };
const events = ["A", "B", "C"].map((eventId, index) => ({ eventId, hash: String(index + 1).repeat(64),
  title: [identity.title, "Later observed title", "Earlier event delivered late"][index],
  createTime: String([100, 200, 50][index]), inviteSeconds: String([10, 20, 5][index]), startSeconds: "1791280800" }));
// Owner 2's later invite for the same meeting, from the allowlisted inviter.
const allowedEvent = { eventId: "D", hash: "4".repeat(64), title: "Allowed inviter title", createTime: "300", inviteSeconds: "30", startSeconds: "1791280800" };
type State = { fileIdentity: string; immutable: typeof identity; events: typeof events; sessions: { occurrenceId: string; providerMeetingId: string; occurrenceStartedAt: string; state: string }[];
  metadata: { state: string; reason: string; lastBlockedAtMs: number | null; claimed: number; claimExpiresAtMs: number | null; organizerId: string | null; organizerSource: string | null;
    reference: { kind: string; reserveId: string } | null; admittedAtMs: number | null; totalAttempts: number; generationAttempts: number;
    generationStartedAtMs: number | null; firstAttemptAtMs: number | null; lastAttemptAtMs: number | null; retryGeneration: number; operatorRetryCount: number;
    lastOperator: string | null; lastOperatorRetryAtMs: number | null; nextAttemptAtMs: number };
  counts: { custody: number; recording: number; seed: number; delivery: number; notification: number } };
/** Phase 1's invites come from an inviter the allowlist does not name: refused on the row, no organizer lookup. */
function blocked(): State {
  return { fileIdentity: "synthetic-file", immutable: copy(identity), events: copy(events), sessions: [],
    metadata: { state: "metadata_blocked", reason: "inviter_not_allowed", lastBlockedAtMs: 100, claimed: 0, claimExpiresAtMs: null,
      organizerId: null, organizerSource: null, reference: null, admittedAtMs: null, totalAttempts: 0,
      generationAttempts: 0, generationStartedAtMs: null, firstAttemptAtMs: null, lastAttemptAtMs: null,
      retryGeneration: 0, operatorRetryCount: 0, lastOperator: null, lastOperatorRetryAtMs: null, nextAttemptAtMs: 100 },
    counts: { custody: 0, recording: 0, seed: 0, delivery: 0, notification: 0 } };
}
const emptyActivity = () => ({ trace: ["composition_lock_verified", "composition_store_opened", "composition_started"],
  requests: [{ route: "ws_endpoint", status: 200 }], messages: [], runtimePids: [], bridge: null,
  files: { recording: 0, outbox: 0, receipt: 0, key: false }, outcomes: [], envKeys: ["PATH"],
  receiver: { invalid: false, overflow: false, observations: [] as { ordinal: number; kind: string; messageId: string; payload: { code: number } }[] } });
type Mutation = (name: string, fact: Record<string, unknown>) => void;
function syntheticEffects(missingLauncher = false, mutate: Mutation = () => {}, conflictingReplay = false) {
  const calls: string[] = [], plans: { occurrenceId: string; expected: typeof events; sends: (typeof events[number] & { wireMessageId: string; occurrenceId: string; expectedCode?: number })[];
    allowedSend: typeof allowedEvent & { wireMessageId: string; occurrenceId: string } } = { occurrenceId: identity.occurrenceId, expected: events, sends: [0, 1, 2, 0].map((index, send) =>
    ({ ...events[index]!, wireMessageId: `phase1-${send}`, occurrenceId: identity.occurrenceId })), allowedSend: { ...allowedEvent, wireMessageId: "phase2-d", occurrenceId: identity.occurrenceId } };
  let current = blocked(), activity = emptyActivity(), phase = 0, sends = 0, retried = false; const refused = new Set<string>();
  const commits: { ordinal: number; ackFloor: number; wireMessageId: string; eventId: string; expectedHash: string; persistedHash: string; immutable: typeof identity }[] = [];
  const fact = <T extends object>(name: string, value: T): T => { calls.push(name); const result = copy(value); mutate(name, result as Record<string, unknown>); return result; };
  const owner = {
    async ready() { return fact("ready", { admitted: true, started: true, connections: 1, receiver: activity.receiver }); },
    async deliver(send: typeof plans.sends[number]) {
      sends++;
      if (send.expectedCode === 500) {
        activity.receiver.observations.push({ ordinal: sends, kind: "ack", messageId: send.wireMessageId, payload: { code: 500 } });
        return fact("deliver", { receiver: { invalid: false, overflow: false, observations: [activity.receiver.observations.at(-1)!] }, state: current });
      }
      if (send.eventId === allowedEvent.eventId) {
        // The allowed invite is admitted at once: one discovered session, no organizer yet.
        current.events = [...current.events, copy(allowedEvent)];
        current.sessions = [{ occurrenceId: identity.occurrenceId, providerMeetingId: identity.providerMeetingId, occurrenceStartedAt: identity.occurrenceStartedAt, state: "discovered" }];
      } else {
        const index = events.findIndex(e => e.eventId === send.eventId);
        current.events = copy(events.slice(0, Math.max(current.events.length === 3 && sends === 1 ? 0 : current.events.length, index + 1)));
        if (!refused.has(send.eventId)) { refused.add(send.eventId); activity.trace.push("invite_admission_inviter_not_allowed"); }
      }
      activity.receiver.observations.push({ ordinal: sends, kind: "ack", messageId: send.wireMessageId, payload: { code: 200 } });
      commits.push({ ordinal: commits.length + 1, ackFloor: sends - 1, wireMessageId: send.wireMessageId, eventId: send.eventId,
        expectedHash: send.hash, persistedHash: send.hash, immutable: copy(identity) });
      return fact("deliver", { commit: { ordinal: commits.length, ackFloor: sends - 1, wireMessageId: send.wireMessageId,
        eventId: send.eventId, expectedHash: send.hash, persistedHash: send.hash, immutable: identity },
        receiver: { invalid: false, overflow: false, observations: [{ ordinal: sends, kind: "ack", messageId: send.wireMessageId, payload: { code: 200 } }] }, state: current });
    },
    async blocked() { return fact("blocked", { state: current, activity }); },
    async read() { return fact("read", current); },
    async discover() {
      // After an operator retry the tick no longer knows the inviter: it refuses the row again.
      if (retried && current.metadata.state === "pending_metadata") {
        current.metadata = { ...current.metadata, state: "metadata_blocked", reason: "inviter_unverified", lastBlockedAtMs: 201 };
        activity.trace.push("invite_admission_inviter_unverified");
      }
      return fact("discover", { launched: 0, resolved: 0, deferred: 0 });
    },
    async retry() {
      retried = true;
      current.metadata = { ...current.metadata, state: "pending_metadata", generationAttempts: 0, generationStartedAtMs: null,
        retryGeneration: 1, operatorRetryCount: 1, lastOperator: "e2e-ingress-operator", lastOperatorRetryAtMs: 200, nextAttemptAtMs: 200 };
      return fact("retry", { result: "pending", state: current });
    },
    async launched() {
      // The allowed invite reopened the organizer lane (retry generation 2); its lookup resolves after the launch.
      current.metadata = { ...current.metadata, state: "admitted", totalAttempts: 1, generationAttempts: 1, generationStartedAtMs: 203, firstAttemptAtMs: 203, lastAttemptAtMs: 203,
        retryGeneration: 2, organizerId: "ou_e2e_organizer", organizerSource: "reservation", reference: { kind: "reservation", reserveId: "reserve-e2e-1" }, admittedAtMs: 204 };
      const outcome = { occurrenceId: identity.occurrenceId, organizer: null, phase: missingLauncher ? "settled" : "live",
        failure: missingLauncher ? "runtime_startup_failed" : null, controlSessionId: missingLauncher ? null : "41",
        custody: "not_applicable", finalization: "none", runtimeClose: "closed", runtimeCleanup: "graceful" };
      activity = { ...activity, requests: ["reserve_active_meeting", "reserve_get", "contact_user_get"].map(route => ({ route, status: 200 })),
        trace: [...activity.trace, "occurrence_launched", ...(missingLauncher ? [] : ["occurrence_runtime_connected"])],
        runtimePids: missingLauncher ? [] : [43], outcomes: [outcome],
        bridge: missingLauncher ? null : { pid: 44, joined: true, mediaConnected: true, framesSent: 1,
          occurrenceId: identity.occurrenceId, bridgeSessionId: "synthetic-bridge", controlSessionId: "41", bound: true, envKeys: ["PATH"] } } as unknown as ReturnType<typeof emptyActivity>;
      if (!missingLauncher) current.counts.custody = 1;
      return fact("launched", { state: current, activity });
    },
    async activity() { return fact("activity", activity); },
    async close() { return fact("close", { standaloneExit: 0, compositionClosed: true, peerClosed: true,
      lockClosedLast: true, cleanupFailures: [], outcomes: activity.outcomes, receiver: activity.receiver,
      finalState: current, observerFailure: false, overflow: false, commitObservations: commits, ackObservations: activity.receiver.observations }); },
  };
  const { acceptedAtMs: _acceptedAtMs, ...immutableExpected } = identity; void _acceptedAtMs;
  return { calls, owner, plan: { ...plans, immutableExpected, missingLauncher, ...(conflictingReplay ? { conflictingReplay: true } : {}), root: "/synthetic", databasePath: "/synthetic/db" },
    effects: {
      async prepare() { calls.push("prepare"); },
      async runOwner(p: Record<string, unknown>, signal: AbortSignal) {
        phase++; current = blocked(); activity = emptyActivity(); commits.length = 0; retried = false; refused.clear();
        const { runIngressPhase } = await import(path.join(import.meta.dirname, "ingress-entry.mjs"));
        const result = await runIngressPhase(p, owner, { signal });
        return fact(`owner${phase}`, { ...result, ownerProcessProof: { cleanupConfirmed: true },
          child: { closeObserved: true, exitObserved: true, code: 0, signal: null, stdioSettled: true, forced: false } });
      },
      async between() { return fact("between", blocked()); },
      async cleanup() { return fact("cleanup", { cleanupConfirmed: true }); },
    } };
}
test("first-owner lingering descendant cannot be excused by later disappearance", async () => {
  const { runIngressCampaign } = await helpers();
  const f = syntheticEffects(false, (name, value) => { if (name === "owner1") value.ownerProcessProof = { cleanupConfirmed: false, probes: [{ pid: 456, status: "present" }] }; });
  const result = await runIngressCampaign(f.plan, f.effects);
  assert.equal(result.success, false); assert.equal(f.calls.includes("between"), false); assert.equal(f.calls.includes("owner2"), false);
  assert.equal(result.processProof.cleanupConfirmed, true); // Later disappearance never repairs the failed boundary.
});
test("first-owner proof uses shared process adapter and cannot defer descendant absence until final cleanup", async () => {
  const h = await helpers(), { createProcessEvidence } = await import(path.join(import.meta.dirname, "process-evidence.mjs"));
  const evidence = createProcessEvidence(), f = syntheticEffects(), owner = "ingress-phase-1";
  let gone = false;
  const probe = (pid: number) => { if (pid === 124 && !gone) return; throw Object.assign(new Error("synthetic absent PID"), { code: "ESRCH" }); };
  const original = f.effects.runOwner;
  f.effects.runOwner = async (...args) => {
    const value = await original(...args);
    // Explicit synthetic ps listing/ownership; no ps or native child executes.
    h.observeIngressInventory(evidence, { rootPid: 123, owner, stage: "first-owner-running", result: {
      exit: 0, signal: null, stdout: "123 0 synthetic-entry\n124 123 synthetic-descendant\n", stderr: "", durationMs: 1 } });
    evidence.children.push({ role: owner, pid: 123, outcome: { exitObserved: true, code: 0, signal: null } });
    value.ownerProcessProof = h.ingressProcessProof(evidence, owner, probe); return value;
  };
  f.effects.cleanup = async () => {
    gone = true;
    h.observeIngressInventory(evidence, { rootPid: 123, owner, stage: "final", baseline: true,
      result: { exit: 0, signal: null, stdout: "999 0 synthetic-observer\n", stderr: "", durationMs: 1 } });
    return h.ingressProcessProof(evidence, undefined, probe);
  };
  const result = await h.runIngressCampaign(f.plan, f.effects);
  assert.equal(result.success, false); assert.equal(result.processProof.cleanupConfirmed, true);
  assert.equal(f.calls.includes("between"), false); assert.equal(f.calls.includes("owner2"), false);
  assert.equal(result.phases[0].ownerProcessProof.probes.find((row: { pid: number }) => row.pid === 124).status, "present");
  assert.equal(result.phases[0].ownerProcessProof.inventory.outcomes.length, 1);
  assert.equal(result.processProof.inventory.outcomes.length, 2);
});
for (const bad of ["unsolicited", "duplicate", "invalid", "overflow", "observer", "historyOverflow", "missingCommit", "commitHash", "legacyOnly"]) {
  test(`final settled receiver ${bad} refuses phase2`, async () => {
    const { runIngressCampaign } = await helpers(); const f = syntheticEffects(false, (name, value) => {
      if (name !== "close") return;
      const close = value as { receiver: ReturnType<typeof emptyActivity>["receiver"]; observerFailure: boolean; overflow: boolean;
        ackObservations: ReturnType<typeof emptyActivity>["receiver"]["observations"]; commitObservations: { persistedHash: string }[] };
      if (bad === "unsolicited") close.receiver.observations.push({ ordinal: 99, kind: "ack", messageId: "after-last-activity", payload: { code: 200 } });
      if (bad === "duplicate") close.receiver.observations.push(copy(close.receiver.observations[0]!));
      if (bad === "invalid") close.receiver.invalid = true;
      if (bad === "overflow") close.receiver.overflow = true;
      if (bad === "observer") close.observerFailure = true;
      if (bad === "historyOverflow") close.overflow = true;
      if (bad === "missingCommit") close.commitObservations.pop();
      if (bad === "commitHash") close.commitObservations[0]!.persistedHash = "f".repeat(64);
      if (bad === "legacyOnly") close.ackObservations = [{ ordinal: 99, kind: "ack", messageId: "unobserved-final", payload: { code: 200 } }];
    });
    assert.equal((await runIngressCampaign(f.plan, f.effects)).success, false);
    assert.equal(f.calls.includes("between"), false); assert.equal(f.calls.includes("owner2"), false);
  });
}
test("final phase2 unsolicited receiver frame prevents campaign success", async () => {
  const h = await helpers(); let closes = 0;
  const f = syntheticEffects(false, (name, value) => { if (name === "close" && ++closes === 2) {
    (value.receiver as ReturnType<typeof emptyActivity>["receiver"]).observations.push({ ordinal: 1, kind: "ack", messageId: "old-phase1", payload: { code: 200 } });
  } });
  const result = await h.runIngressCampaign(f.plan, f.effects); assert.equal(result.success, false); assert.equal(result.phases.length, 2);
});
for (const stage of ["preflight", "first-owner-close", "final"]) {
  test(`inventory ${stage} refusal retains actual synthetic command facts`, async () => {
    const h = await helpers(); assert.equal(typeof h.observeIngressInventory, "function", "inventory observation adapter is missing");
    const { createProcessEvidence } = await import(path.join(import.meta.dirname, "process-evidence.mjs"));
    const evidence = createProcessEvidence(), f = syntheticEffects();
    const deny = () => h.observeIngressInventory(evidence, { rootPid: 123, owner: "ingress-phase-1", stage,
      result: { command: ["/bin/ps", "-eo", "pid=,ppid=,comm="], exit: 1, signal: null, stdout: "",
        stderr: "ps: Operation not permitted\nsecret=do-not-retain\n", durationMs: 3 } });
    if (stage === "preflight") f.effects.prepare = async () => { f.calls.push("preflight"); deny(); f.calls.push("stage"); };
    if (stage === "first-owner-close") {
      const original = f.effects.runOwner;
      f.effects.runOwner = async (...args) => { const value = await original(...args); deny(); return value; };
    }
    f.effects.cleanup = async () => { try { if (stage !== "first-owner-close") deny(); } catch { /* Sticky evidence still reaches the campaign. */ }
      return h.ingressProcessProof(evidence); };
    const result = await h.runIngressCampaign(f.plan, f.effects);
    assert.equal(result.success, false); assert.equal(f.calls.includes("owner2"), stage === "final");
    if (stage === "preflight") { assert.equal(f.calls.includes("stage"), false); assert.equal(f.calls.includes("owner1"), false); }
    const inventory = result.processProof.inventory;
    assert.ok(inventory.failures.length > 0); assert.equal(inventory.outcomes[0].stage, stage);
    assert.equal(inventory.outcomes[0].exit, 1); assert.equal(inventory.outcomes[0].signal, null);
    assert.equal(inventory.outcomes[0].diagnostic, "ps: Operation not permitted");
    assert.equal(JSON.stringify(result).includes("do-not-retain"), false);
  });
}
test("inventory adapter retains signal and bounded sticky overflow without arbitrary diagnostics", async () => {
  const h = await helpers(), { createProcessEvidence } = await import(path.join(import.meta.dirname, "process-evidence.mjs"));
  const evidence = createProcessEvidence();
  for (let at = 0; at < 256; at++) h.observeIngressInventory(evidence, { rootPid: 123, owner: "synthetic", stage: "synthetic-running",
    result: { exit: 0, signal: null, stdout: "123 0 synthetic-entry\n", stderr: "", durationMs: 1 } });
  assert.throws(() => h.observeIngressInventory(evidence, { rootPid: 123, owner: "synthetic", stage: "synthetic-close", result: {
    exit: null, signal: "SIGTERM", stdout: "", stderr: "unknown credential=private-value", durationMs: 1000 } }), /history_overflow/);
  assert.equal(evidence.inventory.outcomes.length, 256); assert.equal(evidence.inventory.overflowOutcome.signal, "SIGTERM");
  assert.equal(evidence.inventory.overflowOutcome.stage, "synthetic-close");
  assert.equal(evidence.inventory.failures.includes("inventory_history_overflow"), true);
  assert.equal(JSON.stringify(evidence).includes("private-value"), false);
});

test("synthetic two-owner campaign uses shared transitions, exact replay, one refused public retry and one allowed later invite", async () => {
  const { runIngressCampaign } = await helpers();
  const fixture = syntheticEffects(); const result = await runIngressCampaign(fixture.plan, fixture.effects);
  assert.equal(result.success, true); assert.equal(result.label, "component-facts");
  assert.equal(fixture.calls.filter(name => name === "deliver").length, 5);
  assert.ok(fixture.calls.lastIndexOf("retry") < fixture.calls.lastIndexOf("deliver") && fixture.calls.lastIndexOf("deliver") < fixture.calls.indexOf("launched"));
  assert.equal(fixture.calls.filter(name => name === "retry").length, 1);
  assert.ok(fixture.calls.indexOf("owner1") < fixture.calls.indexOf("between"));
  assert.ok(fixture.calls.indexOf("between") < fixture.calls.lastIndexOf("ready"));
  assert.equal(fixture.calls.filter(name => name === "close").length, 2);
});
test("synthetic exact lazy missing-launcher failure is accepted after real-admission-shaped facts", async () => {
  const { runIngressCampaign } = await helpers(); const f = syntheticEffects(true);
  assert.equal((await runIngressCampaign(f.plan, f.effects)).success, true);
  assert.equal(f.calls.filter(name => name === "discover").length, 3);
});
for (const bad of ["mismatch", "missing", "duplicate", "code500", "legacy", "noCommit", "hash", "occurrence", "beforeCommit", "overflow", "invalid"]) {
  test(`synthetic ACK ${bad} refuses before next envelope`, async () => {
    const { runIngressCampaign } = await helpers(); const f = syntheticEffects(false, (name, value) => {
      if (name !== "deliver") return;
      const v = value as { commit: { ackFloor: number; persistedHash: string; immutable: typeof identity } | null;
        receiver: { observations: { ordinal: number; messageId?: string; payload: { code: number } }[]; invalid: boolean; overflow: boolean } };
      const reply = v.receiver.observations[0]; assert.ok(reply);
      if (bad === "mismatch") reply.messageId = "stale-phase";
      if (bad === "missing") v.receiver.observations = [];
      if (bad === "duplicate") v.receiver.observations.push(copy(reply));
      if (bad === "code500") reply.payload.code = 500;
      if (bad === "legacy") delete reply.messageId;
      if (bad === "noCommit") v.commit = null;
      if (bad === "hash") v.commit!.persistedHash = "f".repeat(64);
      if (bad === "occurrence") v.commit!.immutable.occurrenceId = "wrong";
      if (bad === "beforeCommit") v.commit!.ackFloor = 99;
      if (bad === "overflow") v.receiver.overflow = true;
      if (bad === "invalid") v.receiver.invalid = true;
    });
    assert.equal((await runIngressCampaign(f.plan, f.effects)).success, false);
    assert.equal(f.calls.filter(n => n === "deliver").length, 1); assert.equal(f.calls.includes("retry"), false);
    assert.equal(f.calls.filter(n => n === "close").length, 1);
  });
}
for (const field of ["occurrenceId", "occurrenceStartedAt", "meetingNo", "title", "acceptedAtMs"]) {
  test(`synthetic immutable ${field} change refuses`, async () => {
    const { runIngressCampaign } = await helpers(); let deliveries = 0;
    const f = syntheticEffects(false, (name, v) => { if (name === "deliver" && ++deliveries === 2) {
      const state = v.state as ReturnType<typeof blocked>; Object.assign(state.immutable, { [field]: "changed" });
    } });
    assert.equal((await runIngressCampaign(f.plan, f.effects)).success, false);
    assert.equal(f.calls.filter(n => n === "deliver").length, 2);
  });
}
for (const bad of ["staleReopen", "lateDuplicate", "lateInvalid", "lateOverflow", "firstTitle", "replayAudit"]) {
  test(`synthetic receiver/first identity ${bad} refuses before further work`, async () => {
    const { runIngressCampaign } = await helpers(); let delivered = 0, readiness = 0;
    const f = syntheticEffects(false, (name, v) => {
      if (name === "ready" && ++readiness === 2 && bad === "staleReopen") {
        (v.receiver as ReturnType<typeof emptyActivity>["receiver"]).observations.push({ ordinal: 1, kind: "ack", messageId: "phase1-0", payload: { code: 200 } });
      }
      if (name === "deliver") {
        delivered++;
        const value = v as { commit: { immutable: typeof identity }; state: State };
        if (bad === "firstTitle") value.commit.immutable.title = "other";
        if (bad === "replayAudit" && delivered === 4) value.state.events[0]!.createTime = "changed";
      }
      if (name === "blocked") {
        const a = v.activity as ReturnType<typeof emptyActivity>;
        if (bad === "lateDuplicate") a.receiver.observations.push(copy(a.receiver.observations[0]!));
        if (bad === "lateInvalid") a.receiver.invalid = true;
        if (bad === "lateOverflow") a.receiver.overflow = true;
      }
    });
    assert.equal((await runIngressCampaign(f.plan, f.effects)).success, false);
    assert.equal(f.calls.includes("retry"), false);
    if (bad.startsWith("late")) assert.equal(delivered, 1);
  });
}
for (const bad of ["audit", "extraAudit", "503", "reference_missing", "session", "organizer", "custody", "runtime", "seed", "artifact", "dm",
  "dbIdentity", "root", "noClose", "signal", "stdio", "lingering", "autoRetry", "extraRetry", "falseReady", "crossWire", "secondLaunch", "cleanup",
  "refusalUnlogged", "lookupOnRefusal", "retryJoins", "retryLookup", "retryUnlogged", "retryReason", "retryPending", "organizerFirst", "allowedAudit", "earlyLaunch", "operatorOnly"]) {
  test(`synthetic recovery/launch ${bad} cannot pass`, async () => {
    const { runIngressCampaign } = await helpers(); const f = syntheticEffects(false, (name, v) => {
      if (name === "blocked") {
        const s = v.state as ReturnType<typeof blocked>, a = v.activity as ReturnType<typeof emptyActivity>;
        if (bad === "audit") s.events.pop(); if (bad === "extraAudit") { const event = events[0]; assert.ok(event); s.events.push(copy(event)); }
        if (bad === "503") a.requests = [{ route: "unmatched", status: 503 }];
        if (bad === "reference_missing") s.metadata.reason = "reference_missing";
        if (bad === "session") s.sessions = [{}] as unknown as [];
        if (bad === "organizer") s.metadata.organizerId = "inferred";
        if (["custody", "seed"].includes(bad)) Object.assign(s.counts, { [bad]: 1 });
        if (bad === "runtime") a.runtimePids = [99] as unknown as [];
        if (bad === "artifact") a.files.outbox = 1;
        if (bad === "dm") a.messages = [{}] as unknown as [];
        if (bad === "refusalUnlogged") a.trace = a.trace.filter(code => code !== "invite_admission_inviter_not_allowed");
        if (bad === "lookupOnRefusal") { s.metadata.totalAttempts = 1; a.requests = [{ route: "reserve_get", status: 200 }]; }
      }
      // The read after the operator retry: the row must be refused again, never joined or looked up.
      if (name === "read" && (v.metadata as Record<string, unknown>).reason === "inviter_unverified" && (v.metadata as Record<string, unknown>).state === "metadata_blocked") {
        if (bad === "retryJoins") (v as unknown as State).sessions = [{ occurrenceId: identity.occurrenceId, providerMeetingId: identity.providerMeetingId, occurrenceStartedAt: identity.occurrenceStartedAt, state: "discovered" }];
        if (bad === "retryLookup") (v.metadata as Record<string, unknown>).totalAttempts = 1;
        if (bad === "retryReason") (v.metadata as Record<string, unknown>).reason = "inviter_not_allowed";
        if (bad === "retryPending") (v.metadata as Record<string, unknown>).state = "pending_metadata";
      }
      if (name === "activity" && bad === "retryUnlogged") (v as unknown as ReturnType<typeof emptyActivity>).trace = (v as unknown as ReturnType<typeof emptyActivity>).trace.filter(code => code !== "invite_admission_inviter_unverified");
      if (name === "owner1") {
        const child = v.child as Record<string, unknown>;
        if (bad === "noClose") child.closeObserved = false;
        if (bad === "signal") child.signal = "SIGTERM";
        if (bad === "stdio") child.stdioSettled = false;
        if (bad === "root") v.root = "/different";
      }
      if (name === "between" && bad === "dbIdentity") v.fileIdentity = "different";
      if (name === "read" && bad === "autoRetry") (v.metadata as Record<string, unknown>).state = "admitted";
      if (name === "retry" && bad === "extraRetry") ((v.state as ReturnType<typeof blocked>).metadata).retryGeneration = 2;
      if (name === "launched") {
        const a = v.activity as ReturnType<typeof emptyActivity>;
        if (bad === "falseReady") a.bridge = null;
        if (bad === "crossWire") (a.bridge as unknown as Record<string, unknown>).occurrenceId = "other";
        if (bad === "secondLaunch") a.trace.push("occurrence_launched");
        if (bad === "organizerFirst") (a.outcomes[0] as unknown as Record<string, unknown>).organizer = { feishuUserId: "ou_e2e_organizer", displayName: "Organizer", source: "reservation" };
        if (bad === "allowedAudit") (v.state as State).events = (v.state as State).events.filter(e => e.eventId !== allowedEvent.eventId);
        if (bad === "earlyLaunch") { a.trace = a.trace.filter(code => code !== "occurrence_launched"); a.trace.splice(a.trace.indexOf("invite_admission_inviter_unverified"), 0, "occurrence_launched"); }
        if (bad === "operatorOnly") (v.state as State).metadata.retryGeneration = 1;
      }
      if (name === "cleanup" && ["lingering", "cleanup"].includes(bad)) v.cleanupConfirmed = false;
    });
    assert.equal((await runIngressCampaign(f.plan, f.effects)).success, false);
  });
}
test("synthetic cancellation fences each effect boundary and attempts owned close once", async () => {
  const { runIngressCampaign } = await helpers();
  for (const boundary of ["ready", "deliver", "blocked", "read", "discover", "retry", "launched", "activity"]) {
    const controller = new AbortController(); const f = syntheticEffects(false, name => { if (name === boundary) controller.abort(); });
    const result = await runIngressCampaign(f.plan, f.effects, { signal: controller.signal });
    assert.equal(result.success, false, boundary); assert.ok(f.calls.filter(n => n === "close").length <= 2);
  }
});
test("strict CLI rejects duplicate, unknown and unsafe outputs before effects", async () => {
  const { parseIngressArguments } = await helpers();
  assert.deepEqual(parseIngressArguments(["--out", "/private/tmp/new", "--missing-launcher"]), { out: "/private/tmp/new", missingLauncher: true });
  for (const argv of [[], ["--out", "relative"], ["--out", "/"], ["--out", "/tmp/../x"], ["--out", "/tmp/x", "--out", "/tmp/y"],
    ["--out", "/tmp/x", "--keep"], ["--out", "/tmp/x", "--missing-launcher", "--missing-launcher"]]) assert.throws(() => parseIngressArguments(argv));
});
test("synthetic SQLite reader refuses missing/symlink/WAL/header/schema before use and redacts claims", async () => {
  const { readIngressState } = await helpers(); const root = mkdtempSync("/private/tmp/ingress-reader-"); chmodSync(root, 0o700);
  const databasePath = path.join(root, "synthetic.db"), occurrenceId = identity.occurrenceId;
  const read = () => readIngressState({ databasePath, occurrenceId });
  try {
    assert.throws(read); assert.equal(existsSync(databasePath), false);
    writeFileSync(databasePath, "not sqlite", { mode: 0o600 }); assert.throws(read); rmSync(databasePath);
    const db = new Database(databasePath); db.exec("CREATE TABLE schema_migrations(version INTEGER); INSERT INTO schema_migrations VALUES(28)"); db.close();
    assert.throws(read, /schema/); symlinkSync(databasePath, path.join(root, "link.db"));
    assert.throws(() => readIngressState({ databasePath: path.join(root, "link.db"), occurrenceId }));
    writeFileSync(`${databasePath}-wal`, "synthetic"); assert.throws(read, /WAL/); rmSync(`${databasePath}-wal`);
    symlinkSync(path.join(root, "absent"), `${databasePath}-shm`); assert.throws(read, /WAL/); rmSync(`${databasePath}-shm`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("synthetic schema29 SQLite SELECT projection is bounded and omits claim secrets", async () => {
  const { readIngressState } = await helpers(); const root = mkdtempSync("/private/tmp/ingress-schema29-"); chmodSync(root, 0o700);
  const databasePath = path.join(root, "synthetic.db"), occurrenceId = identity.occurrenceId;
  const db = new Database(databasePath);
  try {
    // Explicit synthetic setup SQL; no SessionStore, composition or acceptance call.
    const migrations = path.resolve(import.meta.dirname, "../migrations");
    for (const file of readdirSync(migrations).filter(f => f.endsWith(".sql")).sort()) {
      db.exec(readFileSync(path.join(migrations, file), "utf8"));
      db.prepare("INSERT INTO schema_migrations(version,name,applied_at_ms) VALUES(?,?,0)").run(Number(file.slice(0, 3)), file);
    }
    const secret = "a".repeat(32);
    db.prepare(`INSERT INTO feishu_invite_occurrences(occurrence_id,region,tenant_key,app_id,provider_meeting_id,meeting_no,
      occurrence_started_at,title,state,accepted_at_ms,last_observed_at_ms,next_attempt_at_ms,claim_token,claim_expires_at_ms)
      VALUES(?,?,?,?,?,?,?,?, 'pending_metadata',100,100,100,?,200)`)
      .run(occurrenceId, identity.region, identity.tenantKey, identity.appId, identity.providerMeetingId, identity.meetingNo,
        identity.occurrenceStartedAt, identity.title, secret);
    const read = () => readIngressState({ databasePath, occurrenceId });
    const state = read(); assert.equal(state.metadata.claimed, 1); assert.equal(state.metadata.claimExpiresAtMs, 200);
    assert.equal(JSON.stringify(state).includes(secret), false); assert.deepEqual(state.sessions, []);
    assert.deepEqual(state.counts, { custody: 0, recording: 0, seed: 0, delivery: 0, notification: 0 });
    for (const e of events) db.prepare(`INSERT INTO feishu_invite_events(region,tenant_key,app_id,event_id,occurrence_id,envelope_schema,
      event_type,create_time,provider_meeting_id,meeting_no,topic,start_seconds,invite_seconds,call_id,normalized_sha256,normalized_bytes,accepted_at_ms)
      VALUES(?,?,?,?,?,'2.0','vc.bot.meeting_invited_v1',?,?,?,?,?,?,'synthetic-call',?,1,100)`)
      .run(identity.region, identity.tenantKey, identity.appId, e.eventId, occurrenceId, e.createTime,
        identity.providerMeetingId, identity.meetingNo, e.title, e.startSeconds, e.inviteSeconds, e.hash);
    assert.equal(read().events.length, 3);
    // Owner 2's allowed invite is the fourth audited event; a fifth exceeds the bound.
    for (const extra of ["extra", "extra2"]) db.exec(`INSERT INTO feishu_invite_events SELECT region,tenant_key,app_id,'${extra}',occurrence_id,envelope_schema,event_type,create_time,provider_meeting_id,meeting_no,topic,start_seconds,end_seconds,invite_seconds,call_id,normalized_sha256,normalized_bytes,accepted_at_ms FROM feishu_invite_events LIMIT 1`);
    assert.throws(read, /audit_count/);
    db.exec("DELETE FROM feishu_invite_events WHERE event_id='extra2'"); assert.equal(read().events.length, 4);
    db.exec("DELETE FROM feishu_invite_events WHERE event_id='extra'; PRAGMA journal_mode=WAL");
    assert.throws(read, /WAL/);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
test("synthetic deadline/rejection retains operation and cleanup failure with no later delivery", async () => {
  await helpers();
  const { runIngressPhase } = await import(path.join(import.meta.dirname, "ingress-entry.mjs"));
  for (const kind of ["deadline", "admission", "peerStart", "observer", "output"]) {
    const calls: string[] = [];
    const effects = {
      async ready(signal: AbortSignal) {
        calls.push("ready");
        if (kind === "deadline") await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
        throw new Error(`ingress_${kind}`);
      }, async close() { calls.push("close"); throw new Error("ingress_close_failure"); },
      async deliver() { calls.push("deliver"); },
    };
    const result = await runIngressPhase({ phase: 1 }, effects, { budgetMs: 10, cleanupMs: 10 });
    assert.equal(result.success, false); assert.equal(result.failures.length, 2);
    assert.deepEqual(calls, ["ready", "close"]);
  }
});
for (const bad of ["falseAdmission", "rootRefusal", "connected", "bridge", "repeatLaunch", "wrongFailure"]) {
  test(`synthetic missing-launcher ${bad} refuses`, async () => {
    const { runIngressCampaign } = await helpers(); const f = syntheticEffects(true, (name, v) => {
      if (name === "ready" && bad === "falseAdmission") v.admitted = false;
      if (name === "ready" && bad === "rootRefusal") v.started = false;
      if (name !== "launched") return;
      const a = v.activity as { trace: string[]; bridge: object | null; outcomes: { failure: string }[] };
      if (bad === "connected") a.trace.push("occurrence_runtime_connected");
      if (bad === "bridge") a.bridge = { pid: 99 };
      // A missing launcher may be retried once in the same tick; a third launch is never allowed.
      if (bad === "repeatLaunch") a.trace.push("occurrence_launched", "occurrence_launched");
      if (bad === "wrongFailure") { const outcome = a.outcomes[0]; assert.ok(outcome); outcome.failure = "runtime_startup_timeout"; }
    }); assert.equal((await runIngressCampaign(f.plan, f.effects)).success, false);
  });
}

// C only: losing mixed-status consumption or immutable transaction state fails.
test("selected conflict replay preserves defaults and accepts only the finite fresh-ID sequence", async () => {
  const h = await helpers(), f = syntheticEffects();
  const changed = { ...f.plan.sends[0]!, title: "Conflicting content", hash: "f".repeat(64) };
  assert.deepEqual(h.selectIngressSends(f.plan.sends), f.plan.sends);
  const selected = h.selectIngressSends(f.plan.sends, changed);
  assert.deepEqual(selected.map((s: { expectedCode: number }) => s.expectedCode), [200, 500, 200, 200, 200, 200]);
  assert.equal(new Set(selected.map((s: { wireMessageId: string }) => s.wireMessageId)).size, 6);
  assert.throws(() => h.selectIngressSends(f.plan.sends, { ...changed, hash: f.plan.sends[0]!.hash }));
  assert.deepEqual(h.parseIngressArguments(["--out", "/private/tmp/conflict-new", "--conflicting-replay"]),
    { out: "/private/tmp/conflict-new", missingLauncher: false, conflictingReplay: true });
});
test("conflict oracle consumes the real decoder500 without commit and requires identical durable bytes", async () => {
  const h = await helpers(), { createFeishuFrameReceiver, eventFrame } = await import(path.join(import.meta.dirname, "feishu-peer.mjs"));
  const f = syntheticEffects(), send = { ...f.plan.sends[0]!, hash: "f".repeat(64), wireMessageId: "phase1-a-conflict", expectedCode: 500 };
  const decoder = createFeishuFrameReceiver(); decoder.receive(eventFrame({ code: 500, msg: "private-sdk-body" }, send.wireMessageId));
  const before = blocked(), result = { receiver: { invalid: decoder.invalid, overflow: decoder.overflow, observations: decoder.observations }, state: copy(before) };
  h.assertIngressConflict(send, result, before);
  for (const change of ["code", "commit", "event", "hash", "title", "acceptedAt", "metadata", "extra", "wire", "duplicate"]) {
    const mutated = copy(result) as typeof result & { commit?: object };
    if (change === "code") mutated.receiver.observations[0].payload.code = 200;
    if (change === "commit") mutated.commit = { ordinal: 2 };
    if (change === "event") mutated.state.events[0]!.eventId = "other";
    if (change === "hash") mutated.state.events[0]!.hash = "e".repeat(64);
    if (change === "title") mutated.state.immutable.title = "changed";
    if (change === "acceptedAt") mutated.state.immutable.acceptedAtMs++;
    if (change === "metadata") mutated.state.metadata.state = "pending_metadata";
    if (change === "extra") mutated.state.events.push(copy(events[0]!));
    if (change === "wire") mutated.receiver.observations[0].messageId = "wrong";
    if (change === "duplicate") mutated.receiver.observations.push(copy(mutated.receiver.observations[0]));
    assert.throws(() => h.assertIngressConflict(send, mutated, before), change);
  }
});
test("control/report validation rejects accessors and custom arrays without calling them", async () => {
  const h = await helpers(); let calls = 0;
  assert.deepEqual(h.ingressData({ safe: [1, "ok"] }), { safe: [1, "ok"] });
  assert.throws(() => h.ingressData({ get conflictingReplay() { calls++; return true; } }));
  const list: string[] = []; Object.setPrototypeOf(list, { toJSON() { calls++; return []; } });
  assert.throws(() => h.parseIngressArguments(list)); assert.equal(calls, 0);
});
test("C failure classification never invokes thrown message getters or string-like methods", async () => {
  const h = await helpers(); let calls = 0;
  assert.equal(h.ingressFailure(new Error("ingress_rejection_commit"), "ingress_phase_failed"), "ingress_rejection_commit");
  assert.equal(h.ingressFailure({ get message() { calls++; return "ingress_hidden"; } }, "ingress_phase_failed"), "ingress_phase_failed");
  assert.equal(h.ingressFailure({ message: { toString() { calls++; return "PRIVATE"; } } }, "ingress_phase_failed"), "ingress_phase_failed");
  assert.equal(calls, 0);
});

for (const missingLauncher of [false, true]) test(`C selected conflict retains ordinary two-owner ${missingLauncher ? "missing-launcher" : "live"} retry`, async () => {
  const h = await helpers(), f = syntheticEffects(missingLauncher, undefined, true);
  f.plan.sends = h.selectIngressSends(f.plan.sends, { ...f.plan.sends[0], title: "Conflicting title", hash: "f".repeat(64) });
  const result = await h.runIngressCampaign(f.plan, f.effects);
  assert.equal(result.success, true); assert.equal(result.label, "component-facts");
  assert.equal(f.calls.filter(n => n === "deliver").length, 7); assert.equal(f.calls.filter(n => n === "retry").length, 1);
  assert.deepEqual(result.phases[0].close.receiver.observations.map((r: { payload: { code: number } }) => r.payload.code), [200, 500, 200, 200, 200, 200]);
  assert.equal(result.phases[0].close.commitObservations.length, 5);
});

// Store-level model of accept() (application-composition.ts), which decides the join right after each durable
// commit. With no session, a stranger's invite is refused on the row; whether an exact replay is decided again is
// production's replayNeedsJoinDecision. accept() itself is pinned by the composition replay tests.
// `decisions: "each"` uses each delivery's own clock, as production does.
async function transactionConflictFixture(mutate: Mutation = () => {}, decisions: "single" | "each" = "single") {
  const h = await helpers(), peer = await import(path.join(import.meta.dirname, "feishu-peer.mjs"));
  const root = mkdtempSync("/private/tmp/ingress-conflict-transaction-"); chmodSync(root, 0o700);
  const databasePath = path.join(root, "actual.db"), store = openSessionStore({ filename: databasePath });
  const meeting = { eventId: "ingress-a", providerMeetingId: "meeting-component", meetingNo: "987654321", title: "First accepted title",
    startSeconds: 1791280800, inviteSeconds: 1791280800, createTimeMs: 1791280800000 };
  const stranger = { ...meeting, inviterId: peer.E2E_STRANGER };
  const envelopes = [peer.inviteEnvelope(stranger), peer.inviteEnvelope({ ...stranger, eventId: "ingress-b", title: "Later observed title" }),
    peer.inviteEnvelope({ ...stranger, eventId: "ingress-c", title: "Earlier event delivered late" })];
  const normalized = envelopes.map(e => normalizeInvite(e, peer.SCOPE)), first = normalized[0]!;
  const expected = normalized.map(n => ({ eventId: n.eventId, hash: n.normalizedSha256, title: n.title, createTime: n.createTime,
    inviteSeconds: n.inviteSeconds, startSeconds: n.startSeconds }));
  const base = [0, 1, 2, 0].map((i, at) => ({ ...expected[i], occurrenceId: first.occurrenceId, wireMessageId: `phase1-${at}`, envelope: envelopes[i] }));
  const conflictEnvelope = peer.inviteEnvelope({ ...stranger, title: "Conflicting title" }), conflict = normalizeInvite(conflictEnvelope, peer.SCOPE);
  const sends = h.selectIngressSends(base, { ...expected[0], title: conflict.title, hash: conflict.normalizedSha256, occurrenceId: first.occurrenceId, envelope: conflictEnvelope });
  const decoder = peer.createFeishuFrameReceiver(), commits: Record<string, unknown>[] = [], calls: string[] = [], trace = [...emptyActivity().trace];
  const state = () => h.readIngressState({ databasePath, occurrenceId: first.occurrenceId });
  const activity = () => ({ ...emptyActivity(), trace: [...trace], receiver: { invalid: decoder.invalid, overflow: decoder.overflow, observations: copy(decoder.observations) } });
  const fact = <T extends object>(name: string, value: T): T => { calls.push(name); mutate(name, value as Record<string, unknown>); return value; };
  let deliveries = 0;
  const effects = {
    async ready() { return fact("ready", { admitted: true, started: true, connections: 1, receiver: activity().receiver }); },
    async deliver(send: typeof base[number] & { expectedCode: number }) {
      deliveries++; const n = normalizeInvite(send.envelope, peer.SCOPE), floor = decoder.observations.at(-1)?.ordinal ?? 0;
      // Admission/rollback are real. Reply bytes below are explicit C inputs, never an SDK result.
      if (deliveries === 2) assert.throws(() => store.acceptInvite(n, 100 + deliveries), /invite_conflict/);
      else {
        const status = store.acceptInvite(n, 100 + deliveries);
        if ((status !== "replay" || replayNeedsJoinDecision(store.inviteJoinStatus(n.occurrenceId))) && store.getSession(n.occurrenceId) === null &&
          store.admitInviteJoin(n.occurrenceId, decisions === "each" ? 100 + deliveries : 101, "inviter_not_allowed") === "inviter_not_allowed") trace.push("invite_admission_inviter_not_allowed");
        const projection = state();
        commits.push({ ordinal: commits.length + 1, ackFloor: floor, wireMessageId: send.wireMessageId, eventId: n.eventId,
          expectedHash: n.normalizedSha256, persistedHash: projection.events.find((e: { eventId: string }) => e.eventId === n.eventId).hash, immutable: projection.immutable });
      }
      decoder.receive(peer.eventFrame({ code: deliveries === 2 ? 500 : 200 }, send.wireMessageId));
      return fact("deliver", { ...(deliveries === 2 ? {} : { commit: copy(commits.at(-1)) }),
        receiver: { invalid: decoder.invalid, overflow: decoder.overflow, observations: [copy(decoder.observations.at(-1))] }, state: state() });
    },
    // A refused row parks its organizer lane: it is never claimed for a lookup.
    async blocked() { assert.equal(store.claimInviteMetadata(110), null); return fact("blocked", { state: state(), activity: activity() }); },
    async activity() { return fact("activity", activity()); }, async discover() { return fact("discover", { launched: 0 }); },
    async read() { return fact("read", state()); },
    async close() { return fact("close", { standaloneExit: 0, compositionClosed: true, peerClosed: true, lockClosedLast: true,
      cleanupFailures: [], outcomes: [], receiver: activity().receiver, ackObservations: copy(decoder.observations),
      finalState: state(), commitObservations: copy(commits), observerFailure: false, overflow: false }); },
  };
  const plan = { phase: 1, root, databasePath, conflictingReplay: true, sends, expected, occurrenceId: first.occurrenceId,
    immutableExpected: Object.fromEntries(["occurrenceId", "region", "tenantKey", "appId", "providerMeetingId", "meetingNo", "occurrenceStartedAt", "title"].map(k => [k, first[k as keyof typeof first]])) };
  return { plan, effects, calls, dispose() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
for (const decisions of ["single", "each"] as const) test(`C real normalization/SQLite transaction/allowlist refusal/decoder feed shared selected phase with unchanged conflict and original replay (${decisions === "single" ? "decisions at one clock reading" : "each decision at its delivery's clock"})`, async () => {
  const { runIngressPhase } = await import(path.join(import.meta.dirname, "ingress-entry.mjs")), f = await transactionConflictFixture(undefined, decisions);
  try {
    const result = await runIngressPhase(f.plan, f.effects); assert.equal(result.success, true, JSON.stringify(result.failures));
    assert.equal(result.state.events.length, 3); assert.equal(result.state.immutable.title, "First accepted title");
    assert.equal(result.state.metadata.reason, "inviter_not_allowed"); assert.equal(result.state.metadata.totalAttempts, 0); assert.deepEqual(result.state.sessions, []);
    assert.equal(result.state.immutable.acceptedAtMs, 101); assert.equal(result.close.commitObservations.length, 5);
    assert.deepEqual(result.close.receiver.observations.map((r: { payload: { code: number } }) => r.payload.code), [200, 500, 200, 200, 200, 200]);
  } finally { f.dispose(); }
});

for (const bad of ["conflict200", "replay500", "rejectionCommit", "firstEvent", "firstHash", "firstTitle", "firstAcceptance", "metadata", "extraEvent",
  "wrongWire", "reusedWire", "extraHistory", "duplicateHistory", "lateHistory", "lateCommit", "invalidHistory", "overflowHistory", "unconfirmedClose"]) {
  test(`C coherent selected transaction rejects ${bad} at its target predicate`, async () => {
    const { runIngressPhase } = await import(path.join(import.meta.dirname, "ingress-entry.mjs")); let delivered = 0;
    const f = await transactionConflictFixture((name, value) => {
      if (name === "deliver") {
        delivered++; const v = value as { receiver: { observations: { messageId: string; payload: { code: number } }[] }; state: State; commit?: object };
        if (bad === "replay500" && delivered === 3) v.receiver.observations[0]!.payload.code = 500;
        if (delivered !== 2) return;
        if (bad === "conflict200") v.receiver.observations[0]!.payload.code = 200;
        if (bad === "rejectionCommit") v.commit = { ordinal: 2 };
        if (bad === "firstEvent") v.state.events[0]!.eventId = "changed";
        if (bad === "firstHash") v.state.events[0]!.hash = "e".repeat(64);
        if (bad === "firstTitle") v.state.immutable.title = "changed";
        if (bad === "firstAcceptance") v.state.immutable.acceptedAtMs++;
        if (bad === "metadata") v.state.metadata.state = "pending_metadata";
        if (bad === "extraEvent") v.state.events.push(copy(events[0]!));
        if (bad === "wrongWire") v.receiver.observations[0]!.messageId = "wrong-wire";
        if (bad === "reusedWire") v.receiver.observations[0]!.messageId = "phase1-0";
      }
      if (name === "close") {
        const c = value as { receiver: { observations: { ordinal: number; kind: string; messageId: string; payload: { code: number } }[]; invalid: boolean; overflow: boolean };
          ackObservations: unknown[]; commitObservations: object[]; outcomes: object[] };
        if (["extraHistory", "lateHistory"].includes(bad)) c.receiver.observations.push({ ordinal: 7, kind: "ack", messageId: "late", payload: { code: 200 } });
        if (bad === "duplicateHistory") c.receiver.observations.push(copy(c.receiver.observations[1]!));
        if (bad === "invalidHistory") c.receiver.invalid = true;
        if (bad === "overflowHistory") c.receiver.overflow = true;
        if (bad === "lateCommit") c.commitObservations.push({ ordinal: 6, wireMessageId: "phase1-a-conflict" });
        if (bad === "unconfirmedClose") c.outcomes = [{ runtimeCleanup: "unconfirmed" }];
        c.ackObservations = copy(c.receiver.observations);
      }
    });
    try {
      const result = await runIngressPhase(f.plan, f.effects); assert.equal(result.success, false);
      const target = bad === "rejectionCommit" ? "ingress_rejection_commit" :
        ["firstEvent", "firstHash", "firstTitle", "firstAcceptance", "metadata", "extraEvent"].includes(bad) ? "ingress_conflict_mutation" :
        ["conflict200", "replay500", "wrongWire", "reusedWire"].includes(bad) ? "ingress_ack_identity_order" :
        bad === "unconfirmedClose" ? "ingress_custody_cleanup" : bad === "lateCommit" ? "ingress_phase_cleanup" : "ingress_receiver_history";
      assert.ok(result.failures.includes(target), JSON.stringify(result.failures));
      assert.equal(delivered, bad === "replay500" ? 3 : ["conflict200", "rejectionCommit", "firstEvent", "firstHash", "firstTitle", "firstAcceptance", "metadata", "extraEvent", "wrongWire", "reusedWire"].includes(bad) ? 2 : 6);
    } finally { f.dispose(); }
  });
}
test("selected malformed/reused controls and custom descriptor arrays fail before lifecycle effects", async () => {
  const h = await helpers(), { runIngressPhase } = await import(path.join(import.meta.dirname, "ingress-entry.mjs"));
  const f = syntheticEffects(false, undefined, true);
  f.plan.sends = h.selectIngressSends(f.plan.sends, { ...f.plan.sends[0], title: "Changed", hash: "f".repeat(64) });
  for (const kind of ["duplicate", "selector", "accessor", "array", "replay"]) {
    const p = copy({ ...f.plan, phase: 1 }); let calls = 0;
    if (kind === "duplicate") p.sends[1]!.wireMessageId = p.sends[0]!.wireMessageId;
    if (kind === "selector") Object.assign(p, { conflictingReplay: "unknown" });
    if (kind === "accessor") Object.defineProperty(p, "phase", { get() { calls++; return 1; } });
    if (kind === "array") Object.setPrototypeOf(p.sends, { toJSON() { calls++; return []; } });
    if (kind === "replay") p.sends[2]!.hash = "f".repeat(64);
    await assert.rejects(runIngressPhase(p, { ready() { calls++; }, close() { calls++; } })); assert.equal(calls, 0);
  }
});

test("C selected accepted original replay refuses changed durable metadata", async () => {
  const { runIngressPhase } = await import(path.join(import.meta.dirname, "ingress-entry.mjs")); let delivered = 0;
  const f = await transactionConflictFixture((name, value) => {
    if (name === "deliver" && ++delivered === 3) (value.state as State).metadata.totalAttempts++;
  });
  try {
    const result = await runIngressPhase(f.plan, f.effects);
    assert.equal(result.success, false); assert.ok(result.failures.includes("ingress_original_replay_mutation"));
    assert.equal(delivered, 3);
  } finally { f.dispose(); }
});
test("C actual ACK payload body stays out of the shared phase report", async () => {
  const { runIngressPhase } = await import(path.join(import.meta.dirname, "ingress-entry.mjs"));
  const f = await transactionConflictFixture((name, value) => {
    const v = value as { receiver?: { observations: { payload?: object }[] }; activity?: { receiver: { observations: { payload?: object }[] } }; ackObservations?: { payload?: object }[] };
    for (const rows of [v.receiver?.observations, v.activity?.receiver.observations, v.ackObservations]) {
      for (const row of rows ?? []) Object.assign(row.payload ?? {}, { msg: "PRIVATE_ACK_ERROR_BODY" });
    }
  });
  try {
    const result = await runIngressPhase(f.plan, f.effects); assert.equal(result.success, true);
    assert.equal(JSON.stringify(result).includes("PRIVATE_ACK_ERROR_BODY"), false);
  } finally { f.dispose(); }
});
test("C selected closure refuses durable mutation after the last read", async () => {
  const { runIngressPhase } = await import(path.join(import.meta.dirname, "ingress-entry.mjs"));
  const f = await transactionConflictFixture((name, value) => {
    if (name === "close") (value.finalState as State).events[0]!.hash = "f".repeat(64);
  });
  try {
    const result = await runIngressPhase(f.plan, f.effects); assert.equal(result.success, false);
    assert.ok(result.failures.includes("ingress_final_projection"));
  } finally { f.dispose(); }
});

for (const branch of ["default", "missing", "conflict", "conflict-missing"]) {
  test(`C initially minimal real-shaped prepare plan reaches both owners for ${branch}`, async () => {
    const h = await helpers(), selected = branch.includes("conflict"), missingLauncher = branch.includes("missing");
    const f = syntheticEffects(missingLauncher, undefined, selected);
    if (selected) f.plan.sends = h.selectIngressSends(f.plan.sends, { ...f.plan.sends[0], title: "Changed", hash: "f".repeat(64) });
    const captured: Record<string, unknown> = { missingLauncher, ...(selected ? { conflictingReplay: true } : {}) };
    const originalOwner = f.effects.runOwner;
    const effects = { ...f.effects,
      async prepare() { f.calls.push("prepare-minimal"); Object.assign(captured, f.plan); },
      async runOwner(phasePlan: Record<string, unknown>, signal: AbortSignal) {
        // Same closure/object mutation shape as realMain, no application effects.
        Object.assign(phasePlan, captured); return originalOwner(phasePlan, signal);
      },
    };
    const result = await h.runIngressCampaign(captured, effects);
    assert.equal(result.success, true, JSON.stringify(result.failures)); assert.equal(result.phases.length, 2);
    assert.equal(result.phases[0].root, "/synthetic"); assert.equal(result.phases[1].databasePath, "/synthetic/db");
    assert.equal(f.calls.filter(n => n === "retry").length, 1);
    assert.equal(f.calls.filter(n => n === "deliver").length, selected ? 7 : 5);
    assert.equal(result.selectedCase, selected ? "conflicting-replay" : undefined);
    assert.equal(result.branch, missingLauncher ? "missing-launcher" : "live");
  });
}
for (const bad of ["accessor", "array", "selector", "phase"]) {
  test(`C prepared control ${bad} refuses before owner without getter execution`, async () => {
    const h = await helpers(), f = syntheticEffects(); const captured: Record<string, unknown> = { missingLauncher: false };
    let getters = 0, owners = 0;
    const result = await h.runIngressCampaign(captured, {
      ...f.effects,
      async prepare() {
        Object.assign(captured, f.plan);
        if (bad === "accessor") Object.defineProperty(captured, "root", { get() { getters++; return "/synthetic"; } });
        if (bad === "array") Object.setPrototypeOf(captured.sends, { toJSON() { getters++; return []; } });
        if (bad === "selector") captured.missingLauncher = true;
        if (bad === "phase") captured.phase = 1;
      },
      async runOwner() { owners++; throw new Error("ingress_unexpected_owner"); },
    });
    assert.equal(result.success, false); assert.equal(getters, 0); assert.equal(owners, 0);
  });
}
test("C real empty store adapter baseline waits until selected rejection, never before first delivery", async () => {
  const h = await helpers(), { readIngressConflictBaseline } = await import(path.join(import.meta.dirname, "ingress-entry.mjs"));
  const root = mkdtempSync("/private/tmp/ingress-conflict-empty-"); chmodSync(root, 0o700);
  const databasePath = path.join(root, "actual.db"), store = openSessionStore({ filename: databasePath });
  const scope = { region: "feishu" as const, tenantKey: "e2e-tenant", appId: "cli_0123456789abcdef" };
  const { inviteEnvelope } = await import(path.join(import.meta.dirname, "feishu-peer.mjs"));
  const invite = normalizeInvite(inviteEnvelope({ eventId: "ingress-a", providerMeetingId: "component-empty", meetingNo: "987654321",
    title: "First", startSeconds: 1791280800, inviteSeconds: 1791280800, createTimeMs: 1791280800000 }), scope);
  const read = () => h.readIngressState({ databasePath, occurrenceId: invite.occurrenceId }); let reads = 0;
  const adapterRead = () => { reads++; return read(); };
  try {
    assert.throws(read, /ingress_occurrence_count/);
    assert.doesNotThrow(() => assert.equal(readIngressConflictBaseline({ expectedCode: 200 }, adapterRead), undefined));
    assert.doesNotThrow(() => assert.equal(readIngressConflictBaseline({}, adapterRead), undefined)); assert.equal(reads, 0);
    store.acceptInvite(invite, 100); assert.equal(store.admitInviteJoin(invite.occurrenceId, 100, "inviter_not_allowed"), "inviter_not_allowed");
    const before = readIngressConflictBaseline({ expectedCode: 500 }, adapterRead);
    assert.equal(reads, 1); assert.equal(before.metadata.state, "metadata_blocked");
    assert.equal(readIngressConflictBaseline({ expectedCode: 200 }, adapterRead), undefined); assert.equal(reads, 1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
test("C invalid label rejects before effects and serialization without calling toJSON", async () => {
  const h = await helpers(), f = syntheticEffects(); let calls = 0;
  for (const label of ["unknown", { toJSON() { calls++; return "PRIVATE_LABEL"; } }]) {
    await assert.rejects(h.runIngressCampaign(f.plan, f.effects, { label }));
  }
  assert.equal(calls, 0); assert.deepEqual(f.calls, []);
});
for (const mode of ["success", "operation-failed", "accessor"]) {
  test(`C unknown close diagnostic stays outside ${mode} phase reports`, async () => {
    const { runIngressPhase } = await import(path.join(import.meta.dirname, "ingress-entry.mjs")); let getters = 0;
    const f = await transactionConflictFixture((name, value) => {
      if (mode === "operation-failed" && name === "deliver") {
        const receiver = value.receiver as { observations: { payload: { code: number } }[] };
        receiver.observations[0]!.payload.code = 500;
      }
      if (name === "close") {
        if (mode === "accessor") Object.defineProperty(value, "privateDiagnostic", { get() { getters++; return "PRIVATE_DIAGNOSTIC"; } });
        else value.privateDiagnostic = "PRIVATE_DIAGNOSTIC";
      }
    });
    try {
      const result = await runIngressPhase(f.plan, f.effects);
      assert.equal(result.success, false); assert.equal(getters, 0);
      assert.equal(JSON.stringify(result).includes("PRIVATE_DIAGNOSTIC"), false);
      assert.equal(result.close, undefined);
    } finally { f.dispose(); }
  });
}
for (const place of ["outcome", "event", "compositionClosed", "keyCustody"]) {
  test(`C nested close ${place} diagnostic rejects before retaining even a failed close`, async () => {
    const { runIngressPhase } = await import(path.join(import.meta.dirname, "ingress-entry.mjs"));
    const f = await transactionConflictFixture((name, value) => {
      if (name !== "close") return;
      if (place === "outcome") value.outcomes = [{ privateDiagnostic: "PRIVATE_NESTED" }];
      else if (place === "event") ((value.finalState as State).events[0] as unknown as Record<string, unknown>).privateDiagnostic = "PRIVATE_NESTED";
      else value[place] = { privateDiagnostic: "PRIVATE_NESTED" };
    });
    try {
      const result = await runIngressPhase(f.plan, f.effects); assert.equal(result.success, false);
      assert.equal(result.close, undefined); assert.equal(JSON.stringify(result).includes("PRIVATE_NESTED"), false);
      assert.ok(result.failures.includes("ingress_close_fields"));
    } finally { f.dispose(); }
  });
}
test("C closed report keeps the actual optional outcome/organizer DTO and sparse cleanup fixtures", async () => {
  const h = await helpers(), { runIngressPhase } = await import(path.join(import.meta.dirname, "ingress-entry.mjs"));
  const f = await transactionConflictFixture();
  try {
    const result = await runIngressPhase(f.plan, f.effects); assert.equal(result.success, true);
    const close = copy(result.close);
    close.outcomes = [{ occurrenceId: f.plan.occurrenceId, bridgeId: "component-bridge", organizer: {
      feishuUserId: "ou_e2e_organizer", displayName: "Component organizer", source: "reservation" },
    phase: "settled", controlSessionId: "41", failure: null, finalization: "recorded", custody: "assigned",
    runtimeClose: "closed", runtimeCleanup: "graceful" }];
    assert.deepEqual(h.ingressCloseFact(close), close);
    close.outcomes = [{ runtimeCleanup: "unconfirmed" }];
    assert.deepEqual(h.ingressCloseFact(close), close); // The cleanup oracle, not DTO projection, refuses this known negative fact.
  } finally { f.dispose(); }
});

test("C closed report accepts the composition outcome's generations and lease-renewal fields, typed, and still refuses unknown keys", async () => {
  const h = await helpers(), { runIngressPhase } = await import(path.join(import.meta.dirname, "ingress-entry.mjs"));
  const f = await transactionConflictFixture();
  try {
    const result = await runIngressPhase(f.plan, f.effects); assert.equal(result.success, true);
    const close = copy(result.close);
    const outcome = { occurrenceId: f.plan.occurrenceId, bridgeId: "component-bridge", organizer: null, phase: "settled", controlSessionId: "41", failure: null,
      finalization: "recorded", custody: "assigned", runtimeClose: "closed", runtimeCleanup: "graceful", generations: 1, leaseRenewal: "renewing", leaseRenewalFailures: 0 };
    for (const accepted of [{}, { generations: 5 }, { leaseRenewal: null }, ...["inactive", "unsupported", "degraded", "lapsed"].map(leaseRenewal => ({ leaseRenewal })), { leaseRenewalFailures: 3 }]) {
      close.outcomes = [{ ...outcome, ...accepted }];
      assert.deepEqual(h.ingressCloseFact(close), close);
    }
    for (const refused of [{ generations: 0 }, { generations: -1 }, { generations: 1.5 }, { generations: "1" }, { generations: null }, { generations: [{ bridgeSessionId: "b", controlSessionId: "41" }] },
      { leaseRenewal: "renewed" }, { leaseRenewal: 1 }, { leaseRenewalFailures: -1 }, { leaseRenewalFailures: 0.5 }, { leaseRenewalFailures: null }, { privateGeneration: 1 }]) {
      close.outcomes = [{ ...outcome, ...refused }];
      assert.throws(() => h.ingressCloseFact(close), /ingress_close_fields/, JSON.stringify(refused));
    }
  } finally { f.dispose(); }
});

test("closed generation selection is finite and rejects conflicting branches before effects", async () => {
  const h = await helpers(), out = "/private/tmp/meeting-closed-selector-unused";
  assert.deepEqual(h.parseIngressArguments(["--closed-generation-reopen", "--out", out]), { out, missingLauncher: false, closedGenerationReopen: true });
  for (const flags of [["--closed-generation-reopen", "--missing-launcher"], ["--conflicting-replay", "--closed-generation-reopen"],
    ["--closed-generation-reopen", "--closed-generation-reopen"], ["--terminal-reopen"], ["--closed-generation-reopen=true"]]) {
    assert.throws(() => h.parseIngressArguments([...flags, "--out", out]), /ingress_argument|ingress_reopen_selection/);
  }
  const f = syntheticEffects(); Object.assign(f.plan, { closedGenerationReopen: true, missingLauncher: true });
  await assert.rejects(h.runIngressCampaign(f.plan, f.effects), /reopen_selection/); assert.deepEqual(f.calls, []);
});

// Synthetic lifecycle input only; these rows are never authored by the executable.
function closedState() {
  const s = blocked(); s.metadata = { ...s.metadata, state: "admitted", totalAttempts: 1, generationAttempts: 1,
    organizerId: "ou_e2e_organizer", organizerSource: "reservation", reference: { kind: "reservation", reserveId: "reserve-e2e-1" }, admittedAtMs: 204,
    retryGeneration: 2, operatorRetryCount: 1, lastOperator: "e2e-ingress-operator", lastOperatorRetryAtMs: 200 };
  s.events = [...s.events, copy(allowedEvent)];
  return { ...s, sessions: [{ occurrenceId: identity.occurrenceId, providerMeetingId: identity.providerMeetingId,
    occurrenceStartedAt: identity.occurrenceStartedAt, state: "finalizing", terminalReason: null }],
    counts: { ...s.counts, custody: 1, recording: 1 },
    custody: [{ physicalClientId: "synthetic-client", physicalGenerationId: "a".repeat(32), bridgeSessionId: "synthetic-bridge", state: "cleared",
      failure: null, recordedAtMs: 500, outcome: "departure_confirmed", reason: "departure_observed" }],
    generations: [{ bridgeSessionId: "synthetic-bridge", controlSessionId: "41" }],
    reopenEvidence: {
      generation: [{ generationId: "synthetic-generation", occurrenceId: identity.occurrenceId, bridgeSessionId: "synthetic-bridge", controlSessionId: "41",
        handle: "b".repeat(32), terminalAtMs: 300, terminalSource: "bridge_observed", terminalReason: "removed", expiresAtMs: 300 + 1209600000 }],
      timedOwner: [{ generationId: "synthetic-generation", bridgeSessionId: "synthetic-bridge", controlSessionId: "41", state: "closed", tokenPresent: true }],
      recording: [{ occurrenceId: identity.occurrenceId, handle: "b".repeat(32), sha256: "c".repeat(64), keyId: "d".repeat(16), durationMs: 20, finalizedAtMs: 350,
        format: "pcm_s16le/24000/1", captureDrain: "confirmed", captureDrainReason: null, captureDrainEpoch: "1", captureDrainLastFrameSequence: "1",
        captureDrainOutputEndSample: "480", captureDrainFinalPairSequence: "1", bytes: 100, device: "1", inode: "2" }],
      recovery: [{ generationId: "synthetic-generation", occurrenceId: identity.occurrenceId, bridgeSessionId: "synthetic-bridge", controlSessionId: "41",
        handle: "b".repeat(32), sha256: "c".repeat(64), keyId: "d".repeat(16), kind: "final", failureAttempt: null }],
      physical: [{ occurrenceId: identity.occurrenceId, physicalClientId: "synthetic-client", physicalGenerationId: "a".repeat(32), bridgeSessionId: "synthetic-bridge",
        claimedAtMs: 250, clearedAtMs: 500, clearReason: "departure_observed", operatorPresent: false, exitDiagnostic: null,
        outcomeOccurrenceId: identity.occurrenceId, outcomePhysicalClientId: "synthetic-client", outcomePhysicalGenerationId: "a".repeat(32),
        outcomeBridgeSessionId: "synthetic-bridge", observedAt: new Date(450).toISOString() }],
      unknownEnd: [{ occurrenceId: identity.occurrenceId, sourceKind: "final", failureAttempt: 0, handle: "b".repeat(32), sha256: "c".repeat(64), keyId: "d".repeat(16),
        bytes: 100, device: "1", inode: "2", detectedAtMs: 400, deadlineMs: 400 + 1209600000, state: "assigned", claimed: false,
        claimExpiresAtMs: null, failure: null, deletedAtMs: null, lastObservedAtMs: 400 }], counts: { failedRecording: 0, alignmentAttempt: 0 }
    } };
}
const removalFact = () => ({ reason: "removed", observedAt: new Date(300).toISOString(), observationTiming: {
  clockDomainId: "e2e-clock", hostBeforeNs: "10", hostAfterNs: "11" }, observationTimingReason: null, bridgeSessionId: "synthetic-bridge", controlSessionId: "41", captureEpoch: "1", lastFrameSequence: "1", outputEndSample: "480", finalClockPairSequence: "1" });
const historyFact = () => ({ runtime: { bytes: 3, sha256: "e".repeat(64), pids: [43] }, bridge: { bytes: 100, sha256: "f".repeat(64), pid: 44 },
  files: { recording: 1, outbox: 0, receipt: 0, key: true } });
test("closed generation predicate binds removal, recording and both independent retention clocks", async () => {
  const h = await helpers(); h.assertIngressClosedGeneration(closedState(), removalFact());
  assert.equal(closedState().reopenEvidence.timedOwner[0]!.tokenPresent, true);
});

async function reopenFixture(mutate: Mutation = () => {}) {
  const h = await helpers(); let phase = 0; const current = closedState();
  const acceptedAudit = (state: Record<string, unknown>) => { if (Array.isArray(state.events)) for (const [i, e] of state.events.entries()) Object.assign(e, { acceptedAtMs: 100 + i }); };
  acceptedAudit(current);
  const emptyEvidence = () => ({ generation: [], timedOwner: [], recording: [], recovery: [], physical: [], unknownEnd: [], counts: { failedRecording: 0, alignmentAttempt: 0 } });
  // Owner 2's allowed invite: its decoded ACK and commit stay in that owner's settled activity and close.
  const allowedAck: ReturnType<typeof emptyActivity>["receiver"]["observations"] = [], allowedCommits: Record<string, unknown>[] = [];
  const f = syntheticEffects(false, (name, value) => {
    if (phase === 2 && name === "deliver") { allowedAck.push(...copy((value.receiver as ReturnType<typeof emptyActivity>["receiver"]).observations)); allowedCommits.push(copy(value.commit as Record<string, unknown>)); }
    // Existing owners receive selected reader shape even before generation creation.
    if (["deliver", "blocked", "launched", "retry"].includes(name)) (value.state as Record<string, unknown>).reopenEvidence = emptyEvidence();
    if (name === "read" || name === "between") value.reopenEvidence = emptyEvidence();
    if (name === "close") (value.finalState as Record<string, unknown>).reopenEvidence = emptyEvidence();
    if (phase === 2 && name === "launched") (value.state as State).sessions[0]!.state = "listening";
    if (phase === 2 && name === "read" && (value as unknown as State).sessions.length) (value as unknown as State).sessions[0]!.state = "listening";
    if (value.state) acceptedAudit(value.state as Record<string, unknown>);
    if (value.finalState) acceptedAudit(value.finalState as Record<string, unknown>);
    acceptedAudit(value);
    mutate(name, value);
  });
  Object.assign(f.plan, { closedGenerationReopen: true });
  const ordinaryRun = f.effects.runOwner, ordinaryClose = f.owner.close;
  const fact = <T extends object>(name: string, value: T) => { f.calls.push(name); const result = copy(value); mutate(name, result as Record<string, unknown>); return result; };
  const allowedReceiver = () => ({ invalid: false, overflow: false, observations: copy(allowedAck) });
  let settled = false; const live = () => ({ ...emptyActivity(), receiver: allowedReceiver(), files: historyFact().files, runtimePids: [43], bridge: { pid: 44, bridgeSessionId: "synthetic-bridge", envKeys: ["PATH"] },
    outcomes: [{ occurrenceId: identity.occurrenceId, phase: "settled", controlSessionId: "41", failure: null, finalization: "recorded", custody: "assigned", runtimeClose: "closed", runtimeCleanup: "graceful" }] });
  const receiver = emptyActivity().receiver; const commits: Record<string, unknown>[] = [];
  const reopenedActivity = () => ({ ...emptyActivity(), requests: [{ route: "ws_endpoint", status: 200 }], files: historyFact().files, history: historyFact(), receiver });
  Object.assign(f.owner, {
    async remove() { return fact("remove", { requested: "removed" }); },
    async settled() { settled = true; return fact("settled", { state: current, activity: live(), removal: removalFact() }); },
    async close() {
      if (phase === 1 || !settled) return ordinaryClose();
      return fact("close", { standaloneExit: 0, compositionClosed: true, peerClosed: true, lockClosedLast: true, cleanupFailures: [], finalState: current,
        keyCustody: "private_runtime_file", outcomes: phase === 2 ? live().outcomes : [], trace: [], environmentKeys: ["PATH"],
        ...(phase === 2 ? { receiver: allowedReceiver(), commitObservations: copy(allowedCommits), ackObservations: copy(allowedAck) }
          : { receiver, commitObservations: commits, ackObservations: receiver.observations }),
        observerFailure: false, overflow: false, history: historyFact() });
    },
  });
  f.effects.runOwner = async (p, signal) => {
    phase++; if (phase <= 2) return ordinaryRun(p, signal);
    const { runIngressPhase } = await import(path.join(import.meta.dirname, "ingress-entry.mjs"));
    const owner3 = {
      async ready() { return fact("ready3", { admitted: true, started: true, connections: 1, receiver }); },
      async read() { return fact("read3", current); },
      async activity() { return fact("activity3", reopenedActivity()); },
      async discover() { return fact("discover3", { resolved: 0, launched: 0, deferred: 0 }); },
      async deliver(send: typeof f.plan.sends[number]) {
        const commit = { ordinal: 1, ackFloor: 0, wireMessageId: send.wireMessageId, eventId: send.eventId, expectedHash: send.hash, persistedHash: send.hash, immutable: identity };
        commits.push(commit); receiver.observations.push({ ordinal: 1, kind: "ack", messageId: send.wireMessageId, payload: { code: 200 } });
        return fact("deliver3", { commit, receiver, state: current });
      }, close: f.owner.close,
    };
    const result = await runIngressPhase(p, owner3, { signal });
    return fact("owner3", { ...result, ownerProcessProof: { cleanupConfirmed: true, processInventoryVerified: true, knownOwnedChildrenReaped: true,
      pids: [{ pid: 45, origins: ["ingress-phase-3"] }], probes: [{ pid: 45, origins: ["ingress-phase-3"], status: "absent" }],
      children: [{ pid: 45, role: "ingress-phase-3", outcome: { exitObserved: true, code: 0, signal: null } }] },
      child: { pid: 45, closeObserved: true, exitObserved: true, code: 0, signal: null, stdioSettled: true, forced: false } });
  };
  f.effects.between = async () => {
    if (phase !== 1) return fact(`between${phase}`, current);
    const state = { ...blocked(), reopenEvidence: emptyEvidence() }; acceptedAudit(state); return fact("between1", state);
  };
  return { ...f, h };
}
test("selected ordinary campaign waits for removed settlement and cleanup before owner3 replay", async () => {
  const f = await reopenFixture(), result = await f.h.runIngressCampaign(f.plan, f.effects);
  assert.equal(result.success, true, JSON.stringify(result)); assert.equal(result.phases.length, 3);
  assert.equal(result.selectedCase, "closed-generation-reopen"); assert.equal(result.strictTerminalState, false); assert.equal(result.durableSessionState, "finalizing");
  assert.ok(f.calls.indexOf("remove") > f.calls.lastIndexOf("launched"));
  assert.ok(f.calls.indexOf("settled") < f.calls.indexOf("owner2")); assert.ok(f.calls.indexOf("owner2") < f.calls.indexOf("between2"));
  assert.ok(f.calls.indexOf("between2") < f.calls.indexOf("ready3")); assert.ok(f.calls.indexOf("owner3") < f.calls.indexOf("between3"));
  assert.equal(f.calls.filter(c => c === "discover3").length, 2); assert.equal(f.calls.filter(c => c === "deliver3").length, 1);
});

const closedMutations: [string, string, (s: ReturnType<typeof closedState>) => void][] = [
  ...["discovered", "failed", "notified"].map(v => [v, "reopen_session", (s: ReturnType<typeof closedState>) => { s.sessions[0]!.state = v; }] as [string, string, (s: ReturnType<typeof closedState>) => void]),
  ["local clock", "reopen_generation", s => { s.reopenEvidence.generation[0]!.terminalSource = "local_clock"; }],
  ["ended reason", "reopen_generation", s => { s.reopenEvidence.generation[0]!.terminalReason = "ended"; }],
  ["generation expiry clock", "reopen_generation", s => { s.reopenEvidence.generation[0]!.expiresAtMs = s.reopenEvidence.unknownEnd[0]!.deadlineMs; }],
  ["active timed owner", "reopen_timed_owner", s => { s.reopenEvidence.timedOwner[0]!.state = "active"; }],
  ["quarantine", "reopen_physical", s => { s.custody[0]!.state = "quarantined"; }],
  ["manual clearance", "reopen_physical", s => { s.reopenEvidence.physical[0]!.clearReason = "operator_inspected_idle"; }],
  ["unrecorded physical", "reopen_physical", s => { Object.assign(s.custody[0]!, { recordedAtMs: null }); }],
  ["unconfirmed departure", "reopen_physical", s => { s.custody[0]!.outcome = "departure_unconfirmed"; }],
  ["foreign physical", "reopen_physical", s => { s.reopenEvidence.physical[0]!.outcomePhysicalGenerationId = "e".repeat(32); }],
  ["unknown deadline", "reopen_unknown_end", s => { s.reopenEvidence.unknownEnd[0]!.deadlineMs++; }],
  ["unknown first detection", "reopen_unknown_end", s => { s.reopenEvidence.unknownEnd[0]!.detectedAtMs++; s.reopenEvidence.unknownEnd[0]!.deadlineMs++; }],
  ["unknown source", "reopen_unknown_end", s => { s.reopenEvidence.unknownEnd[0]!.sourceKind = "bridge_failure"; }],
  ["unknown cleanup claim", "reopen_unknown_end", s => { s.reopenEvidence.unknownEnd[0]!.claimed = true; }],
  ["recording source identity", "reopen_unknown_end", s => { s.reopenEvidence.recording[0]!.inode = "3"; }],
  ["capture drain", "reopen_recording", s => { s.reopenEvidence.recording[0]!.captureDrain = "unconfirmed"; }],
  ["recovery binding", "reopen_recording", s => { s.reopenEvidence.recovery[0]!.controlSessionId = "42"; }],
  ...["seed", "delivery", "notification"].map(v => [v, "reopen_cardinality", (s: ReturnType<typeof closedState>) => { s.counts[v as "seed"] = 1; }] as [string, string, (s: ReturnType<typeof closedState>) => void]),
];
for (const [name, predicate, change] of closedMutations) test(`C closed generation ${name} independently stops owner3`, async () => {
  const h = await helpers(), s = closedState(); change(s); assert.throws(() => h.assertIngressClosedGeneration(s, removalFact()), new RegExp(predicate));
  const f = await reopenFixture((stage, v) => { if (stage === "settled") change(v.state as ReturnType<typeof closedState>); });
  const result = await f.h.runIngressCampaign(f.plan, f.effects); assert.equal(result.success, false);
  assert.equal(f.calls.includes("ready3"), false); assert.ok(result.phases[1].failures.includes(`ingress_${predicate}`), JSON.stringify(result));
});
for (const stage of ["owner2", "between2", "close2"]) test(`C ${stage} boundary prevents third owner`, async () => {
  let closes = 0;
  const f = await reopenFixture((name, v) => {
    if (name === "owner2" && stage === name) v.ownerProcessProof = { cleanupConfirmed: false };
    if (name === "between2" && stage === name) v.fileIdentity = "other-file";
    if (name === "close" && ++closes === 2 && stage === "close2") (v.finalState as ReturnType<typeof closedState>).events[0]!.title = "late mutation";
  });
  const result = await f.h.runIngressCampaign(f.plan, f.effects); assert.equal(result.success, false); assert.equal(f.calls.includes("ready3"), false);
});
for (const bad of ["resolved", "launched", "deferred", "code500", "wireID", "duplicate", "noCommit", "lateCommit", "audit", "extraOutcome", "history", "postclose", "lateACK"]) {
  test(`C ordinary third-owner ${bad} refuses`, async () => {
    let closes = 0;
    const f = await reopenFixture((stage, v) => {
      if (stage === "discover3" && ["resolved", "launched", "deferred"].includes(bad)) v[bad] = 1;
      if (stage === "deliver3") {
        const r = v.receiver as ReturnType<typeof emptyActivity>["receiver"];
        if (bad === "code500") r.observations[0]!.payload.code = 500;
        if (bad === "wireID") r.observations[0]!.messageId = "phase1-0";
        if (bad === "duplicate") r.observations.push(copy(r.observations[0]!));
        if (bad === "noCommit") delete v.commit;
        if (bad === "lateCommit") (v.commit as { ackFloor: number }).ackFloor = 1;
        if (bad === "audit") (v.state as ReturnType<typeof closedState>).events[0]!.hash = "e".repeat(64);
      }
      if (stage === "activity3" && bad === "extraOutcome") (v.outcomes as object[]).push({ occurrenceId: identity.occurrenceId, phase: "live" });
      if (stage === "activity3" && bad === "history") (v.history as ReturnType<typeof historyFact>).bridge.sha256 = "0".repeat(64);
      if (stage === "close" && ++closes === 3) {
        if (bad === "postclose") (v.finalState as ReturnType<typeof closedState>).reopenEvidence.unknownEnd[0]!.detectedAtMs++;
        if (bad === "lateACK") (v.receiver as ReturnType<typeof emptyActivity>["receiver"]).observations.push({ ordinal: 2, kind: "ack", messageId: "late", payload: { code: 200 } });
      }
    });
    assert.equal((await f.h.runIngressCampaign(f.plan, f.effects)).success, false, bad);
  });
}
test("C preserved historical bytes require no old config and detect append/new/changed source", async () => {
  const h = await helpers(), root = mkdtempSync("/private/tmp/meeting-reopen-history-"); chmodSync(root, 0o700);
  const plan = { runtimePidsPath: path.join(root, "pids"), controlDir: root }, stateFile = path.join(root, "state.json");
  try {
    writeFileSync(plan.runtimePidsPath, "43\n"); writeFileSync(stateFile, JSON.stringify({ pid: 44, configPath: path.join(root, "absent-config") }));
    const history = h.readIngressHistory(plan, historyFact().files);
    assert.equal(existsSync(path.join(root, "absent-config")), false);
    const activity = { ...emptyActivity(), requests: [{ route: "ws_endpoint", status: 200 }], files: history.files, history };
    h.assertIngressReopenActivity(activity, history);
    writeFileSync(plan.runtimePidsPath, "43\n45\n"); assert.throws(() => h.readIngressHistory(plan, history.files), /history_identity/);
    writeFileSync(plan.runtimePidsPath, "43\n "); assert.throws(() => h.assertIngressReopenActivity({ ...activity, history: h.readIngressHistory(plan, history.files) }, history), /reopen_history/);
    writeFileSync(plan.runtimePidsPath, "43\n"); writeFileSync(stateFile, JSON.stringify({ pid: 44, joined: true }));
    assert.throws(() => h.assertIngressReopenActivity({ ...activity, history: h.readIngressHistory(plan, history.files) }, history), /reopen_history/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
for (const field of ["privateDiagnostic", "recording_path", "authorization", "cleanup_claim_token"]) test(`C selected ${field} never survives success or failure report`, async () => {
  for (const failed of [false, true]) {
    const f = await reopenFixture((stage, v) => { if (stage === "settled") {
      const state = v.state as ReturnType<typeof closedState>; Object.assign(state.reopenEvidence.unknownEnd[0]!, { [field]: "PRIVATE_UNRETAINED" });
      if (failed) state.sessions[0]!.state = "failed";
    } });
    const result = await f.h.runIngressCampaign(f.plan, f.effects); assert.equal(result.success, false); assert.equal(f.calls.includes("ready3"), false);
    assert.equal(JSON.stringify(result).includes("PRIVATE_UNRETAINED"), false);
  }
});

async function selectedReaderFixture() {
  const h = await helpers(), peer = await import(path.join(import.meta.dirname, "feishu-peer.mjs"));
  const root = mkdtempSync("/private/tmp/meeting-reopen-reader-"); chmodSync(root, 0o700);
  const databasePath = path.join(root, "state.db"), source = path.join(root, "b".repeat(32) + ".crsr"), token = "private-owner-token".padEnd(36, "x"), authorization = "9".repeat(64);
  const store = openSessionStore({ filename: databasePath }), envelope = peer.inviteEnvelope({ eventId: "original-a", providerMeetingId: "reader-component", meetingNo: "123456789",
    title: "First accepted title", startSeconds: 1791280800, inviteSeconds: 1791280800, createTimeMs: 1791280800000 });
  const invite = normalizeInvite(envelope, peer.SCOPE), occurrenceId = invite.occurrenceId;
  store.acceptInvite(invite, 100); store.close();
  const db = new Database(databasePath), e = closedState().reopenEvidence, g = e.generation[0]!, r = e.recording[0]!, p = e.physical[0]!;
  const generationId = Buffer.from(occurrenceId).toString("hex") + ":" + Buffer.from(g.bridgeSessionId).toString("hex");
  // Only component setup SQL. The executable has no row-writing factory.
  db.prepare(`UPDATE feishu_invite_occurrences SET state='admitted', admitted_at_ms=201,organizer_source='reservation',organizer_id_type='open_id',
    organizer_open_id='ou_e2e_organizer',organizer_display_name='Synthetic Organizer',reference_kind='reservation',reference_json=? WHERE occurrence_id=?`)
    .run(JSON.stringify({ kind: "reservation", reserveId: "reserve-e2e-1" }), occurrenceId);
  db.prepare("INSERT INTO sessions VALUES(?,?,?,?,'finalizing',NULL,100,300)").run(occurrenceId, "synthetic-segment", invite.providerMeetingId, invite.occurrenceStartedAt);
  db.prepare(`INSERT INTO reconciliation_generations(generation_id,occurrence_id,bridge_session_id,runtime_session_id,recording_handle,created_at_ms,terminal_at_ms,terminal_source,terminal_reason,expires_at_ms)
    VALUES(?,?,?,?,?,250,300,'bridge_observed','removed',?)`).run(generationId, occurrenceId, g.bridgeSessionId, "41", r.handle, g.expiresAtMs);
  db.prepare("INSERT INTO timed_evidence_owners(generation_id,owner_token,state) VALUES(?,?,'closed')").run(generationId, token);
  writeFileSync(source, Buffer.alloc(100), { mode: 0o600 });
  db.prepare(`INSERT INTO recordings(occurrence_id,handle,sha256,duration_ms,finalized_at_ms,encrypted_path,format,key_id,capture_drain,capture_drain_reason,
    capture_drain_epoch,capture_drain_last_frame_sequence,capture_drain_output_end_sample,capture_drain_final_pair_sequence)
    VALUES(?,?,?,?,?,?,?,?, 'confirmed',NULL,'1','1','480','1')`).run(occurrenceId, r.handle, r.sha256, 20, 350, source, r.format, r.keyId);
  db.prepare(`INSERT INTO recording_recovery_bindings(generation_id,occurrence_id,bridge_session_id,source_session_id,recording_handle,sha256,key_id,authorization,recording_kind,failure_attempt)
    VALUES(?,?,?,?,?,?,?,?,'final',NULL)`).run(generationId, occurrenceId, g.bridgeSessionId, "41", r.handle, r.sha256, r.keyId, authorization);
  const outcome = { schema: "bridge-process-outcome/v1", physicalClientId: p.physicalClientId, physicalGenerationId: p.physicalGenerationId,
    occurrenceId, bridgeSessionId: p.bridgeSessionId, outcome: "departure_confirmed", reason: "departure_observed", observedAt: p.observedAt };
  db.prepare(`INSERT INTO physical_client_custody(physical_client_id,physical_generation_id,occurrence_id,bridge_session_id,state,claimed_at_ms,
    outcome_json,outcome_recorded_at_ms,cleared_at_ms,clear_reason) VALUES(?,?,?,?,'cleared',250,?,500,500,'departure_observed')`)
    .run(p.physicalClientId, p.physicalGenerationId, occurrenceId, p.bridgeSessionId, JSON.stringify(outcome));
  const assigner = openSessionStore({ filename: databasePath });
  assigner.assignUnknownEndCustody({ kind: "final", occurrenceId }, 400, { recordingHandle: r.handle, encryptedPath: source, sha256: r.sha256, keyId: r.keyId });
  assigner.close();
  const read = () => h.readIngressState({ databasePath, occurrenceId, closedGenerationReopen: true });
  return { h, read, db, databasePath, source, root, invite, envelope, token, authorization, occurrenceId, generationId, dispose() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}
test("C selected guarded schema29 projection and production exact replay/decoder preserve closed source", async () => {
  const f = await selectedReaderFixture();
  try {
    const before = f.read(); f.h.assertIngressClosedGeneration(before, removalFact());
    assert.equal(before.reopenEvidence.timedOwner[0].tokenPresent, true);
    const json = JSON.stringify(before); for (const privateValue of [f.source, f.token, f.authorization]) assert.equal(json.includes(privateValue), false);
    assert.equal(f.h.readIngressState({ databasePath: f.databasePath, occurrenceId: f.occurrenceId }).reopenEvidence, undefined);
    const store = openSessionStore({ filename: f.databasePath });
    try {
      const codec = store.getRecording(f.occurrenceId)!; assert.equal(codec.captureDrain?.drain, "confirmed");
      store.acceptInvite(normalizeInvite(f.envelope, { region: "feishu", tenantKey: "e2e-tenant", appId: "cli_0123456789abcdef" }), 600);
    } finally { store.close(); }
    assert.deepEqual(f.read(), before);
    const peer = await import(path.join(import.meta.dirname, "feishu-peer.mjs")), decoder = peer.createFeishuFrameReceiver();
    decoder.receive(peer.eventFrame({ code: 200 }, "phase3-a-replay"));
    const commit = { ordinal: 1, wireMessageId: "phase3-a-replay", eventId: f.invite.eventId, expectedHash: f.invite.normalizedSha256,
      persistedHash: before.events[0].hash, immutable: before.immutable, ackFloor: 0 };
    f.h.assertIngressAck({ wireMessageId: "phase3-a-replay", eventId: f.invite.eventId, hash: f.invite.normalizedSha256, occurrenceId: f.occurrenceId },
      { commit, receiver: { invalid: decoder.invalid, overflow: decoder.overflow, observations: decoder.observations } }, before.immutable);
  } finally { f.dispose(); }
});
for (const bad of ["missingOwner", "foreignGeneration", "duplicateGeneration", "foreignRecovery", "recordingBinding", "physicalBinding", "sourceReplacement", "sidecar", "selectionAccessor"]) {
  test(`C guarded reopen reader ${bad} refuses its bound source`, async () => {
    const f = await selectedReaderFixture();
    try {
      if (bad === "missingOwner") f.db.exec("DELETE FROM timed_evidence_owners");
      if (["foreignGeneration", "foreignRecovery"].includes(bad)) f.db.pragma("foreign_keys=OFF"); // Explicit malformed component database input.
      if (bad === "foreignGeneration") f.db.prepare("UPDATE reconciliation_generations SET occurrence_id='foreign'").run();
      if (bad === "duplicateGeneration") f.db.prepare(`INSERT INTO reconciliation_generations(generation_id,occurrence_id,bridge_session_id,created_at_ms) VALUES('extra',?,'extra',250)`).run(f.occurrenceId);
      if (bad === "foreignRecovery") f.db.exec("UPDATE recording_recovery_bindings SET occurrence_id='foreign'");
      if (bad === "recordingBinding") f.db.exec("UPDATE recording_recovery_bindings SET source_session_id='42'");
      if (bad === "physicalBinding") f.db.exec("UPDATE physical_client_custody SET bridge_session_id='other'");
      if (bad === "sourceReplacement") { rmSync(f.source); writeFileSync(f.source, Buffer.alloc(101), { mode: 0o600 }); }
      if (bad === "sidecar") writeFileSync(f.databasePath + "-wal", "synthetic");
      if (bad === "selectionAccessor") {
        let calls = 0; const input = { databasePath: f.databasePath, occurrenceId: f.occurrenceId, get closedGenerationReopen() { calls++; return true; } };
        assert.throws(() => f.h.readIngressState(input), /descriptor/); assert.equal(calls, 0); return;
      }
      const predicate = bad === "duplicateGeneration" ? "binding_count" : bad === "recordingBinding" ? "reopen_recording" : bad === "physicalBinding" ? "reopen_physical" : bad === "sourceReplacement" ? "reopen_unknown_end" : bad === "sidecar" ? "WAL" : "reopen_cardinality";
      assert.throws(() => f.h.assertIngressClosedGeneration(f.read(), removalFact()), new RegExp(predicate));
    } finally { f.dispose(); }
  });
}

for (const bad of ["extraChild", "wrongOrigin", "historicalPID"]) test(`C third-owner ${bad} process attribution refuses even with cleanupConfirmed`, async () => {
  const f = await reopenFixture((stage, v) => {
    if (stage !== "owner3") return;
    const p = v.ownerProcessProof as { pids: { pid: number; origins: string[] }[] };
    if (bad === "extraChild") p.pids.push({ pid: 46, origins: ["ingress-phase-3"] });
    if (bad === "wrongOrigin") p.pids[0]!.origins = ["ingress-phase-2"];
    if (bad === "historicalPID") p.pids[0]!.pid = 43;
  });
  const result = await f.h.runIngressCampaign(f.plan, f.effects); assert.equal(result.success, false); assert.deepEqual(result.failures, ["ingress_reopen_process_origins"]);
});

for (const bad of [undefined, "noRecord", "untaggedHelper", "unsettledHelper", "ownerMismatch"]) test(`C third-owner registered admission helper ${bad ?? "accepted"} through the campaign transition`, async () => {
  const tag = "ingress-phase-3-admission-helper";
  const f = await reopenFixture((stage, v) => {
    if (stage !== "owner3") return;
    const p = v.ownerProcessProof as { pids: { pid: number; origins: string[] }[]; probes: { pid: number; origins: string[]; status: string }[] };
    const origins = bad === "untaggedHelper" ? ["ingress-phase-3"] : ["ingress-phase-3", tag];
    p.pids.push({ pid: 46, origins }); p.probes.push({ pid: 46, origins, status: "absent" });
    if (bad !== "noRecord") v.admissionHelpers = { schema: "meeting-ingress-admission-helpers/v1", ownerPid: bad === "ownerMismatch" ? 47 : 45, invalid: false,
      helpers: [{ sequence: 1, role: "volume_inspection", pid: 46, exitObserved: true, closeObserved: bad !== "unsettledHelper", code: 0, signal: null }] };
  });
  const result = await f.h.runIngressCampaign(f.plan, f.effects);
  if (bad === undefined) {
    assert.equal(result.success, true, JSON.stringify(result.failures));
    assert.deepEqual(result.phases[2].ownerProcessProof.pids.map((row: { pid: number }) => row.pid), [45, 46]);
  } else { assert.equal(result.success, false); assert.deepEqual(result.failures, ["ingress_reopen_process_origins"]); }
});

test("C real store replay and decoder bytes pass the shared ordinary third-owner consumer", async () => {
  const f = await selectedReaderFixture(), peer = await import(path.join(import.meta.dirname, "feishu-peer.mjs"));
  const { runIngressPhase } = await import(path.join(import.meta.dirname, "ingress-entry.mjs")), decoder = peer.createFeishuFrameReceiver();
  const commits: Record<string, unknown>[] = [], baseline = f.read(), history = historyFact();
  const send = { eventId: f.invite.eventId, hash: f.invite.normalizedSha256, title: f.invite.title, createTime: f.invite.createTime,
    inviteSeconds: f.invite.inviteSeconds, startSeconds: f.invite.startSeconds, occurrenceId: f.occurrenceId, envelope: f.envelope, wireMessageId: "phase1-a-1" };
  const receiver = () => ({ invalid: decoder.invalid, overflow: decoder.overflow, observations: decoder.observations });
  const activity = () => ({ ...emptyActivity(), requests: [{ route: "ws_endpoint", status: 200 }], files: history.files, history, receiver: receiver() });
  const effects = {
    async ready() { return { admitted: true, started: true, connections: 1, receiver: receiver() }; },
    async read() { return f.read(); }, async activity() { return activity(); }, async discover() { return { resolved: 0, launched: 0, deferred: 0 }; },
    async deliver(s: typeof send) {
      const store = openSessionStore({ filename: f.databasePath });
      try { store.acceptInvite(normalizeInvite(s.envelope, peer.SCOPE), 600); } finally { store.close(); }
      const persisted = f.read(), commit = { ordinal: 1, ackFloor: 0, wireMessageId: s.wireMessageId, eventId: s.eventId,
        expectedHash: s.hash, persistedHash: persisted.events[0].hash, immutable: persisted.immutable };
      commits.push(commit); decoder.receive(peer.eventFrame({ code: 200 }, s.wireMessageId)); // Explicit synthetic wire input, not actual SDK.
      return { commit, receiver: receiver(), state: persisted };
    },
    async close() { return { standaloneExit: 0, compositionClosed: true, peerClosed: true, lockClosedLast: true, cleanupFailures: [], finalState: f.read(),
      history, outcomes: [], trace: [], environmentKeys: ["PATH"], receiver: receiver(), ackObservations: decoder.observations, commitObservations: commits, observerFailure: false, overflow: false }; },
  };
  try {
    const result = await runIngressPhase({ closedGenerationReopen: true, phase: 3, root: f.root, databasePath: f.databasePath,
      original: baseline, history, removal: removalFact(), sends: [send] }, effects);
    assert.equal(result.success, true, JSON.stringify(result.failures)); assert.deepEqual(result.close.finalState, baseline);
    assert.equal(result.close.receiver.observations[0].messageId, "phase3-a-replay"); assert.equal(result.close.commitObservations.length, 1);
  } finally { f.dispose(); }
});
for (const bad of ["getter", "customArray", "toJSON", "nonprimitiveFailure", "rawKnownField"]) test(`C selected DTO ${bad} is discarded before failure serialization`, async () => {
  let getterCalls = 0;
  const f = await reopenFixture((stage, v) => {
    if (stage !== "settled") return;
    const s = v.state as ReturnType<typeof closedState>;
    if (bad === "getter") Object.defineProperty(s.reopenEvidence.unknownEnd[0], "privateDiagnostic", { get() { getterCalls++; return "PRIVATE_UNRETAINED"; } });
    if (bad === "customArray") Object.setPrototypeOf(s.reopenEvidence.unknownEnd, Object.create(Array.prototype));
    if (bad === "toJSON") Object.assign(s.reopenEvidence.unknownEnd[0]!, { toJSON() { getterCalls++; return "PRIVATE_UNRETAINED"; } });
    if (bad === "nonprimitiveFailure") Object.assign(s.reopenEvidence.unknownEnd[0]!, { failure: { privateDiagnostic: "PRIVATE_UNRETAINED" } });
    if (bad === "rawKnownField") s.reopenEvidence.generation[0]!.generationId = "/private/PRIVATE_UNRETAINED";
  });
  const result = await f.h.runIngressCampaign(f.plan, f.effects); assert.equal(result.success, false); assert.equal(getterCalls, 0);
  assert.equal(JSON.stringify(result).includes("PRIVATE_UNRETAINED"), false); assert.equal(f.calls.includes("ready3"), false);
});
test("C synchronous effect cannot overrun an absolute selected phase budget", async () => {
  const { runIngressPhase } = await import(path.join(import.meta.dirname, "ingress-entry.mjs")); let deliveries = 0;
  const effects = { ready() { const end = performance.now() + 4; while (performance.now() < end) { /* synchronous component input */ }
    return { admitted: true, started: true, connections: 1, receiver: emptyActivity().receiver }; },
    deliver() { deliveries++; }, close() { return { standaloneExit: 0, compositionClosed: true, peerClosed: true, lockClosedLast: true, cleanupFailures: [], outcomes: [],
      receiver: emptyActivity().receiver, ackObservations: [], commitObservations: [], observerFailure: false, overflow: false }; } };
  const result = await runIngressPhase({ phase: 1, closedGenerationReopen: true, root: "/synthetic", databasePath: "/synthetic/db" }, effects, { budgetMs: 1 });
  assert.equal(result.success, false); assert.ok(result.failures.includes("ingress_phase_cancelled")); assert.equal(deliveries, 0);
});

test("C selected prepare retains captured population alias and fences changed selection", async () => {
  const f = await reopenFixture(), populated = copy(f.plan);
  const minimal = { closedGenerationReopen: true, missingLauncher: false };
  f.effects.prepare = async () => { f.calls.push("prepare"); Object.assign(minimal, populated); };
  assert.equal((await f.h.runIngressCampaign(minimal, f.effects)).success, true);
  const changed = await reopenFixture(); changed.effects.prepare = async () => { Object.assign(changed.plan, { closedGenerationReopen: false }); };
  const result = await changed.h.runIngressCampaign(changed.plan, changed.effects); assert.equal(result.success, false);
  assert.deepEqual(result.failures, ["ingress_prepared_controls"]); assert.equal(changed.calls.includes("owner1"), false);
});
for (const bad of ["notListening", "wrongRemoval", "settledFailure", "unconfirmedRuntime", "unsolicited3", "closeDiagnostic", "lateCustody", "parentLateCustody"]) test(`C reopen ${bad} boundary refuses`, async () => {
  let closes = 0;
  const f = await reopenFixture((stage, v) => {
    if (bad === "notListening" && stage === "launched") (v.state as State).sessions[0]!.state = "discovered";
    if (bad === "notListening" && stage === "read" && (v as unknown as State).sessions.length) (v as unknown as State).sessions[0]!.state = "discovered";
    if (bad === "wrongRemoval" && stage === "settled") (v.removal as ReturnType<typeof removalFact>).observedAt = new Date(301).toISOString();
    if (stage === "settled") {
      const a = v.activity as { outcomes: { failure: string | null; runtimeCleanup: string }[] };
      if (bad === "settledFailure") a.outcomes[0]!.failure = "join_failed";
      if (bad === "unconfirmedRuntime") a.outcomes[0]!.runtimeCleanup = "unconfirmed";
    }
    if (bad === "unsolicited3" && stage === "ready3") (v.receiver as ReturnType<typeof emptyActivity>["receiver"]).observations.push({ ordinal: 1, kind: "ack", messageId: "unsolicited", payload: { code: 200 } });
    if (stage === "close" && ++closes === 3) {
      if (bad === "closeDiagnostic") Object.assign((v.finalState as ReturnType<typeof closedState>).reopenEvidence.physical[0]!, { privateDiagnostic: "PRIVATE_UNRETAINED" });
      if (bad === "lateCustody") (v.finalState as ReturnType<typeof closedState>).reopenEvidence.unknownEnd[0]!.deadlineMs++;
    }
    if (bad === "parentLateCustody" && stage === "between3") (v as unknown as ReturnType<typeof closedState>).reopenEvidence.unknownEnd[0]!.deadlineMs++;
  });
  const result = await f.h.runIngressCampaign(f.plan, f.effects); assert.equal(result.success, false, bad); assert.equal(JSON.stringify(result).includes("PRIVATE_UNRETAINED"), false);
  if (["notListening", "wrongRemoval", "settledFailure", "unconfirmedRuntime"].includes(bad)) assert.equal(f.calls.includes("ready3"), false);
});

test("C early selected refusal reports only observed owners and durable session state", async () => {
  const f = await reopenFixture((stage, v) => { if (stage === "ready") v.admitted = false; });
  const result = await f.h.runIngressCampaign(f.plan, f.effects); assert.equal(result.success, false);
  assert.equal(result.phaseCount, 1); assert.equal(result.durableSessionState, null); assert.equal(result.strictTerminalState, false);
  assert.equal(f.calls.includes("owner2"), false); assert.equal(f.calls.includes("ready3"), false);
});

for (const changed of ["immutableTitle", "immutableAcceptance", "auditTitle", "auditAcceptance"]) test(`C correlated removal ${changed} cannot replace the admitted invitation baseline`, async () => {
  let removed = false;
  const mutateState = (s: Record<string, unknown>) => {
    const immutable = s.immutable as typeof identity, audit = s.events as (typeof events[number] & { acceptedAtMs: number })[];
    if (changed === "immutableTitle") immutable.title = "Changed during removal";
    if (changed === "immutableAcceptance") immutable.acceptedAtMs = 101;
    if (changed === "auditTitle") audit[0]!.title = "Changed during removal";
    if (changed === "auditAcceptance") audit[0]!.acceptedAtMs = 101;
  };
  const f = await reopenFixture((stage, v) => {
    if (stage === "settled") removed = true;
    if (!removed) return;
    // Every later lifecycle/read/close input agrees with the changed baseline.
    // No later mismatch supplies an incidental reason to reject this input.
    if (v.state) mutateState(v.state as Record<string, unknown>);
    if (v.finalState) mutateState(v.finalState as Record<string, unknown>);
    if (stage === "between2" || stage === "between3" || stage === "read3") mutateState(v);
    if (stage === "deliver3") {
      const commit = v.commit as { immutable: typeof identity };
      if (changed === "immutableTitle") commit.immutable.title = "Changed during removal";
      if (changed === "immutableAcceptance") commit.immutable.acceptedAtMs = 101;
    }
    if (stage === "close") for (const commit of v.commitObservations as { immutable: typeof identity }[]) {
      if (changed === "immutableTitle") commit.immutable.title = "Changed during removal";
      if (changed === "immutableAcceptance") commit.immutable.acceptedAtMs = 101;
    }
  });
  const result = await f.h.runIngressCampaign(f.plan, f.effects);
  assert.equal(result.success, false, changed); assert.equal(f.calls.includes("ready3"), false);
  assert.ok(result.phases[1].failures.includes(changed.startsWith("immutable") ? "ingress_removal_immutable_mutation" : "ingress_removal_audit_mutation"), JSON.stringify(result.failures));
});

// H1: phase 2 binds the bridge PID from the owner's own spawn registration (the genuinely returned
// ChildProcess and its exit/close), so a healthy bridge that lives shorter than one 100 ms ps sample still binds.
const OWNER_ROLE = "ingress-phase-2", RUNTIME_PID = 777001;
async function bridgeBindingApis() {
  const h = await helpers(), { createProcessEvidence } = await import(path.join(import.meta.dirname, "process-evidence.mjs"));
  const provenance = await import(path.join(import.meta.dirname, "admission-helper-provenance.mjs"));
  return { h, createProcessEvidence, provenance };
}
/** Owner-rooted samples that show the owner and its Runtime but never the bridge. */
function sampledWithoutBridge(h: { observeIngressInventory: (e: unknown, o: unknown) => unknown }, evidence: unknown, ownerPid: number, extra = "") {
  const sample = (stdout: string) => ({ exit: 0, signal: null, stdout, stderr: "", durationMs: 1 });
  h.observeIngressInventory(evidence, { rootPid: ownerPid, owner: OWNER_ROLE, stage: "phase-2-running", result: sample(`${ownerPid} 1 node\n${RUNTIME_PID} ${ownerPid} /x/conversation-runtime-gateway\n${extra}`) });
}
const settledBridge = (pid: number, extra: Record<string, unknown> = {}) => ({ sequence: 1, pid, exitObserved: true, closeObserved: true, code: 0, signal: null, ...extra });
const bridgeRecord = (ownerPid: number, bridges: object[], extra: Record<string, unknown> = {}) => ({ schema: "meeting-ingress-bridge-spawns/v1", ownerPid, invalid: false, bridges, ...extra });
const ownerResult = (bridgePid: number, bridgeSpawns?: object) => ({ activity: { runtimePids: [RUNTIME_PID], bridge: { pid: bridgePid } }, ...(bridgeSpawns ? { bridgeSpawns } : {}) });

test("phase 2 binds a real bridge that exits before any sample from the owner's spawn registration", async () => {
  const { h, createProcessEvidence, provenance } = await bridgeBindingApis();
  const { spawn } = await import("node:child_process");
  const dir = mkdtempSync(path.join(process.env.TMPDIR ?? "/private/tmp", "bridge-binding-")); chmodSync(dir, 0o700);
  const script = path.join(dir, "e2e-bridge-child.mjs"); writeFileSync(script, "process.exit(0);\n", { mode: 0o600 });
  const module = { spawn } as { spawn: typeof spawn }; let synced = 0;
  const observer = provenance.createBridgeSpawnObserver(module, { ownerPid: process.pid, sync: () => { synced++; } });
  try {
    observer.start(); assert.equal(synced, 1); assert.notEqual(module.spawn, spawn);
    const unrelated = module.spawn("/usr/bin/true", [], { stdio: "ignore" });
    const bridge = module.spawn(process.execPath, [script, "--config", path.join(dir, "config.json")], { stdio: ["pipe", "pipe", "pipe", "pipe"], env: {}, shell: false, detached: false });
    await Promise.all([new Promise(r => bridge.once("close", r)), new Promise(r => unrelated.once("close", r))]);
    observer.stop(); assert.equal(module.spawn, spawn); assert.equal(synced, 2);
    const record = observer.record();
    assert.deepEqual(record, bridgeRecord(process.pid, [settledBridge(bridge.pid!)]), "only the bridge-shaped spawn is registered");
    const evidence = createProcessEvidence(); sampledWithoutBridge(h, evidence, process.pid);
    assert.equal(h.ingressOwnedPidsBound(evidence, { role: OWNER_ROLE, ownerPid: process.pid, result: ownerResult(bridge.pid!, record) }), true);
    assert.equal(h.ingressOwnedPidsBound(evidence, { role: OWNER_ROLE, ownerPid: process.pid, result: ownerResult(bridge.pid!) }), false, "without registration an unsampled bridge stays unbound");
  } finally { observer.stop(); rmSync(dir, { recursive: true, force: true }); }
});

const OWNER = 700001, BRIDGE = 700002;
for (const [name, result, extraRows] of [
  ["an unregistered, unsampled bridge PID", ownerResult(BRIDGE, bridgeRecord(OWNER, [])), ""],
  ["a sampled bridge PID the owner never registered", ownerResult(BRIDGE, bridgeRecord(OWNER, [settledBridge(BRIDGE + 1)])), `${BRIDGE} ${OWNER} node\n`],
  ["a registration naming another PID", ownerResult(BRIDGE, bridgeRecord(OWNER, [settledBridge(BRIDGE + 1)])), ""],
  ["a second bridge spawn", ownerResult(BRIDGE, bridgeRecord(OWNER, [settledBridge(BRIDGE), settledBridge(BRIDGE + 1, { sequence: 2 })])), ""],
  ["a bridge that exited nonzero", ownerResult(BRIDGE, bridgeRecord(OWNER, [settledBridge(BRIDGE, { code: 1 })])), ""],
  ["a bridge killed by a signal", ownerResult(BRIDGE, bridgeRecord(OWNER, [settledBridge(BRIDGE, { code: null, signal: "SIGKILL" })])), ""],
  ["a bridge whose close was never observed", ownerResult(BRIDGE, bridgeRecord(OWNER, [settledBridge(BRIDGE, { closeObserved: false })])), ""],
  ["an invalid registration", ownerResult(BRIDGE, bridgeRecord(OWNER, [settledBridge(BRIDGE)], { invalid: true })), ""],
  ["a registration by another owner", ownerResult(BRIDGE, bridgeRecord(OWNER + 5, [settledBridge(BRIDGE)])), ""],
  ["an unsampled Runtime", { activity: { runtimePids: [RUNTIME_PID + 1], bridge: { pid: BRIDGE } }, bridgeSpawns: bridgeRecord(OWNER, [settledBridge(BRIDGE)]) }, ""],
  ["a registration with an extra private field", ownerResult(BRIDGE, bridgeRecord(OWNER, [settledBridge(BRIDGE, { argv: "private" })])), ""],
] as const) {
  test(`phase 2 bridge binding refuses ${name}`, async () => {
    const { h, createProcessEvidence } = await bridgeBindingApis(), evidence = createProcessEvidence();
    sampledWithoutBridge(h, evidence, OWNER, extraRows);
    assert.equal(h.ingressOwnedPidsBound(evidence, { role: OWNER_ROLE, ownerPid: OWNER, result }), false);
  });
}
test("phase 2 bridge binding keeps the sampled path without a registration and accepts sampled plus registered", async () => {
  const { h, createProcessEvidence } = await bridgeBindingApis(), evidence = createProcessEvidence();
  sampledWithoutBridge(h, evidence, OWNER, `${BRIDGE} ${OWNER} node\n`);
  assert.equal(h.ingressOwnedPidsBound(evidence, { role: OWNER_ROLE, ownerPid: OWNER, result: ownerResult(BRIDGE) }), true);
  assert.equal(h.ingressOwnedPidsBound(evidence, { role: OWNER_ROLE, ownerPid: OWNER, result: ownerResult(BRIDGE, bridgeRecord(OWNER, [settledBridge(BRIDGE)])) }), true);
  assert.equal(h.ingressOwnedPidsBound(evidence, { role: OWNER_ROLE, ownerPid: OWNER, result: { activity: { runtimePids: [], bridge: null } } }), true);
});
test("bridge spawn observer marks a bridge-shaped spawn that returns the owner PID or no PID invalid", async () => {
  const { provenance } = await bridgeBindingApis(), { EventEmitter } = await import("node:events");
  for (const pid of [OWNER, undefined]) {
    const fake: { spawn: (...args: unknown[]) => object } = { spawn: () => Object.assign(new EventEmitter(), { pid }) };
    const observer = provenance.createBridgeSpawnObserver(fake, { ownerPid: OWNER, sync: () => {} });
    observer.start(); fake.spawn("/x/node", ["/x/e2e/fixtures/e2e-bridge-child.mjs", "--config", "/x/c.json"], { stdio: ["pipe", "pipe", "pipe", "pipe"], env: {}, shell: false, detached: false }); observer.stop();
    assert.equal(observer.record().invalid, true, String(pid));
  }
});
