import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { readPublicationReceipt } from "../src/adapters/receipt-inbox.ts";
import { createApplicationMaintenance } from "../src/application-maintenance.ts";
import { canonicalArtifactHash, canonicalArtifactJson, parseTeamMemMeetingArtifact } from "../src/contracts/teammem-meeting-v1.ts";
import { createOutboxWorker } from "../src/delivery/outbox-worker.ts";
import { occurrencePathSegment } from "../src/domain/occurrence-id.ts";
import type { SessionStore } from "../src/ports/session-store.ts";
// @ts-expect-error The selected fixture is an ESM harness, not a library API.
import { createReceiptGate, createReceiptGateController, parseReceiptUpdate, receiptGateState, startOwnedPublication } from "./l6-receipt-gate.mjs";

const SEED = "d97ed468a40248261a4bf2642379aa435553ba8c", CANDIDATE = "2".repeat(40);
test("the real receive parser binds one candidate to the measured seeded branch", () => {
  assert.deepEqual(parseReceiptUpdate(Buffer.from(`${SEED} ${CANDIDATE} refs/heads/e2e\n`), SEED),
    { candidateCommit: CANDIDATE, refValidated: true, seedMatched: true });
});
for (const [name, input] of Object.entries({
  otherRef: `${SEED} ${CANDIDATE} refs/heads/main\n`,
  otherSeed: `${CANDIDATE} ${SEED} refs/heads/e2e\n`,
  duplicate: `${SEED} ${CANDIDATE} refs/heads/e2e\n`.repeat(2),
  deletion: `${SEED} ${"0".repeat(40)} refs/heads/e2e\n`,
  unchanged: `${SEED} ${SEED} refs/heads/e2e\n`,
  crlf: `${SEED} ${CANDIDATE} refs/heads/e2e\r\n`,
  oversized: "private-value".repeat(100),
})) test(`receive parser rejects ${name} without echoing arbitrary hook input`, () => {
  assert.throws(() => parseReceiptUpdate(Buffer.from(input), SEED), { message: "l6_receive_update_refused" });
});

