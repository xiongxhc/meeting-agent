import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import Database from "better-sqlite3";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { readPublicationReceipt } from "../src/adapters/receipt-inbox.ts";
import { createApplicationMaintenance } from "../src/application-maintenance.ts";
import { canonicalArtifactHash, canonicalArtifactJson, parseTeamMemMeetingArtifact } from "../src/contracts/teammem-meeting-v1.ts";
import { createOutboxWorker } from "../src/delivery/outbox-worker.ts";
import { occurrencePathSegment } from "../src/domain/occurrence-id.ts";
// @ts-expect-error Private ESM harness ports, not a published API.
import { createL6Channel, parseArguments, prepareL6Gate, runL6Publication, writeBundle } from "./run.mjs";
// @ts-expect-error Import the genuine entry's listener-free selected seams only.
import { answerL6Request, assertL6HeldReceiptAbsence, l6LaneStatus, l6ReadStore, serveL6Entry } from "./entry.mjs";
// @ts-expect-error Shared reviewed controller/projection.
import { receiptGateState } from "./l6-receipt-gate.mjs";
// @ts-expect-error Selected listener-free entry seam.
import * as entry from "./entry.mjs";
// @ts-expect-error Existing genuine external peer lifecycle without app startup.
import { withOwnedPeers } from "./r2-baseline.mjs";

