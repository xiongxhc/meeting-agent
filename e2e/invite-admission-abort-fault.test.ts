import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { normalizeInvite } from "../src/ports/feishu-ingress.ts";
import { createInviteDiscovery } from "../src/sessions/invite-discovery.ts";
const helperPath = path.resolve(import.meta.dirname, "invite-admission-abort-fault.mjs");
async function helper() { assert.ok(existsSync(helperPath), "the selected invite transaction-abort controller must exist"); return import(helperPath); }
export function componentFixture(quoted = false) {
  const root = realpathSync(mkdtempSync(path.join(realpathSync(tmpdir()), "meeting-abort-component-"))); chmodSync(root, 0o700);
  const stateRoot = path.join(root, "state"); mkdirSync(stateRoot, { mode: 0o700 });
  const databasePath = path.join(stateRoot, "orchestration.db"), scope = { region: "feishu" as const, tenantKey: "e2e-tenant", appId: "cli_0123456789abcdef" };
  const envelope = { schema: "2.0", header: { event_id: quoted ? "abort-'event" : "abort-original", event_type: "vc.bot.meeting_invited_v1", tenant_key: scope.tenantKey, app_id: scope.appId, create_time: "1700000000000" }, event: { meeting: { id: quoted ? "meeting-'quote" : "meeting-abort", meeting_no: "987654321", topic: "Original title's quote", start_time: "1700000000" }, invite_time: "1700000000", call_id: "e2e-call" } };
  const invite = normalizeInvite(envelope, scope); let current = true;
  const owner = { assertCurrentOwnership() { assert.ok(current, "component_owner_lost"); } };
  const open = () => openSessionStore({ filename: databasePath, migrationsDir: path.resolve(import.meta.dirname, "../migrations"), nowMs: 1700000000000 });
  return { root, databasePath, scope, envelope, invite, owner, loseOwner() { current = false; }, open, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}
export function rawProjection(databasePath: string) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 0 });
  try { return { occurrences: db.prepare("SELECT * FROM feishu_invite_occurrences ORDER BY occurrence_id").all(), events: db.prepare("SELECT * FROM feishu_invite_events ORDER BY event_id").all(), downstream: Object.fromEntries(["sessions", "bridge_leases", "physical_client_custody", "reconciliation_generations", "recordings", "bridge_failure_recordings", "recording_recovery_bindings", "unknown_end_custody", "backfill_seeds", "delivery_journal", "notification_intents"].map(t => [t, (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n])) }; }
  finally { db.close(); }
}
export async function controller(f: ReturnType<typeof componentFixture>) {
  const h = await helper(); return h.createInviteAdmissionAbortFault({ root: f.root, databasePath: f.databasePath, appDatabasePath: f.databasePath, configDatabasePath: f.databasePath, freshRoot: h.registerInviteAbortFixture(f.root), owner: f.owner, envelope: f.envelope, scope: f.scope });
}
test("actual event INSERT abort rolls back the first new occurrence and all thirteen tables", async () => {
  const f = componentFixture(), store = f.open();
  try { const fault = await controller(f), before = rawProjection(f.databasePath); fault.install(); assert.equal(fault.inspect().phase, "installed"); assert.equal(fault.fact().helperHandles, 0);
    assert.throws(() => store.acceptInvite(f.invite, 1700000000001), { code: "SQLITE_CONSTRAINT_TRIGGER", message: "e2e_invite_admission_abort" });
    assert.deepEqual(rawProjection(f.databasePath), before); assert.equal(store.getInviteOccurrence(f.invite.occurrenceId), null); assert.throws(() => fault.install());
  } finally { store.close(); f.cleanup(); }
});
test("explicit clear permits first acceptance, its allowlist refusal without any organizer lookup, and ordinary store reopen replay with full equality", async () => {
  const f = componentFixture(); let store = f.open();
  try { const fault = await controller(f); fault.install(); assert.throws(() => store.acceptInvite(f.invite, 1700000000001)); fault.clear(); assert.equal(store.acceptInvite(f.invite, 1700000000002), "accepted");
    // The composition's join decision right after the commit: an empty allowlist refuses on the row, no session.
    assert.equal(store.admitInviteJoin(f.invite.occurrenceId, 1700000000002, "inviter_not_allowed"), "inviter_not_allowed"); assert.equal(store.getSession(f.invite.occurrenceId), null);
    let lookups = 0; const discovery = createInviteDiscovery({ store, metadata: { async resolve() { lookups++; return { status: "blocked", reason: "reference_missing", retryable: false }; } }, now: () => 1700000000003 });
    assert.equal(await discovery.runOnce(), false); assert.equal(lookups, 0); assert.equal(await discovery.close(), true);
    assert.equal(store.getInviteOccurrence(f.invite.occurrenceId)?.lastBlockedReason, "inviter_not_allowed"); const before = rawProjection(f.databasePath); store.close(); store = f.open();
    assert.equal(store.acceptInvite(f.invite, 1700000001000), "replay"); assert.deepEqual(rawProjection(f.databasePath), before); assert.equal(fault.inspect().phase, "cleared"); assert.throws(() => fault.clear());
  } finally { store.close(); f.cleanup(); }
});
for (const variant of ["hash", "event", "occurrence", "quotes"] as const) test(`exact target isolation: ${variant}`, async () => {
  const f = componentFixture(variant === "quotes"), store = f.open();
  try { const fault = await controller(f); fault.install();
    if (variant === "quotes") assert.throws(() => store.acceptInvite(f.invite, 1700000000001), { message: "e2e_invite_admission_abort" });
    else { const e = structuredClone(f.envelope); if (variant === "hash") e.event.meeting.topic = "changed hash"; if (variant === "event") e.header.event_id = "other-event"; if (variant === "occurrence") { e.header.event_id = "other-event"; e.event.meeting.id = "other-meeting"; } assert.equal(store.acceptInvite(normalizeInvite(e, f.scope), 1700000000001), "accepted"); }
    fault.clear(); assert.equal(fault.inspect().phase, "cleared");
  } finally { store.close(); f.cleanup(); }
});
for (const variant of ["root_permissions", "database_permissions", "hardlink", "symlink", "wal", "shm", "schema", "migration", "populated", "conflict", "busy", "lost_owner"] as const) test(`authority refuses ${variant} without altering rows`, async () => {
  const f = componentFixture(), store = f.open(); let db: Database.Database | undefined;
  try { const h = await helper(), freshRoot = h.registerInviteAbortFixture(f.root); const input = { root: f.root, databasePath: f.databasePath, appDatabasePath: f.databasePath, configDatabasePath: f.databasePath, freshRoot, owner: f.owner, envelope: f.envelope, scope: f.scope };
    if (variant === "root_permissions") chmodSync(f.root, 0o755); if (variant === "database_permissions") chmodSync(f.databasePath, 0o666);
    if (variant === "hardlink") linkSync(f.databasePath, f.databasePath + ".link");
    if (variant === "symlink") { renameSync(f.databasePath, f.databasePath + ".original"); symlinkSync(f.databasePath + ".original", f.databasePath); }
    if (variant === "wal" || variant === "shm") writeFileSync(f.databasePath + "-" + variant, "", { mode: 0o600 });
    if (["schema", "migration", "conflict", "busy"].includes(variant)) { db = new Database(f.databasePath, { timeout: 0 }); if (variant === "schema") db.exec("CREATE TABLE unrelated (value TEXT)"); if (variant === "migration") db.exec("UPDATE schema_migrations SET name='wrong' WHERE version=29"); if (variant === "conflict") db.exec("CREATE TRIGGER e2e_invite_admission_abort AFTER INSERT ON sessions BEGIN SELECT 1; END"); }
    if (variant === "populated") store.acceptInvite(f.invite, 1700000000001); if (variant === "lost_owner") f.loseOwner();
    const before = rawProjection(f.databasePath); assert.throws(() => { const fault = h.createInviteAdmissionAbortFault(input); if (variant === "busy") db!.exec("BEGIN IMMEDIATE"); fault.install(); });
    if (variant === "busy") db!.exec("ROLLBACK"); assert.deepEqual(rawProjection(f.databasePath), before);
  } finally { db?.close(); store.close(); f.cleanup(); }
});
test("wrong app/config/root, absent owner, foreign fixture and getter refuse without evaluating getter", async () => {
  const f = componentFixture(), store = f.open();
  try { const h = await helper(), freshRoot = h.registerInviteAbortFixture(f.root), input = { root: f.root, databasePath: f.databasePath, appDatabasePath: f.databasePath, configDatabasePath: f.databasePath, freshRoot, owner: f.owner, envelope: f.envelope, scope: f.scope }; let reads = 0;
    for (const patch of [{ appDatabasePath: f.databasePath + "x" }, { configDatabasePath: f.databasePath + "x" }, { root: f.root + "/." }, { freshRoot: {} }, { owner: {} }]) assert.throws(() => h.createInviteAdmissionAbortFault({ ...input, ...patch }));
    const malicious = { ...input }; Object.defineProperty(malicious, "envelope", { get() { reads++; return f.envelope; } }); assert.throws(() => h.createInviteAdmissionAbortFault(malicious)); assert.equal(reads, 0);
  } finally { store.close(); f.cleanup(); }
});
for (const variant of ["replacement", "removed", "trigger_replaced", "owner_lost"] as const) test(`clear never force-drops after ${variant}`, async () => {
  const f = componentFixture(), store = f.open();
  try { const fault = await controller(f); fault.install();
    if (variant === "replacement") { renameSync(f.databasePath, f.databasePath + ".original"); const replacement = new Database(f.databasePath); replacement.exec("CREATE TABLE harmless (v TEXT)"); replacement.close(); }
    if (variant === "removed" || variant === "trigger_replaced") { const db = new Database(f.databasePath); db.exec("DROP TRIGGER e2e_invite_admission_abort"); if (variant === "trigger_replaced") db.exec("CREATE TRIGGER e2e_invite_admission_abort AFTER INSERT ON sessions BEGIN SELECT 2; END"); db.close(); }
    if (variant === "owner_lost") f.loseOwner(); assert.throws(() => fault.clear()); assert.equal(fault.fact().helperHandles, 0); assert.equal(fault.fact().phase, "refused");
    if (variant === "replacement") { unlinkSync(f.databasePath); renameSync(f.databasePath + ".original", f.databasePath); }
  } finally { store.close(); f.cleanup(); }
});
test("loss of component ownership after trigger creation rolls back installation and closes the auxiliary handle", async () => {
  const f = componentFixture(), store = f.open(); let calls = 0, armed = false;
  try { const h = await helper(); const fault = h.createInviteAdmissionAbortFault({ root: f.root, databasePath: f.databasePath, appDatabasePath: f.databasePath, configDatabasePath: f.databasePath, freshRoot: h.registerInviteAbortFixture(f.root), owner: { assertCurrentOwnership() { if (armed && ++calls === 4) throw new Error("lost"); } }, envelope: f.envelope, scope: f.scope }); armed = true; assert.throws(() => fault.install());
    const db = new Database(f.databasePath, { readonly: true }); try { assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='e2e_invite_admission_abort'").get(), undefined); } finally { db.close(); }
    assert.equal(fault.fact().helperHandles, 0); assert.equal(fault.fact().phase, "refused"); assert.equal(store.acceptInvite(f.invite, 1700000000001), "accepted");
  } finally { store.close(); f.cleanup(); }
});