const ENV = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TEMPLATE_DIR: "" };
function fixture(budgetMs = 5000) {
  const root = realpathSync(mkdtempSync("/private/tmp/meeting-l6-c-")); chmodSync(root, 0o700);
  const bare = path.join(root, "teammem", "vault-remote.git"), hooks = path.join(bare, "hooks");
  for (const dir of [hooks, path.join(bare, "objects"), path.join(bare, "refs", "heads")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Public synthetic loose seed object C; the candidate remains a fake SHA
  // unavailable in the main store, just as a real held quarantine may be.
  // Only owned FS writes/read-only Git: no Git init/commit/push or real receipt.
  writeFileSync(path.join(bare, "HEAD"), "ref: refs/heads/e2e\n");
  writeFileSync(path.join(bare, "config"), "[core]\nrepositoryformatversion = 0\nbare = true\n");
  writeFileSync(path.join(bare, "refs", "heads", "e2e"), `${SEED}\n`);
  const body = Buffer.from("tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor Public Fixture <public@fixture.invalid> 0 +0000\ncommitter Public Fixture <public@fixture.invalid> 0 +0000\n\npublic component seed\n");
  const object = Buffer.concat([Buffer.from(`commit ${body.length}\0`), body]);
  assert.equal(createHash("sha1").update(object).digest("hex"), SEED);
  const objectDirectory = path.join(bare, "objects", SEED.slice(0, 2)); mkdirSync(objectDirectory, { mode: 0o700 });
  writeFileSync(path.join(objectDirectory, SEED.slice(2)), deflateSync(object), { mode: 0o600 });
  const teammem = { binary: path.join(root, "consumer"), paths: { bare, envFile: path.join(root, "env") }, env: { ...ENV } };
  writeFileSync(teammem.paths.envFile, "PUBLIC_SYNTHETIC_ONLY=1\n", { mode: 0o600 });
  const args = { privateRoot: root, teammem, seedCommit: SEED, deadlineAtMs: Date.now() + budgetMs };
  return { root, bare, hooks, teammem, args, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function hookChild(h: ReturnType<typeof fixture>, bytes = `${SEED} ${CANDIDATE} refs/heads/e2e\n`) {
  const child = spawn(process.execPath, [path.join(h.hooks, "pre-receive")], { env: ENV, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", b => { stdout += String(b); }); child.stderr.on("data", b => { stderr += String(b); });
  const exited = new Promise<number | null>(resolve => child.once("close", resolve));
  child.stdin.end(bytes);
  return { child, exited, output: () => ({ stdout, stderr }), async close() { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await exited; } };
}
test("actual empty-template seeded bare layout provisions only its missing private hooks", () => {
  const h = fixture(); rmSync(h.hooks, { recursive: true });
  try {
    assert.equal(existsSync(h.hooks), false);
    const gate = createReceiptGate(h.args);
    assert.equal(lstatSync(h.hooks).mode & 0o777, 0o700);
    assert.equal(gate.snapshot().armed, true); assert.equal(gate.snapshot().entered, false);
    gate.close(); assert.equal(existsSync(path.join(h.hooks, "pre-receive")), false);
  } finally { h.cleanup(); }
});
test("no-hooks seeded layout runs the same genuine fixture hook and ordinary abort", async () => {
  const h = fixture(); rmSync(h.hooks, { recursive: true });
  const gate = createReceiptGate(h.args), child = hookChild(h);
  try {
    const entered = await gate.waitEntered(); assert.equal(entered.candidateCommit, CANDIDATE);
    gate.close(); assert.equal(await child.exited, 1);
    assert.equal(gate.snapshot().accepted, false); assert.deepEqual(child.output(), { stdout: "", stderr: "" });
  } finally { gate.close(); await child.close(); h.cleanup(); }
});
for (const fault of ["seed", "object", "nonbare", "parent-mode", "missing-parent"] as const)
  test(`missing hooks is not provisioned before trusted ${fault} preflight`, () => {
    const h = fixture(); rmSync(h.hooks, { recursive: true });
    try {
      if (fault === "seed") writeFileSync(path.join(h.bare, "refs/heads/e2e"), `${CANDIDATE}\n`);
      if (fault === "object") unlinkSync(path.join(h.bare, "objects", SEED.slice(0, 2), SEED.slice(2)));
      if (fault === "nonbare") writeFileSync(path.join(h.bare, "config"), "[core]\nbare = false\n");
      if (fault === "parent-mode") chmodSync(path.dirname(h.bare), 0o777);
      if (fault === "missing-parent") rmSync(h.bare, { recursive: true });
      assert.throws(() => createReceiptGate(h.args)); assert.equal(existsSync(h.hooks), false);
      assert.equal(existsSync(path.join(h.root, "teammem/receipt-gate")), false);
    } finally { h.cleanup(); }
  });
for (const fault of ["symlink", "file", "writable"] as const) test(`existing unsafe hooks ${fault} is refused unchanged`, () => {
  const h = fixture(); rmSync(h.hooks, { recursive: true });
  try {
    if (fault === "symlink") symlinkSync(path.join(h.bare, "objects"), h.hooks);
    else if (fault === "file") writeFileSync(h.hooks, "public-existing-file");
    else mkdirSync(h.hooks, { mode: 0o777 });
    if (fault === "writable") chmodSync(h.hooks, 0o777);
    assert.throws(() => createReceiptGate(h.args), /l6_scoped_directory_refused/);
    assert.equal(existsSync(path.join(h.root, "teammem/receipt-gate")), false);
    if (fault === "file") assert.equal(readFileSync(h.hooks, "utf8"), "public-existing-file");
    if (fault === "symlink") assert.equal(lstatSync(h.hooks).isSymbolicLink(), true);
  } finally { h.cleanup(); }
});
test("owned hooks identity and permissions remain bound after arming", () => {
  const h = fixture(), gate = createReceiptGate(h.args);
  try {
    chmodSync(h.hooks, 0o777); assert.throws(() => gate.snapshot(), /l6_directory_changed/);
    chmodSync(h.hooks, 0o700); gate.close();
  } finally { chmodSync(h.hooks, 0o700); gate.close(); h.cleanup(); }
});
function consumer(h: ReturnType<typeof fixture>, mode = "gate") {
  // Genuine finite Node fixture executable receives the same real-consumer argv
  // and env. It owns its hook child; no Git push, Python, network or SDK starts.
  writeFileSync(h.teammem.binary, `#!${process.execPath}\nimport { spawn } from 'node:child_process';\nimport { appendFileSync, writeFileSync } from 'node:fs';\nconst expectedEnv=${JSON.stringify(h.teammem.env)}; if(Object.entries(expectedEnv).some(([key,value])=>process.env[key]!==value)||process.env.E2E_L6_PUBLIC_AMBIENT_SENTINEL!==undefined)process.exit(4);\nconst args=process.argv.slice(2); appendFileSync(${JSON.stringify(path.join(h.root, "consumer-argv.jsonl"))},JSON.stringify(args)+'\\n',{mode:0o600});\nif(args.includes('--dry-run')) process.exit(${mode === "dry-fail" ? 2 : 0});\n${mode === "publish-fail" ? "process.exit(3);" : mode === "no-hook" ? "process.exit(0);" : mode === "hang" ? "setInterval(()=>{},100);" : `const child=spawn(process.execPath,[${JSON.stringify(path.join(h.hooks, "pre-receive"))}],{env:${JSON.stringify(ENV)},stdio:['pipe','ignore','ignore']});\nprocess.on('SIGTERM',()=>child.kill('SIGTERM'));\nchild.stdin.end('${SEED} ${CANDIDATE} refs/heads/e2e\\n');\nchild.on('close',code=>{if(code===0)writeFileSync(${JSON.stringify(path.join(h.root, "consumer-completed"))},'completed');process.exit(code===0?${mode === "late-fail" ? 3 : 0}:1);});`}
`, { mode: 0o700 });
  return h.teammem;
}
test("integration child registration is synchronous for each real fixture invocation", async () => {
  const h = fixture(); consumer(h, "no-hook");
  let registered = false;
  const pids: number[] = [];
  const owner = startOwnedPublication({ ...h.args, nowIso: new Date().toISOString(), allowPush: true, processGroup: true,
    register() { registered = true; }, onChild(child: ReturnType<typeof spawn>) { assert.equal(registered, true); assert.equal(typeof child.pid, "number"); pids.push(child.pid!); } });
  try { await owner.result; assert.equal(pids.length, 2); assert.equal(owner.childrenSettled(), true); }
  finally { await owner.close(); h.cleanup(); }
});
test("async per-child registration is refused and its real fixture child is closed", async () => {
  const h = fixture(); consumer(h, "no-hook");
  const owner = startOwnedPublication({ ...h.args, nowIso: new Date().toISOString(), allowPush: true,
    register() {}, onChild: async () => undefined });
  try { await assert.rejects(owner.result, /l6_child_registration_refused/); }
  finally { await owner.close(); assert.equal(owner.childrenSettled(), true); h.cleanup(); }
});
function component(h: ReturnType<typeof fixture>) {
  const recordingsDir = path.join(h.root, "recordings"), outboxDir = path.join(h.root, "outbox"), receiptsDir = path.join(h.root, "receipts");
  for (const dir of [recordingsDir, outboxDir, receiptsDir]) mkdirSync(dir, { mode: 0o700 });
  const bytes = Buffer.from("public synthetic encrypted bytes");
  const raw = JSON.parse(readFileSync(new URL("../fixtures/contracts/teammem-meeting-v1.complete.json", import.meta.url), "utf8"));
  raw.revision = 1; raw.transcript_complete = false; raw.audio.bytes = bytes.length;
  raw.audio.sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const artifact = parseTeamMemMeetingArtifact(raw), hash = canonicalArtifactHash(artifact);
  const recordingPath = path.join(recordingsDir, `${"c".repeat(32)}.crsr`); writeFileSync(recordingPath, bytes);
  let now = Date.parse(artifact.ended_at) + 1;
  const store = openSessionStore({ filename: path.join(h.root, "state.db"), nowMs: now });
  store.createSession({ occurrenceId: artifact.occurrence_id, providerMeetingId: artifact.provider_meeting_id, occurrenceStartedAt: artifact.started_at, nowMs: now });
  store.finalizeSession({ transition: { occurrenceId: artifact.occurrence_id, fromState: "discovered", toState: "awaiting_teammem", reason: "component", terminalReason: null, nowMs: now },
    recording: { handle: "c".repeat(32), encryptedPath: recordingPath, sha256: raw.audio.sha256.slice(7), durationMs: 420000, format: "opus", keyId: "public-test", gaps: [], runtimeGaps: [] } });
  const journal = createOutboxWorker({ recordingsDir, outboxDir, receiptsDir, journal: store, clock: { now: () => now }, random: () => 0,
    session: { state: id => store.getSession(id)?.state ?? null, publish() { throw new Error("not an authority seam"); } }, reconciliationEvidence: store });
  journal.enqueue({ artifact, serializedArtifact: canonicalArtifactJson(artifact), artifactHash: hash, recordingPath });
  const messages: Array<{ receiveId: string; text: string; uuid: string; messageId: string }> = [];
  const maintenance = createApplicationMaintenance({ store, clock: { now: () => now }, dataPaths: { recordingsDir, outboxDir, receiptsDir },
    runtime: { launcherPath: path.join(h.root, "unused-launcher"), gatewayConfigPath: path.join(h.root, "unused.toml") }, env: ENV,
    supervisor: { assertOwnership() {}, occurrenceIsLive: () => false, holdsFinalizedRecording: () => false }, discover: async () => undefined,
    notificationSender: { async sendText(input) { const messageId = `om_e2e_${messages.length + 1}`; messages.push({ receiveId: input.receiveId, text: input.text, uuid: input.uuid, messageId }); return { messageId }; } },
    options: { random: () => 0 },
  }); // No application/composition, SDK client, maintenance.start or backfill tick.
  let remoteHead = SEED;
  const observe = () => receiptGateState({ store, occurrenceId: artifact.occurrence_id, artifactHash: hash,
    creatorId: artifact.organizer!.person_id, title: artifact.title,
    receipt: readPublicationReceipt({ receiptsDir, occurrenceId: artifact.occurrence_id, revision: 1, artifactHash: hash }),
    remoteHead, seedCommit: SEED, messages, nowMs: now });
  function issueReceipt(commit = CANDIDATE, moveRemote = true) {
    // Canonical producer fixture C only. The actual adapter must get these bytes
    // from the real consumer after Git verification; it may not call this test.
    const receipt = { artifact_hash: hash, markdown_path: "Meetings/public.md", markdown_url: `https://public.invalid/vault/-/blob/${commit}/Meetings/public.md`,
      occurrence_id: artifact.occurrence_id, revision: 1, schema: "teammem-meeting-receipt/v1", status: "published", vault_commit: commit };
    writeFileSync(path.join(receiptsDir, `${occurrencePathSegment(artifact.occurrence_id as `${string}@${string}`)}.json`), `${JSON.stringify(receipt)}\n`, { mode: 0o600 }); if (moveRemote) remoteHead = commit;
  }
  return { store, maintenance, messages, observe, issueReceipt,
    advanceToDue() { now = store.pending()[0]!.nextRetryAtMs; },
    async close() { await maintenance.close(); store.close(); },
  };
}
function controller(h: ReturnType<typeof fixture>, c: ReturnType<typeof component>, mode = "gate", overrides: Record<string, unknown> = {}) {
  const gate = createReceiptGate(h.args);
  let registered = false;
  const publisher = startOwnedPublication({ privateRoot: h.root, teammem: consumer(h, mode), nowIso: "2026-09-02T15:00:00Z", allowPush: true,
    deadlineAtMs: h.args.deadlineAtMs, register(owner: unknown) { assert.ok(owner); assert.equal(existsSync(path.join(h.root, "consumer-argv.jsonl")), false); registered = true; } });
  assert.ok(registered);
  const ctl = createReceiptGateController({ gate, publisher, observe: c.observe, maintenanceTick: c.maintenance.tick,
    maintenanceStatus: c.maintenance.status, ...overrides });
  const verify = async () => { assert.ok(existsSync(path.join(h.root, "consumer-completed"))); c.issueReceipt(); c.advanceToDue();
    return { commitExists: true, commitIsAncestorOfRef: true, noteMatchesArtifact: true, receiptCanonical: true }; };
  return { gate, publisher, ctl, verify };
}

test("held genuine hook and completed real public lane passes precede release and exactly one sent intent", async () => {
  // Darwin can add its own runtime environment field. The actual contract is
  // all passed values unchanged and no inheritance of our ambient sentinel.
  process.env.E2E_L6_PUBLIC_AMBIENT_SENTINEL = "public-not-for-consumer";
  const h = fixture(), c = component(h), run = controller(h, c);
  try {
    assert.throws(() => run.gate.release({}), /l6_release_refused/);
    const permit = await run.ctl.hold();
    assert.equal(c.store.getSession(c.store.pending()[0]!.occurrenceId)?.state, "awaiting_teammem");
    assert.equal(c.store.notifications().length, 0); assert.equal(c.messages.length, 0);
    const result = await run.ctl.release(permit, run.verify);
    assert.ok(result.heldPollsCompleted && result.exactlyOneSend && result.repeatedPollStable);
    assert.equal(c.store.notifications()[0]!.attemptCount, 1); assert.equal(c.messages.length, 1);
    assert.deepEqual(readFileSync(path.join(h.root, "consumer-argv.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)), [
      ["--env-file", h.teammem.paths.envFile, "process-meetings", "--now", "2026-09-02T15:00:00Z", "--dry-run"],
      ["--env-file", h.teammem.paths.envFile, "process-meetings", "--now", "2026-09-02T15:00:00Z"],
    ]);
    assert.throws(() => run.gate.release(permit), /l6_release_refused/);
    assert.throws(() => createReceiptGate(h.args), /l6_duplicate_arm/);
    await run.ctl.close(); assert.ok(run.publisher.childrenSettled()); assert.equal(existsSync(path.join(h.hooks, "pre-receive")), false);
  } finally { await run.ctl.close(); await c.close(); h.cleanup(); delete process.env.E2E_L6_PUBLIC_AMBIENT_SENTINEL; }
});

for (const [name, mutate, code] of [
  ["receipt appears before remote release", (c: ReturnType<typeof component>) => c.issueReceipt(CANDIDATE, false), "l6_held_authority_refused"],
  ["a no-op reports a lane outcome without a settled tick", () => undefined, "l6_lane_ack_refused"],
] as const) test(name, async () => {
  const h = fixture(), c = component(h); mutate(c);
  const run = controller(h, c, "gate", name.startsWith("a no-op") ? { maintenanceTick: async (name: string) => name === "outbox" ? "outbox_reconciled" : "notification_polled" } : {});
  try { await assert.rejects(run.ctl.hold(), { message: code }); assert.equal(run.gate.snapshot().released, false); }
  finally { await run.ctl.close(); await c.close(); h.cleanup(); }
});

test("release before both held-phase polls is refused while notification is pending", async () => {
  const h = fixture(), c = component(h);
  let unblock!: () => void, entered!: () => void;
  const pending = new Promise<void>(resolve => { unblock = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const run = controller(h, c, "gate", { async maintenanceTick(name: "outbox" | "notification") { entered(); await pending; return c.maintenance.tick(name); } });
  try {
    const hold = run.ctl.hold(); await started;
    await assert.rejects(run.ctl.release({}, run.verify), /l6_release_refused/);
    assert.equal(run.gate.snapshot().released, false); unblock(); await hold;
  } finally { unblock(); await run.ctl.close(); await c.close(); h.cleanup(); }
});

for (const invalid of ["otherRef", "duplicate"] as const) test(`real hook child rejects ${invalid} and emits no stdin/environment`, async () => {
  const h = fixture(), gate = createReceiptGate(h.args);
  const input = invalid === "otherRef" ? `${SEED} ${CANDIDATE} refs/heads/private-secret\n` : `${SEED} ${CANDIDATE} refs/heads/e2e\n`.repeat(2);
  const child = hookChild(h, input);
  try { assert.equal(await child.exited, 1); assert.equal(gate.snapshot().entered, false); assert.deepEqual(child.output(), { stdout: "", stderr: "" }); }
  finally { await child.close(); gate.close(); h.cleanup(); }
});

test("finite hook timeout rejects held push and ordinary owner close leaves the refusal evidence", async () => {
  const h = fixture(200), gate = createReceiptGate(h.args), child = hookChild(h);
  try {
    await gate.waitEntered(); assert.equal(await child.exited, 1); assert.equal(gate.snapshot().released, false);
    assert.deepEqual(child.output(), { stdout: "", stderr: "" }); gate.close();
    assert.ok(existsSync(path.join(h.root, "teammem", "receipt-gate", "entered.json")));
    assert.ok(existsSync(path.join(h.root, "teammem", "receipt-gate", "abort.json")));
  } finally { await child.close(); gate.close(); h.cleanup(); }
});

test("close during a held push rejects it and settles the exact owned consumer child", async () => {
  const h = fixture(), c = component(h), run = controller(h, c);
  try { await run.gate.waitEntered(); await run.ctl.close(); await assert.rejects(run.publisher.result, /l6_publish_failed/); assert.ok(run.publisher.childrenSettled()); }
  finally { await run.ctl.close(); await c.close(); h.cleanup(); }
});
for (const mode of ["dry-fail", "publish-fail", "hang"]) test(`owned consumer ${mode} cannot confer success and is settled`, async () => {
  const h = fixture(mode === "hang" ? 250 : 5000); consumer(h, mode);
  const owner = startOwnedPublication({ privateRoot: h.root, teammem: h.teammem, nowIso: "2026-09-02T15:00:00Z", allowPush: true, deadlineAtMs: h.args.deadlineAtMs, register() {} });
  try { await assert.rejects(owner.result, new RegExp(mode === "dry-fail" ? "l6_dry_run_failed" : mode === "hang" ? "l6_publication_deadline" : "l6_publish_failed")); }
  finally { await owner.close(); assert.ok(owner.childrenSettled()); h.cleanup(); }
});
test("hook installation refuses a symlink or nonprivate root without overwriting an existing destination hook", () => {
  const h = fixture();
  try {
    chmodSync(h.root, 0o755); assert.throws(() => createReceiptGate(h.args), /l6_private_directory_refused/); chmodSync(h.root, 0o700);
    const alias = path.join(h.root, "alias"); symlinkSync(h.bare, alias);
    assert.throws(() => createReceiptGate({ ...h.args, teammem: { ...h.teammem, paths: { ...h.teammem.paths, bare: alias } } }), /l6_destination_refused/);
    const hook = path.join(h.hooks, "pre-receive"); writeFileSync(hook, "original-hook", { mode: 0o700 });
    assert.throws(() => createReceiptGate(h.args), /l6_duplicate_arm/); assert.equal(readFileSync(hook, "utf8"), "original-hook");
  } finally { h.cleanup(); }
});

test("a second real invocation cannot replace the genuine entered candidate", async () => {
  const h = fixture(), gate = createReceiptGate(h.args), first = hookChild(h);
  let second: ReturnType<typeof hookChild> | undefined;
  try {
    await gate.waitEntered(); second = hookChild(h, `${SEED} ${"3".repeat(40)} refs/heads/e2e\n`);
    assert.equal(await second.exited, 1); assert.equal(gate.snapshot().candidateCommit, CANDIDATE);
    assert.deepEqual(second.output(), { stdout: "", stderr: "" });
    gate.close(); assert.equal(await first.exited, 1);
  } finally { gate.close(); await first.close(); await second?.close(); h.cleanup(); }
});

test("an entered hook does not accept an unowned release permit", async () => {
  const h = fixture(), gate = createReceiptGate(h.args), child = hookChild(h);
  try {
    await gate.waitEntered(); assert.throws(() => gate.release({}), /l6_release_refused/);
    assert.equal(existsSync(path.join(h.root, "teammem", "receipt-gate", "release.json")), false);
  } finally { gate.close(); await child.close(); h.cleanup(); }
});

test("reader admits the complete owned atomic-link transition but refuses an unrelated hardlink", async () => {
  const h = fixture(), gate = createReceiptGate(h.args), child = hookChild(h);
  const marker = path.join(h.root, "teammem", "receipt-gate", "entered.json");
  try {
    await gate.waitEntered(); linkSync(marker, `${marker}.tmp`); assert.equal(gate.snapshot().entered, true); unlinkSync(`${marker}.tmp`);
    linkSync(marker, path.join(h.root, "unrelated-link")); assert.throws(() => gate.snapshot(), /l6_marker_refused/);
    unlinkSync(path.join(h.root, "unrelated-link")); assert.equal(gate.snapshot().entered, true);
  } finally { gate.close(); await child.close(); h.cleanup(); }
});

test("stale measured seed is refused before a fixture hook is installed", () => {
  const h = fixture();
  try {
    writeFileSync(path.join(h.bare, "refs", "heads", "e2e"), `${CANDIDATE}\n`);
    assert.throws(() => createReceiptGate(h.args), /l6_seed_destination_refused/);
    assert.equal(existsSync(path.join(h.hooks, "pre-receive")), false);
  } finally { h.cleanup(); }
});

test("a bare ref without its seeded commit object is refused before arming", () => {
  const h = fixture();
  try {
    unlinkSync(path.join(h.bare, "objects", SEED.slice(0, 2), SEED.slice(2)));
    assert.throws(() => createReceiptGate(h.args), /l6_seed_destination_refused/);
    assert.equal(existsSync(path.join(h.hooks, "pre-receive")), false);
  } finally { h.cleanup(); }
});

for (const fault of ["extra", "getter", "prototype", "value"] as const) test(`closed DTO refuses ${fault} without exposing raw observations`, async () => {
  const h = fixture(), c = component(h); let getterCalls = 0;
  const observe = () => {
    const state = c.observe();
    if (fault === "extra") return { ...state, rawMessage: "private-secret" };
    if (fault === "getter") Object.defineProperty(state, "state", { get() { getterCalls++; return "private-secret"; } });
    if (fault === "prototype") Object.setPrototypeOf(state, { rawMessage: "private-secret" });
    if (fault === "value") state.state = "private-secret";
    return state;
  };
  const run = controller(h, c, "gate", { observe });
  try {
    await assert.rejects(run.ctl.hold(), /l6_state_projection_refused/); assert.equal(getterCalls, 0);
    assert.deepEqual(run.ctl.evidence().history, []); assert.equal(run.gate.snapshot().released, false);
  } finally { await run.ctl.close(); await c.close(); h.cleanup(); }
});

test("synchronous consumer close failure still attempts external gate close and cannot report settled cleanup", async () => {
  const h = fixture(), c = component(h), run = controller(h, c), original = run.publisher.close.bind(run.publisher);
  try {
    await run.gate.waitEntered(); run.publisher.close = () => { throw new Error("private-secret"); };
    await assert.rejects(run.ctl.close(), { message: "l6_owned_cleanup_unconfirmed" });
    assert.equal(existsSync(path.join(h.hooks, "pre-receive")), false); assert.equal(run.gate.snapshot().closed, true);
  } finally { run.publisher.close = original; await run.ctl.close(); await c.close(); h.cleanup(); }
});

test("a successful consumer that never enters the external hook cannot earn held evidence", async () => {
  const h = fixture(), c = component(h), run = controller(h, c, "no-hook");
  try { await assert.rejects(run.ctl.hold(), /l6_consumer_completed_before_entered/); assert.equal(run.gate.snapshot().entered, false); assert.equal(run.ctl.evidence().heldComplete, false); }
  finally { await run.ctl.close(); await c.close(); h.cleanup(); }
});

test("consumer nonzero exit after actual hook release remains failure with retained held observations", async () => {
  const h = fixture(), c = component(h), run = controller(h, c, "late-fail"); let verified = false;
  try {
    const permit = await run.ctl.hold();
    await assert.rejects(run.ctl.release(permit, async () => { verified = true; return run.verify(); }), /l6_publish_failed/);
    assert.equal(verified, false); assert.equal(c.messages.length, 0); assert.equal(c.store.notifications().length, 0);
    assert.ok(run.ctl.evidence().history.length >= 3); assert.equal(run.gate.snapshot().accepted, true);
  } finally { await run.ctl.close(); await c.close(); h.cleanup(); }
});

test("canonical receipt for another commit cannot be substituted for the actual held candidate", async () => {
  const h = fixture(), c = component(h), run = controller(h, c);
  try {
    const permit = await run.ctl.hold();
    await assert.rejects(run.ctl.release(permit, async () => { c.issueReceipt("3".repeat(40)); c.advanceToDue(); return { commitExists: true, commitIsAncestorOfRef: true, noteMatchesArtifact: true, receiptCanonical: true }; }), /l6_receipt_candidate_refused/);
  } finally { await run.ctl.close(); await c.close(); h.cleanup(); }
});

test("an asynchronous owner registration is refused before any consumer startup", () => {
  const h = fixture(); consumer(h, "no-hook");
  try {
    assert.throws(() => startOwnedPublication({ privateRoot: h.root, teammem: h.teammem, nowIso: "2026-09-02T15:00:00Z", allowPush: true, deadlineAtMs: h.args.deadlineAtMs, register: async () => undefined }), /l6_registration_not_synchronous/);
    assert.equal(existsSync(path.join(h.root, "consumer-argv.jsonl")), false);
  } finally { h.cleanup(); }
});

for (const fault of ["artifact", "creator", "url", "uuid", "duplicate", "closed-cleanup"] as const) test(`shared oracle rejects ${fault} without leaking row/messages/claims`, async () => {
  const h = fixture(), c = component(h), run = controller(h, c);
  const closePublisher = run.publisher.close.bind(run.publisher);
  try {
    const permit = await run.ctl.hold();
    const verify = async () => {
      const result = await run.verify();
      if (fault === "url") return { ...result, receiptCanonical: false };
      await c.maintenance.tick("outbox"); await c.maintenance.tick("notification");
      if (fault === "creator") c.messages[0]!.receiveId = "wrong-creator";
      if (fault === "uuid") c.messages[0]!.uuid = "wrong-uuid";
      if (fault === "duplicate") c.messages.push({ ...c.messages[0]! });
      return result;
    };
    if (fault === "artifact") {
      // The shared DTO binds to the oracle's independently selected artifact.
      const store: SessionStore = c.store;
      const pending = store.pending.bind(store);
      store.pending = () => pending().map(row => ({ ...row, artifactHash: `sha256:${"f".repeat(64)}` }));
    }
    if (fault === "closed-cleanup") {
      await run.ctl.release(permit, run.verify);
      run.publisher.close = async () => { throw new Error("private-secret-not-exported"); };
      await assert.rejects(run.ctl.close(), { message: "l6_owned_cleanup_unconfirmed" });
      await run.publisher.result; run.gate.close();
    } else {
      await assert.rejects(run.ctl.release(permit, verify), new RegExp(fault === "url" ? "l6_remote_receipt_refused" : fault === "artifact" ? "l6_held_authority_refused" : "l6_notification_binding_refused"));
    }
    const safe = JSON.stringify(run.ctl.evidence());
    assert.ok(!safe.includes("private-secret") && !safe.includes("Meeting notes:") && !safe.includes("claimToken") && !safe.includes("recoveryArtifact"));
  } finally {
    run.publisher.close = closePublisher;
    await run.ctl.close(); await c.close(); h.cleanup();
  }
});
