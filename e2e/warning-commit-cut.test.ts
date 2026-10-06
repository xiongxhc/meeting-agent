import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";

// Component subprocess crash/replay proof only: actual migrated store/coordinator,
// warning worker and filesystem sink; explicitly synthetic recording/capability.
// No Runtime authentication, admission, listener or application R1 evidence.
const ENDED = 1_788_357_600_123, STOP = ENDED + 11 * 86_400_000, EXPIRY = ENDED + 14 * 86_400_000;
const helperPath = path.resolve(import.meta.dirname, "warning-commit-cut.mjs");
async function helpers() {
  assert.ok(existsSync(helperPath), "warning receipt barrier is not implemented");
  return import(helperPath);
}
// @ts-expect-error Component-only fixture has no public declarations.
import { createWarningComponentSeed as fixture } from "./fixtures/warning-component-seed.mjs";

type LeafMessage = { name: string; file: { name: string; sha256: string; device: string; inode: string; bytes: number };
  state: { warning: { claimExpiresAtMs: number } }; checkpoints: string[]; raw: unknown; poll: { kind: string }; idle: { kind: string } };
function rawWarning(f: ReturnType<typeof fixture>) {
  const db = new Database(f.databasePath, { readonly: true, fileMustExist: true });
  try { return db.prepare("SELECT state,accepted_at_ms AS acceptedAtMs,claim_expires_at_ms AS claimExpiresAtMs,attempt_count AS attempts,stop_at_ms AS stopAtMs,expires_at_ms AS expiresAtMs FROM backfill_warning_intents").get() as {
    state: string; acceptedAtMs: number | null; claimExpiresAtMs: number | null; attempts: number; stopAtMs: number; expiresAtMs: number;
  }; } finally { db.close(); }
}
function leaf(f: ReturnType<typeof fixture>, mode: string, extra = {}) {
  const outboxDir = path.join(f.root, "outbox");
  mkdirSync(outboxDir, { mode: 0o700, recursive: true });
  const planPath = path.join(f.root, `${mode}.json`);
  writeFileSync(planPath, JSON.stringify({ root: f.root, databasePath: f.databasePath, outboxDir,
    occurrenceId: f.occurrenceId, stopAtMs: STOP, expiresAtMs: EXPIRY, mode, ...extra }), { mode: 0o600 });
  // Reviewed leaf starts no descendants. Exact child object only, cwd pinned to
  // the fresh private fixture root and no inherited secrets or home environment.
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "fixtures/warning-commit-child.mjs"), "--plan", planPath],
    { cwd: f.root, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", TMPDIR: f.root }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const messages: LeafMessage[] = [];
  let stderr = "", outcome: { code: number | null; signal: string | null } | null = null;
  child.stderr!.on("data", bytes => { stderr += bytes; });
  child.on("message", message => { messages.push(message as LeafMessage); });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => { outcome = { code, signal }; resolve(outcome); });
  });
  void exited.catch(() => {});
  return { child, messages, exited, outboxDir, stderr: () => stderr, outcome: () => outcome };
}
async function bounded<T>(work: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("leaf timeout")), ms); })]); }
  finally { clearTimeout(timer); }
}
async function message(owner: ReturnType<typeof leaf>, name: string) {
  return bounded(new Promise<LeafMessage>((resolve, reject) => {
    const timer = setInterval(() => {
      const value = owner.messages.find(row => row.name === name);
      if (value) { clearInterval(timer); resolve(value); }
      else if (owner.outcome()) { clearInterval(timer); reject(new Error(`leaf exited: ${owner.stderr()}`)); }
    }, 5);
    setTimeout(() => { clearInterval(timer); reject(new Error("leaf readiness timeout")); }, 4500).unref();
  }));
}
async function reap(owner: ReturnType<typeof leaf> | undefined) {
  if (!owner) return;
  if (!owner.outcome()) owner.child.kill("SIGKILL");
  await bounded(owner.exited);
}