const SEED = "1".repeat(40), CANDIDATE = "2".repeat(40);
test("parent completion before seed rejects outside the swallowing poll predicate", async () => {
  // The predecessor's real waitFor ignores parent completion; this fallback
  // retains that exact predecessor call and fails with seed timeout instead.
  const waitSeed = entry.waitForL6Seed ?? (({ wait, seedReady, budgetMs }: { wait: typeof entry.waitFor; seedReady: () => boolean; budgetMs: number }) => wait(seedReady, { budgetMs, name: "l6_seed" }));
  await assert.rejects(waitSeed({ wait: entry.waitFor, seedReady: () => false, done: () => true, budgetMs: 35 }), { message: "l6_parent_aborted" });
});
test("selected seed wait accepts only ready while parent completion wins a coincident ready", async () => {
  const calls: unknown[] = [];
  const wait = async (check: () => unknown, options: unknown) => { calls.push(options); return check(); };
  await entry.waitForL6Seed({ wait, seedReady: () => true, done: () => false, budgetMs: 600000 });
  assert.deepEqual(calls, [{ budgetMs: 600000, name: "l6_seed" }]);
  await assert.rejects(entry.waitForL6Seed({ wait, seedReady: () => true, done: () => true, budgetMs: 600000 }), /l6_parent_aborted/);
});
test("actual parent abort writer and entry pre-seed wiring settle without seed authority", async () => {
  const root = realpathSync(mkdtempSync("/private/tmp/meeting-l6-handshake-c-"));
  const parent = readFileSync(new URL("./run.mjs", import.meta.url), "utf8"), child = readFileSync(new URL("./entry.mjs", import.meta.url), "utf8");
  const pstart = parent.indexOf('    if (l6ReceiptGate) {\n      try { writeFileSync(path.join(staged.directories.control, "l6-abort")');
  const pend = parent.indexOf('\n  } finally {', pstart);
  const cstart = child.indexOf('await waitForL6Seed({ wait: driveWaitFor'), cend = child.indexOf('\n        const seed =', cstart);
  assert.ok(pstart > 0 && pend > pstart && cstart > 0 && cend > cstart);
  const abort = new Function("l6ReceiptGate", "writeFileSync", "path", "staged", "oracle", parent.slice(pstart,pend));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const waiting = new AsyncFunction("waitForL6Seed", "driveWaitFor", "controlFileExists", "plan", child.slice(cstart,cend));
  try {
    abort(false, writeFileSync, path, { directories: { control: root } }, () => { throw new Error("unselected sink must not run"); });
    assert.equal(existsSync(path.join(root, "l6-abort")), false);
    abort(true, writeFileSync, path, { directories: { control: root } }, () => { throw new Error("ordinary sink succeeded"); });
    assert.equal(readFileSync(path.join(root, "l6-abort"), "utf8"), "aborted");
    await assert.rejects(waiting(entry.waitForL6Seed, entry.waitFor, (name: string) => existsSync(path.join(root,name)), { budgets: { teammemMs: 1000 } }), /l6_parent_aborted/);
    assert.equal(existsSync(path.join(root, "l6-seed.json")), false); assert.equal(existsSync(path.join(root, "l6-request.json")), false);
    const reasons: unknown[] = [];
    abort(true, () => { throw new Error("private-sink-error"); }, path, { directories: { control: root } }, (...args: unknown[]) => reasons.push(args));
    assert.deepEqual(reasons, [["l6_abort_request", "fail", "selected parent abort request could not be written"]]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("pre-seed parent abort reaches retained ordinary signal/public-close before owned peer close", async () => {
  const source = readFileSync(new URL("./entry.mjs", import.meta.url), "utf8");
  const start = source.indexOf("else drive.then("), end = source.indexOf("\n\n  let exit;", start);
  assert.ok(start > 0 && end > start);
  // Execute the unchanged actual ordinary drive callback only. The injected
  // signal receiver models runStandalone's public close, not a native process.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const settle = new AsyncFunction("drive", "plan", "event", "process", `let driveFailure=null, shuttingDown=false; const settled=${source.slice(start+5,end)} await settled; return {driveFailure,shuttingDown};`);
  const order: string[] = []; let publicClosed = false;
  const application = { async close() { order.push("public_close"); publicClosed = true; } };
  const drive = entry.waitForL6Seed({ wait: entry.waitFor, seedReady: () => false, done: () => true, budgetMs: 1000 });
  const result = await withOwnedPeers({ peer: async () => ({ async close() { assert.equal(publicClosed, true); order.push("peer_close"); } }) }, async () => {
    let closed: Promise<void> | undefined;
    const value = await settle(drive, { l6ReceiptGate: true }, (name: string) => { order.push(name); },
      { pid: 1, kill(_pid: number, signal: string) { assert.equal(signal, "SIGTERM"); closed = application.close(); } });
    await closed; return value;
  });
  assert.deepEqual(result, { driveFailure: "l6_entry_prerequisite_failed", shuttingDown: true });
  assert.deepEqual(order, ["drive_failed", "shutdown_signalled", "public_close", "peer_close"]);
});
test("preparation retains exact original phase failure and safe secondary cleanup flag", () => {
  for (const failing of ["artifact", "preflight", "remote-head", "gate-arm", "seed-handoff"]) {
    const first = new Error("private-original-error"), seen: Array<{ phase: string; state: string; cleanupFailed: boolean }> = [], calls: string[] = [];
    const invoke = (phase: string, value?: unknown) => { calls.push(phase); if (phase === failing) throw first; return value; };
    const args = { artifact: { meeting: { organizer: {} } }, allowPush: true, seedPushed: true,
      preflight: () => invoke("preflight"), remoteHead: () => invoke("remote-head", SEED),
      arm: () => invoke("gate-arm", { close() { calls.push("close"); throw new Error("private-secondary-close"); } }),
      handoff: () => invoke("seed-handoff"), observe: (value: { phase: string; state: string; cleanupFailed: boolean }) => seen.push(value) };
    if (failing === "artifact") args.allowPush = false;
    if (failing === "artifact") assert.throws(() => prepareL6Gate(args), /l6_actual_publication_required/);
    else assert.throws(() => prepareL6Gate(args), error => error === first);
    assert.equal(seen.at(-1)!.phase, failing); assert.equal(seen.at(-1)!.state, "failed");
    assert.equal(seen.at(-1)!.cleanupFailed, failing === "seed-handoff");
    assert.equal(JSON.stringify(seen).includes("private-"), false);
    assert.equal(calls.includes("close"), failing === "seed-handoff");
  }
});
test("selected preparation preserves seed-before-arm-before-handoff and fixed phase projection", () => {
  const phases: unknown[] = [], calls: string[] = [], gate = { close() { throw new Error("must remain armed"); } };
  const result = prepareL6Gate({ artifact: { meeting: { organizer: {} } }, allowPush: true, seedPushed: true,
    preflight() { calls.push("preflight"); }, remoteHead() { calls.push("remote"); return SEED; },
    arm(seed: string) { assert.equal(seed, SEED); calls.push("arm"); return gate; },
    handoff(seed: string) { assert.equal(seed, SEED); calls.push("handoff"); }, observe: (v: unknown) => phases.push(v) });
  assert.strictEqual(result.gate, gate); assert.equal(result.seedCommit, SEED);
  assert.deepEqual(calls, ["preflight", "remote", "arm", "handoff"]);
  assert.deepEqual(phases.at(-1), { schema: "l6-preparation/v1", phase: "seed-handoff", state: "ready", code: null, cleanupFailed: false });
});
test("actual imported runner pre-arm wiring reports its exact guarded boundary", () => {
  const source = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
  const start = source.indexOf("const { gate } = prepareL6Gate("), end = source.indexOf("\n      const channel =", start);
  assert.ok(start > 0 && end > start);
  const execute = new Function("prepareL6Gate", "artifact", "pushAllowed", "teammem", "preflightR2Database", "staged", "plan", "remoteHead", "createReceiptGate", "writeFileSync", "path",
    `let deadlineAtMs, l6Preparation; ${source.slice(start,end)}; return {gate,l6Preparation};`);
  for (const bad of [false, true]) {
    const first = new Error("private-preflight-error"), calls: string[] = [];
    const invoke = () => execute(prepareL6Gate, { meeting: { organizer: {} } }, true, { steps: [{ name: "git_seed_push", exit: 0 }] },
      () => { calls.push("preflight"); if (bad) throw first; }, { root: "/public-component", directories: { stateRoot: "/public-component/state", control: "/public-component/control" } },
      { budgets: { teammemMs: 600000 } }, () => { calls.push("remote"); return SEED; },
      (input: { seedCommit: string; deadlineAtMs: number }) => { assert.equal(input.seedCommit, SEED); assert.ok(input.deadlineAtMs > Date.now()); calls.push("arm"); return {}; },
      (_p: string, value: string) => { assert.equal(JSON.parse(value).seedCommit, SEED); calls.push("handoff"); }, path);
    if (bad) { assert.throws(invoke, error => error === first); assert.deepEqual(calls, ["preflight"]); }
    else { assert.equal(invoke().l6Preparation.state, "ready"); assert.deepEqual(calls, ["preflight", "remote", "arm", "handoff"]); }
  }
});
test("selected bundle retains closed failure phase and ordinary bundle has no new field", () => {
  const root = realpathSync(mkdtempSync("/private/tmp/meeting-l6-report-c-"));
  const observation = { schema: "l6-preparation/v1", phase: "gate-arm", state: "failed", code: "l6_preparation_failed", cleanupFailed: false };
  const live = { artifact: null, l6: null, l6Preparation: observation, childState: null, teammemResult: null,
    proofs: { processCleanup: { cleanupConfirmed: false } }, events: [], summary: null };
  try {
    for (const selected of [true, false]) {
      writeBundle(root, { options: { out: root, ...(selected ? { l6ReceiptGate: true, r2Baseline: true } : {}) }, pins: {}, treeId: "public-component",
        staged: { root }, teammem: null, live });
      const report = JSON.parse(readFileSync(path.join(root, "bundle.json"), "utf8"));
      assert.equal(Object.hasOwn(report, "l6Preparation"), selected);
      if (selected) { assert.deepEqual(report.l6Preparation, observation); assert.equal(report.l6ReceiptGate, null); assert.equal(report.processCleanup.cleanupConfirmed, false); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("parent abort during a request refuses acknowledgment and completion cannot hide it", async () => {
  const root = realpathSync(mkdtempSync("/private/tmp/meeting-l6-abort-c-")); let abort = false, done = false, ticks = 0;
  try {
    writeFileSync(path.join(root, "l6-request.json"), JSON.stringify({ sequence: 1, op: "poll", names: ["notification"], remoteHead: SEED }));
    const serving = serveL6Entry({ controlDir: root, deadlineAtMs: Date.now()+1000, done: () => done, aborted: () => abort,
      observe: () => { throw new Error("not an observe request"); }, tick: async () => { ticks++; abort = true; done = true; return "notification_polled"; },
      status: () => ({ codes: [], lanes: ["outbox", "notification"].map(lane => ({ lane, ticks: 1, inFlight: false, lastOutcome: "notification_polled", failures: [] })) }) });
    await assert.rejects(serving, /l6_parent_aborted/); assert.equal(ticks, 1);
    assert.equal(existsSync(path.join(root, "l6-response.json")), false);
    await assert.rejects(serveL6Entry({ controlDir: root, deadlineAtMs: Date.now()+1000, done: () => true, aborted: () => true }), /l6_parent_aborted/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("L6 selection is a fresh incomplete R2 route; ordinary arguments unchanged", () => {
  const ordinary = parseArguments(["--out", "/private/tmp/public-output"]);
  assert.equal(Object.hasOwn(ordinary, "l6ReceiptGate"), false);
  assert.equal(parseArguments(["--out", "/private/tmp/public-output", "--r2-baseline", "--l6-receipt-gate"]).l6ReceiptGate, true);
  assert.throws(() => parseArguments(["--out", "/private/tmp/public-output", "--l6-receipt-gate"]), /l6_selection_refused/);
  assert.throws(() => parseArguments(["--out", "/private/tmp/public-output", "--r2-baseline", "--l6-receipt-gate", "--l6-receipt-gate"]), /duplicate L6/);
  for (const extra of [["--interactive"], ["--interactive", "--d2-cut", "durable"], ["--only-refusals"], ["--media-timing", "invalid2ns"], ["--l4-case", "sent-conflict"]])
    assert.throws(() => parseArguments(["--out", "/private/tmp/public-output", "--r2-baseline", "--l6-receipt-gate", ...extra]));
});
test("notification budget cannot be reset or widened by an integration adapter", async () => {
  for (const notificationBudgetMs of [0, NaN, 120001]) await assert.rejects(runL6Publication({ notificationBudgetMs }), /l6_notification_budget_refused/);
});
test("canonical-reader null cannot hide a pre-release noncanonical receipt file", () => {
  const root = realpathSync(mkdtempSync("/private/tmp/meeting-l6-absent-c-"));
  try {
    assertL6HeldReceiptAbsence({ receiptsDir: root, remoteHead: SEED, seedCommit: SEED });
    writeFileSync(path.join(root, "unexpected.json"), "public invalid receipt bytes", { mode: 0o600 });
    assert.equal(readPublicationReceipt({ receiptsDir: root, occurrenceId: "public@2026-01-01T00:00:00Z", revision: 1, artifactHash: `sha256:${"0".repeat(64)}` }), null);
    assert.throws(() => assertL6HeldReceiptAbsence({ receiptsDir: root, remoteHead: SEED, seedCommit: SEED }), /l6_held_receipt_directory_refused/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function fixture() {
  const root = realpathSync(mkdtempSync("/private/tmp/meeting-l6-integration-c-")); chmodSync(root, 0o700);
  const recordingsDir = path.join(root, "recordings"), outboxDir = path.join(root, "outbox"), receiptsDir = path.join(root, "receipts");
  for (const dir of [recordingsDir, outboxDir, receiptsDir]) mkdirSync(dir, { mode: 0o700 });
  const bytes = Buffer.from("public synthetic encrypted component bytes");
  const raw = JSON.parse(readFileSync(new URL("../fixtures/contracts/teammem-meeting-v1.complete.json", import.meta.url), "utf8"));
  raw.revision = 1; raw.transcript_complete = false; raw.audio.bytes = bytes.length;
  raw.audio.sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const artifact = parseTeamMemMeetingArtifact(raw), artifactHash = canonicalArtifactHash(artifact);
  let now = Date.parse(artifact.ended_at) + 1, remoteHead = SEED;
  const recordingPath = path.join(recordingsDir, `${"c".repeat(32)}.crsr`); writeFileSync(recordingPath, bytes);
  const databasePath = path.join(root, "state.db"), store = openSessionStore({ filename: databasePath, nowMs: now });
  store.createSession({ occurrenceId: artifact.occurrence_id, providerMeetingId: artifact.provider_meeting_id, occurrenceStartedAt: artifact.started_at, nowMs: now });
  store.finalizeSession({ transition: { occurrenceId: artifact.occurrence_id, fromState: "discovered", toState: "awaiting_teammem", reason: "component", terminalReason: null, nowMs: now },
    recording: { handle: "c".repeat(32), encryptedPath: recordingPath, sha256: raw.audio.sha256.slice(7), durationMs: 420000, format: "opus", keyId: "public-test", gaps: [], runtimeGaps: [] } });
  const journal = createOutboxWorker({ recordingsDir, outboxDir, receiptsDir, journal: store, clock: { now: () => now }, random: () => 0,
    session: { state: id => store.getSession(id)?.state ?? null, publish() { throw new Error("unused authority"); } }, reconciliationEvidence: store });
  journal.enqueue({ artifact, serializedArtifact: canonicalArtifactJson(artifact), artifactHash, recordingPath });
  const messages: Array<{ receiveId: string; text: string; uuid: string }> = [];
  const maintenance = createApplicationMaintenance({ store, clock: { now: () => now }, dataPaths: { recordingsDir, outboxDir, receiptsDir, teamVaultDir: path.join(root, "vault") },
    runtime: { launcherPath: path.join(root, "unused-launcher"), gatewayConfigPath: path.join(root, "unused.toml") }, env: {},
    supervisor: { assertOwnership() {}, occurrenceIsLive: () => false, holdsFinalizedRecording: () => false, anyOccurrenceLive: () => false }, discover: async () => undefined,
    notificationSender: { async sendText(input) { messages.push(input); return { messageId: `om_e2e_${messages.length}` }; } }, options: { random: () => 0 } });
  // Actual migrated store/public worker; only this C clock/sender/receipt/remote
  // fixture is synthetic. Neither maintenance.start nor an app/SDK is run.
  const readonly = new Database(databasePath, { readonly: true, fileMustExist: true }), reader = l6ReadStore(readonly);
  const binding = { occurrenceId: artifact.occurrence_id, artifactHash, creatorId: artifact.organizer!.person_id, title: artifact.title, seedCommit: SEED };
  const observe = (head = remoteHead) => readonly.transaction(() => receiptGateState({ store: reader, ...binding,
    receipt: readPublicationReceipt({ receiptsDir, occurrenceId: artifact.occurrence_id, revision: 1, artifactHash }), remoteHead: head, messages, nowMs: now }))();
  let sequence = 0, status = l6LaneStatus(maintenance.status());
  const ticked: string[][] = [];
  const channel = { status: () => status, limit() {}, async request(op: string, names: string[] = []) {
    // Selected actual adapter never advances time; finite component clock only.
    now = Math.max(now, store.pending()[0]!.nextRetryAtMs);
    const response = await answerL6Request({ request: { sequence: ++sequence, op, names, remoteHead }, previous: sequence - 1, deadlineAtMs: Date.now() + 5000,
      observe, tick: (name: "outbox" | "notification") => maintenance.tick(name), status: () => maintenance.status() });
    ticked.push(names); status = response.status; return response;
  } };
  const receipt = { schema: "teammem-meeting-receipt/v1", occurrence_id: artifact.occurrence_id, revision: 1, artifact_hash: artifactHash,
    status: "published", vault_commit: CANDIDATE, markdown_path: "Meetings/public.md", markdown_url: `https://fixture.invalid/vault/-/blob/${CANDIDATE}/Meetings/public.md` };
  function publishComponentReceipt() {
    writeFileSync(path.join(receiptsDir, `${occurrencePathSegment(artifact.occurrence_id as `${string}@${string}`)}.json`), `${JSON.stringify(Object.fromEntries(Object.entries(receipt).sort()))}\n`, { mode: 0o600 }); remoteHead = CANDIDATE;
  }
  let released = false, closed = false, complete = false, releaseResult!: (value: unknown) => void;
  const result = new Promise(resolve => { releaseResult = resolve; });
  const gate = { deadlineAtMs: Date.now() + 5000, waitEntered: async () => true, snapshot: () => ({ released, accepted: released, candidateCommit: CANDIDATE, closed }),
    release() { assert.equal(released, false); released = true; complete = true; releaseResult({ dryRun: { exit: 0 }, publishRun: { exit: 0 } }); }, close() { closed = true; } };
  const publisher = { result, pending: () => !complete, childrenSettled: () => true, async close() {} };
  return { root, store, maintenance, reader, readonly, observe, channel, gate, publisher, ticked, messages, publishComponentReceipt,
    async close() { await maintenance.close(); readonly.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("same imported runner/entry gate proves held real polls then one durable C send", async () => {
  const f = fixture();
  try {
    assert.equal(f.observe().messageCount, 0);
    const result = await runL6Publication({ ...f, notificationBudgetMs: 1000, settleDescendants: async () => true,
      verifyRemote: async () => { f.publishComponentReceipt(); return { commitExists: true, commitIsAncestorOfRef: true, noteMatchesArtifact: true, receiptCanonical: true }; } });
    assert.equal(result.failure, null); assert.equal(result.cleanup, true); assert.equal(result.report.exactlyOneSend, true);
    assert.equal(f.messages.length, 1); assert.equal(f.store.getSession(f.store.pending()[0]!.occurrenceId)?.state, "notified");
    assert.deepEqual(f.ticked.filter(names => names.length).slice(0, 2), [["notification"], ["notification", "outbox"]]);
    assert.equal(result.report.history.filter((row: { receiptPresent: boolean }) => !row.receiptPresent).length >= 4, true);
    assert.equal(JSON.stringify(result).includes("claimToken"), false);
  } finally { await f.close(); }
});
test("direct consumer completion cannot replace actual descendant cleanup", async () => {
  const f = fixture();
  try {
    const result = await runL6Publication({ ...f, notificationBudgetMs: 1000, settleDescendants: async () => false,
      verifyRemote: async () => { f.publishComponentReceipt(); return { commitExists: true, commitIsAncestorOfRef: true, noteMatchesArtifact: true, receiptCanonical: true }; } });
    assert.equal(result.failure, "l6_descendant_cleanup_unconfirmed"); assert.equal(result.cleanup, false);
    assert.equal(result.report.exactlyOneSend, true); // Preserve earned send; fail custody separately.
  } finally { await f.close(); }
});
test("no-op entry tick acknowledgment cannot release push or mint notification", async () => {
  const f = fixture();
  try {
    const bad = { ...f.channel, async request(op: string, names: string[] = []) {
      if (op === "poll") return { outcomes: names.map(name => name === "outbox" ? "outbox_reconciled" : "notification_polled") };
      return f.channel.request(op, names);
    } };
    const result = await runL6Publication({ ...f, channel: bad, notificationBudgetMs: 1000, settleDescendants: async () => true, verifyRemote: async () => { throw new Error("private value"); } });
    assert.equal(result.failure, "l6_publication_prerequisite_failed"); assert.equal(f.gate.snapshot().released, false);
    assert.equal(f.messages.length, 0); assert.equal(f.store.notifications().length, 0); assert.equal(JSON.stringify(result).includes("private value"), false);
  } finally { await f.close(); }
});

test("entry executes the two public lanes concurrently and acknowledges settled status", async () => {
  const f = fixture();
  try {
    let started = 0, both!: () => void;
    const barrier = new Promise<void>(resolve => { both = resolve; });
    const response = await answerL6Request({ request: { sequence: 1, op: "poll", names: ["outbox", "notification"], remoteHead: SEED }, previous: 0, deadlineAtMs: Date.now() + 1000,
      observe: f.observe, status: () => f.maintenance.status(), tick: async (name: "outbox" | "notification") => {
        if (++started === 2) both();
        await Promise.race([barrier, pause(100).then(() => { throw new Error("concurrent_lanes_missing"); })]);
        return f.maintenance.tick(name);
      } });
    assert.deepEqual(response.outcomes, ["outbox_reconciled", "notification_polled"]);
    assert.equal(response.status.lanes.every((row: { ticks: number; inFlight: boolean }) => row.ticks === 1 && !row.inFlight), true);
  } finally { await f.close(); }
});
for (const [name, patch] of Object.entries({ replay: { sequence: 0 }, gap: { sequence: 2 }, unknown: { op: "SQL" }, extra: { private: "secret" }, duplicate: { names: ["outbox", "outbox"] }, unsafe: { names: ["backfill"] }, badHead: { remoteHead: "private-value" } }))
  test(`entry rejects ${name} request before calling any port`, async () => {
    let called = false;
    await assert.rejects(answerL6Request({ request: { sequence: 1, op: "poll", names: ["notification"], remoteHead: SEED, ...patch }, previous: 0,
      deadlineAtMs: Date.now() + 1000, tick: () => { called = true; return "notification_polled"; },
      status: () => { called = true; return { codes: [], lanes: ["outbox", "notification"].map(lane => ({ lane, ticks: 1, failures: [], inFlight: false, lastOutcome: "notification_polled" })) }; },
      observe: () => { called = true; return {}; } }), /l6_request_refused/);
    assert.equal(called, false);
  });
test("entry refuses accessors before reading request fields and refuses a writer store", async () => {
  let invoked = false;
  const request = { sequence: 1, op: "observe", names: [], remoteHead: SEED };
  Object.defineProperty(request, "sequence", { enumerable: true, get() { invoked = true; throw new Error("private raw value"); } });
  await assert.rejects(answerL6Request({ request, previous: 0, deadlineAtMs: Date.now() + 1000 }), /l6_request_refused/);
  assert.equal(invoked, false);
  assert.throws(() => l6ReadStore({ readonly: false }), /l6_readonly_store_required/);
});
test("bounded real file channel uses genuine entry ACK and refuses stale completion", async () => {
  const root = realpathSync(mkdtempSync("/private/tmp/meeting-l6-channel-c-"));
  let done = false;
  const status = () => ({ codes: [], lanes: ["outbox", "notification"].map(lane => ({ lane, ticks: 0, inFlight: false, lastOutcome: null, failures: [] })) });
  try {
    const serving = serveL6Entry({ controlDir: root, deadlineAtMs: Date.now() + 1000, done: () => done, status, observe: () => ({ safe: true }), tick: async () => "notification_polled" });
    const channel = createL6Channel({ controlDir: root, deadlineAtMs: Date.now() + 500, remoteHead: () => SEED, entryFailed: () => false });
    const first = await channel.request("observe"); assert.deepEqual(first.state, { safe: true });
    done = true; await serving;
    channel.limit(Date.now() + 35);
    await assert.rejects(channel.request("observe"), /l6_channel_deadline/);
    assert.equal(existsSync(path.join(root, "l6-request.json")), true);
  } finally { done = true; rmSync(root, { recursive: true, force: true }); }
});
