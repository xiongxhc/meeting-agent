import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, chmodSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";

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
type State = { fileIdentity: string; immutable: typeof identity; events: typeof events; sessions: { occurrenceId: string; providerMeetingId: string; occurrenceStartedAt: string; state: string }[];
  metadata: { state: string; reason: string; claimed: number; claimExpiresAtMs: number | null; organizerId: string | null; organizerSource: string | null;
    reference: { kind: string; reserveId: string } | null; admittedAtMs: number | null; totalAttempts: number; generationAttempts: number;
    generationStartedAtMs: number | null; firstAttemptAtMs: number; lastAttemptAtMs: number; retryGeneration: number; operatorRetryCount: number;
    lastOperator: string | null; lastOperatorRetryAtMs: number | null; nextAttemptAtMs: number };
  counts: { custody: number; recording: number; seed: number; delivery: number; notification: number } };
function blocked(): State {
  return { fileIdentity: "synthetic-file", immutable: copy(identity), events: copy(events), sessions: [],
    metadata: { state: "metadata_blocked", reason: "metadata_unavailable", claimed: 0, claimExpiresAtMs: null,
      organizerId: null, organizerSource: null, reference: null, admittedAtMs: null, totalAttempts: 1,
      generationAttempts: 1, generationStartedAtMs: 101, firstAttemptAtMs: 101, lastAttemptAtMs: 101,
      retryGeneration: 0, operatorRetryCount: 0, lastOperator: null, lastOperatorRetryAtMs: null, nextAttemptAtMs: 100 },
    counts: { custody: 0, recording: 0, seed: 0, delivery: 0, notification: 0 } };
}
const emptyActivity = () => ({ trace: ["composition_lock_verified", "composition_store_opened", "composition_started"],
  requests: [{ route: "unmatched", status: 404 }], messages: [], runtimePids: [], bridge: null,
  files: { recording: 0, outbox: 0, receipt: 0, key: false }, outcomes: [], envKeys: ["PATH"],
  receiver: { invalid: false, overflow: false, observations: [] as { ordinal: number; kind: string; messageId: string; payload: { code: number } }[] } });
type Mutation = (name: string, fact: Record<string, unknown>) => void;
function syntheticEffects(missingLauncher = false, mutate: Mutation = () => {}) {
  const calls: string[] = [], plans = { occurrenceId: identity.occurrenceId, expected: events, sends: [0, 1, 2, 0].map((index, send) =>
    ({ ...events[index]!, wireMessageId: `phase1-${send}`, occurrenceId: identity.occurrenceId })) };
  let current = blocked(), activity = emptyActivity(), phase = 0, sends = 0;
  const commits: { ordinal: number; ackFloor: number; wireMessageId: string; eventId: string; expectedHash: string; persistedHash: string; immutable: typeof identity }[] = [];
  const fact = <T extends object>(name: string, value: T): T => { calls.push(name); const result = copy(value); mutate(name, result as Record<string, unknown>); return result; };
  const owner = {
    async ready() { return fact("ready", { admitted: true, started: true, connections: 1, receiver: activity.receiver }); },
    async deliver(send: typeof plans.sends[number]) {
      sends++; current.events = copy(events.slice(0, Math.min(sends, 3)));
      activity.receiver.observations.push({ ordinal: sends, kind: "ack", messageId: send.wireMessageId, payload: { code: 200 } });
      commits.push({ ordinal: sends, ackFloor: sends - 1, wireMessageId: send.wireMessageId, eventId: send.eventId,
        expectedHash: send.hash, persistedHash: send.hash, immutable: copy(identity) });
      return fact("deliver", { commit: { ordinal: sends, ackFloor: sends - 1, wireMessageId: send.wireMessageId,
        eventId: send.eventId, expectedHash: send.hash, persistedHash: send.hash, immutable: identity },
        receiver: { invalid: false, overflow: false, observations: [{ ordinal: sends, kind: "ack", messageId: send.wireMessageId, payload: { code: 200 } }] }, state: current });
    },
    async blocked() { return fact("blocked", { state: current, activity }); },
    async read() { return fact("read", current); },
    async discover() { return fact("discover", { launched: 0, resolved: 0, deferred: 0 }); },
    async retry() {
      current.metadata = { ...current.metadata, state: "pending_metadata", generationAttempts: 0, generationStartedAtMs: null,
        retryGeneration: 1, operatorRetryCount: 1, lastOperator: "e2e-ingress-operator", lastOperatorRetryAtMs: 200, nextAttemptAtMs: 200 };
      return fact("retry", { result: "pending", state: current });
    },
    async launched() {
      current.metadata = { ...current.metadata, state: "admitted", totalAttempts: 2, generationAttempts: 1,
        organizerId: "ou_e2e_organizer", organizerSource: "reservation", reference: { kind: "reservation", reserveId: "reserve-e2e-1" }, admittedAtMs: 201 };
      current.sessions = [{ occurrenceId: identity.occurrenceId, providerMeetingId: identity.providerMeetingId,
        occurrenceStartedAt: identity.occurrenceStartedAt, state: "discovered" }];
      const outcome = { occurrenceId: identity.occurrenceId, phase: missingLauncher ? "settled" : "live",
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
      observerFailure: false, overflow: false, commitObservations: commits, ackObservations: activity.receiver.observations }); },
  };
  const { acceptedAtMs: _acceptedAtMs, ...immutableExpected } = identity; void _acceptedAtMs;
  return { calls, plan: { ...plans, immutableExpected, missingLauncher, root: "/synthetic", databasePath: "/synthetic/db" },
    effects: {
      async prepare() { calls.push("prepare"); },
      async runOwner(p: Record<string, unknown>, signal: AbortSignal) {
        phase++; current = blocked(); activity = emptyActivity(); commits.length = 0;
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

test("synthetic two-owner campaign uses shared transitions, exact replay and one public retry", async () => {
  const { runIngressCampaign } = await helpers();
  const fixture = syntheticEffects(); const result = await runIngressCampaign(fixture.plan, fixture.effects);
  assert.equal(result.success, true); assert.equal(result.label, "component-facts");
  assert.equal(fixture.calls.filter(name => name === "deliver").length, 4);
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
  "dbIdentity", "root", "noClose", "signal", "stdio", "lingering", "autoRetry", "extraRetry", "falseReady", "crossWire", "secondLaunch", "cleanup"]) {
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
      }
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
    db.exec("INSERT INTO feishu_invite_events SELECT region,tenant_key,app_id,'extra',occurrence_id,envelope_schema,event_type,create_time,provider_meeting_id,meeting_no,topic,start_seconds,end_seconds,invite_seconds,call_id,normalized_sha256,normalized_bytes,accepted_at_ms FROM feishu_invite_events LIMIT 1");
    assert.throws(read, /audit_count/);
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
      if (bad === "repeatLaunch") a.trace.push("occurrence_launched");
      if (bad === "wrongFailure") { const outcome = a.outcomes[0]; assert.ok(outcome); outcome.failure = "runtime_startup_timeout"; }
    }); assert.equal((await runIngressCampaign(f.plan, f.effects)).success, false);
  });
}