test("receipt barrier returns the identical real receipt only after parent release", async () => {
  const { createWarningReceiptBarrier } = await helpers();
  const receipt = { key: "real-key" }, seen: string[] = [];
  let allow!: () => void;
  const release = new Promise<void>(resolve => { allow = resolve; });
  const sink = createWarningReceiptBarrier({ sink: { async accept() { seen.push("sink"); return receipt; } },
    onDurableReceipt(input: unknown, value: unknown) { assert.ok(input); assert.equal(value, receipt); seen.push("durable"); },
    waitForRelease: () => release });
  let returned = false;
  const pending = sink.accept({ key: "real-key", payload: {} }).then((value: unknown) => { returned = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, ["sink", "durable"]); assert.equal(returned, false);
  allow(); assert.equal(await pending, receipt);
});

test("real sink failure cannot announce a durable receipt or wait for release", async () => {
  const { createWarningReceiptBarrier } = await helpers();
  const failure = new Error("sink failed"), seen: string[] = [];
  const sink = createWarningReceiptBarrier({ sink: { async accept() { throw failure; } },
    onDurableReceipt() { seen.push("announced"); }, waitForRelease() { seen.push("blocked"); } });
  await assert.rejects(sink.accept({}), error => error === failure); assert.deepEqual(seen, []);
});

for (const corrupt of [false, true]) test(`component subprocess crash/replay proof: ${corrupt ? "corrupted receipt file refuses acceptance and overwrite" : "SIGKILL keeps claim and exact same physical warning file"}`, async context => {
  const { measureWarningFile } = await helpers(), f = fixture();
  let cut: ReturnType<typeof leaf> | undefined, replay: ReturnType<typeof leaf> | undefined;
  try {
    cut = leaf(f, "cut");
    const ready = await message(cut, "durable_receipt_blocked");
    const before = rawWarning(f);
    assert.deepEqual(before, { state: "claimed", acceptedAtMs: null, claimExpiresAtMs: STOP + 30000, attempts: 1, stopAtMs: STOP, expiresAtMs: EXPIRY });
    assert.deepEqual(ready.state.warning.claimExpiresAtMs, before.claimExpiresAtMs);
    const file = measureWarningFile({ outboxDir: cut.outboxDir, occurrenceId: f.occurrenceId, stopAtMs: STOP, expiresAtMs: EXPIRY });
    assert.deepEqual(file, ready.file); assert.deepEqual(ready.checkpoints, ["file", "directory"]);
    const warningDir = path.join(cut.outboxDir, "operator-warnings"), filename = path.join(warningDir, file.name);
    const bytes = readFileSync(filename); assert.deepEqual(readdirSync(warningDir), [file.name]);
    assert.equal(cut.child.kill("SIGKILL"), true);
    assert.deepEqual(await bounded(cut.exited), { code: null, signal: "SIGKILL" });
    assert.deepEqual(rawWarning(f), before, "SIGKILL must not reschedule or accept the persisted claim");
    if (corrupt) writeFileSync(filename, "corrupted component file\n", { mode: 0o600 });
    const replayBytes = readFileSync(filename);
    replay = leaf(f, "replay", { claimExpiresAtMs: before.claimExpiresAtMs });
    assert.deepEqual(await bounded(replay.exited), { code: 0, signal: null }, replay.stderr());
    const idle = replay.messages.find(row => row.name === "unexpired_claim_idle")!;
    assert.equal(idle.poll.kind, "idle"); assert.deepEqual(idle.raw, before); assert.deepEqual(idle.checkpoints, []);
    const settled = replay.messages.find(row => row.name === "replay_settled")!;
    assert.equal(settled.poll.kind, corrupt ? "rescheduled" : "accepted");
    assert.deepEqual(settled.checkpoints, corrupt ? [] : ["directory"], "replay must use the existing-file path");
    const after = rawWarning(f); assert.equal(after.attempts, 2); assert.equal(after.stopAtMs, STOP); assert.equal(after.expiresAtMs, EXPIRY);
    assert.equal(after.acceptedAtMs, corrupt ? null : before.claimExpiresAtMs); assert.equal(after.claimExpiresAtMs, null);
    assert.deepEqual(readFileSync(filename), replayBytes); assert.deepEqual(readdirSync(warningDir), [file.name]);
    if (!corrupt) { assert.deepEqual(readFileSync(filename), bytes); assert.deepEqual(settled.file, file); assert.deepEqual(measureWarningFile({ outboxDir: cut.outboxDir, occurrenceId: f.occurrenceId, stopAtMs: STOP, expiresAtMs: EXPIRY }), file); assert.equal(settled.idle.kind, "idle"); }
    context.diagnostic(JSON.stringify({ label: "component subprocess crash/replay proof", corrupt,
      ownedPid: cut.child.pid, exit: cut.outcome(), before, after, beforeFile: file,
      ...(corrupt ? { corruptedBytesPreserved: true } : { afterFile: settled.file }), replayCheckpoints: settled.checkpoints }));
  } finally { await reap(replay); await reap(cut); f.close(); }
});

test("component real filesystem fsync failure never announces the receipt barrier", async () => {
  await helpers(); const f = fixture(); let child: ReturnType<typeof leaf> | undefined;
  try {
    child = leaf(f, "sink-failure"); assert.deepEqual(await bounded(child.exited), { code: 0, signal: null }, child.stderr());
    assert.equal(child.messages.some(row => row.name === "durable_receipt_blocked"), false);
    assert.equal(child.messages.find(row => row.name === "sink_failed")?.poll.kind, "rescheduled");
    assert.equal(rawWarning(f).acceptedAtMs, null); assert.equal(rawWarning(f).state, "pending");
    assert.deepEqual(readdirSync(path.join(child.outboxDir, "operator-warnings")), []);
  } finally { await reap(child); f.close(); }
});
