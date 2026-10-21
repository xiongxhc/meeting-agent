// Fixture-only event statement abort; never substitutes the application's store.
import Database from "better-sqlite3";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { normalizeInvite } from "../dist/src/ports/feishu-ingress.js";
import { ingressData } from "./ingress-run.mjs";
export const INVITE_ABORT_TRIGGER = "e2e_invite_admission_abort";
export const INVITE_ABORT_SCHEMA_SHA256 = "21f1cdbb98349ef69c6cc995399472607101091c6da183555dbffc48b4897c18";
export const INVITE_ABORT_TABLES = Object.freeze(["feishu_invite_occurrences", "feishu_invite_events", "sessions", "bridge_leases", "physical_client_custody", "reconciliation_generations", "recordings", "bridge_failure_recordings", "recording_recovery_bindings", "unknown_end_custody", "backfill_seeds", "delivery_journal", "notification_intents"]);
const roots = new WeakMap();
const demand = (v, reason) => { if (!v) throw new Error(`invite_abort_${reason}`); };
const hash = v => createHash("sha256").update(v).digest("hex");
const identity = s => `${s.dev}:${s.ino}:${s.birthtimeNs}`;
const exists = p => { try { lstatSync(p); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } };
function rootStat(root) {
  demand(typeof root === "string" && path.isAbsolute(root) && realpathSync(root) === root && [realpathSync(tmpdir()), realpathSync("/private/tmp")].includes(path.dirname(root)), "fixture_root");
  const s = lstatSync(root, { bigint: true }); demand(s.isDirectory() && !s.isSymbolicLink() && s.uid === BigInt(process.getuid()) && (s.mode & 0o077n) === 0n, "fixture_root"); return identity(s);
}
// Only the command closure registers its freshly staged root. No JSON token.
export function registerInviteAbortFixture(root) { const token = Object.freeze({}); roots.set(token, { root, identity: rootStat(root) }); return token; }
function inspectBinding(root, databasePath, expectedRoot) {
  demand(rootStat(root) === expectedRoot, "identity");
  demand(typeof databasePath === "string" && databasePath === path.join(root, "state", "orchestration.db") && realpathSync(databasePath) === databasePath, "database_binding");
  const parents = [];
  for (let p = path.dirname(databasePath); ; p = path.dirname(p)) { const s = lstatSync(p, { bigint: true }); demand(s.isDirectory() && !s.isSymbolicLink() && s.uid === BigInt(process.getuid()) && (s.mode & 0o077n) === 0n, "private_parent"); parents.push(identity(s)); if (p === root) break; }
  const s = lstatSync(databasePath, { bigint: true }); demand(s.isFile() && !s.isSymbolicLink() && s.nlink === 1n && s.uid === BigInt(process.getuid()) && (s.mode & 0o022n) === 0n && s.size >= 100n && s.size <= 8388608n, "private_database");
  demand(!exists(databasePath + "-wal") && !exists(databasePath + "-shm"), "WAL"); return { database: identity(s), parents: parents.join("/") };
}
function schema(db) { const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name LIMIT 124").all(); demand(rows.length <= 123, "schema"); return rows; }
function migrations(db) { const rows = db.prepare("SELECT version,name,applied_at_ms FROM schema_migrations ORDER BY version LIMIT 32").all(); demand(rows.length === 31 && rows.every((r, i) => r.version === i + 1 && typeof r.name === "string" && Number.isSafeInteger(r.applied_at_ms) && r.applied_at_ms >= 0) && hash(JSON.stringify(rows.map(({ version, name }) => ({ version, name })))) === "a5e47c8a05f412df529d5764cff91030e3f58e4889457b1bb45ccdcda4f0878f", "schema29"); return JSON.stringify(rows); }
export function createInviteAdmissionAbortFault(input) {
  const keys = ["root", "databasePath", "appDatabasePath", "configDatabasePath", "freshRoot", "owner", "envelope", "scope"];
  demand(input && Object.getPrototypeOf(input) === Object.prototype && Reflect.ownKeys(input).length === keys.length && Reflect.ownKeys(input).every(k => typeof k === "string" && keys.includes(k)), "input");
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(input, key); demand(d && "value" in d && d.enumerable, "input"); }
  const { root, databasePath, appDatabasePath, configDatabasePath, freshRoot, owner } = input;
  const fresh = roots.get(freshRoot); demand(fresh?.root === root && fresh.identity === rootStat(root), "fresh_fixture");
  demand(databasePath === appDatabasePath && databasePath === configDatabasePath, "database_binding");
  demand(owner && typeof owner === "object", "owner"); const assertion = Object.getOwnPropertyDescriptor(owner, "assertCurrentOwnership"); demand(assertion && "value" in assertion && typeof assertion.value === "function", "owner");
  const current = () => assertion.value.call(owner);
  const envelope = ingressData(input.envelope), scope = ingressData(input.scope), target = normalizeInvite(envelope, scope);
  const fields = { region: target.region, tenant_key: target.tenantKey, app_id: target.appId, event_id: target.eventId, occurrence_id: target.occurrenceId, normalized_sha256: target.normalizedSha256 };
  const literal = v => { demand(typeof v === "string" && v.length > 0 && Buffer.byteLength(v) <= 4096 && !v.includes("\0"), "target"); return `CAST(X'${Buffer.from(v).toString("hex")}' AS TEXT)`; };
  const sql = `CREATE TRIGGER ${INVITE_ABORT_TRIGGER}\nAFTER INSERT ON feishu_invite_events\nWHEN ${Object.entries(fields).map(([k, v]) => `NEW.${k}=${literal(v)}`).join(" AND ")}\nBEGIN SELECT RAISE(ABORT,'e2e_invite_admission_abort'); END`;
  current(); const expected = inspectBinding(root, databasePath, fresh.identity); current();
  let phase = "absent", handles = 0, ordinal = 0, installed = null, cleared = null, invalid = false, baseline, migrationBaseline;
  const guard = () => { current(); const now = inspectBinding(root, databasePath, fresh.identity); demand(now.database === expected.database && now.parents === expected.parents, "identity"); return now; };
  function access(work, writable = false) {
    let fd, db;
    try {
      const before = guard(); fd = openSync(databasePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); const held = fstatSync(fd, { bigint: true }), header = Buffer.alloc(100);
      demand(identity(held) === before.database && readSync(fd, header, 0, 100, 0) === 100 && header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")) && header[18] === 1 && header[19] === 1, "header");
      guard(); db = new Database(databasePath, { fileMustExist: true, readonly: !writable, timeout: 0 }); handles = 1; guard(); demand(db.pragma("journal_mode", { simple: true }) !== "wal", "WAL");
      const task = () => { const m = migrations(db); if (migrationBaseline !== undefined) demand(m === migrationBaseline, "migration_identity"); const value = work(db, m); guard(); return value; };
      const value = writable ? db.transaction(task).immediate() : db.transaction(task)(); guard(); return value;
    } catch { invalid = true; phase = "refused"; throw new Error("invite_abort_controller_refused"); }
    finally { try { db?.close(); } finally { handles = 0; if (fd !== undefined) closeSync(fd); } }
  }
  function verify(db, armed) {
    const rows = schema(db), trigger = rows.find(r => r.name === INVITE_ABORT_TRIGGER);
    demand(armed ? trigger?.type === "trigger" && trigger.tbl_name === "feishu_invite_events" && trigger.sql === sql : !trigger, "exact_trigger");
    demand(JSON.stringify(rows.filter(r => r.name !== INVITE_ABORT_TRIGGER)) === baseline, "schema_restored");
  }
  access((db, m) => { const rows = schema(db); demand(hash(JSON.stringify(rows)) === INVITE_ABORT_SCHEMA_SHA256, "schema_pristine"); baseline = JSON.stringify(rows); migrationBaseline = m; for (const t of INVITE_ABORT_TABLES) demand(db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n === 0, "first_empty"); });
  const fact = () => Object.freeze({ phase, trigger: INVITE_ABORT_TRIGGER, templateSha256: phase === "absent" ? null : hash(sql), targetHash: target.normalizedSha256, ownerCurrent: !invalid, databaseBound: !invalid, schemaExact: !invalid, helperHandles: handles, installOrdinal: installed, clearOrdinal: cleared, invalid });
  return Object.freeze({ fact,
    inspect() { access(db => verify(db, phase === "installed")); return fact(); },
    assertTarget() { const n = normalizeInvite(envelope, scope); demand(JSON.stringify(n) === JSON.stringify(target), "target_changed"); guard(); return n.normalizedSha256; },
    install() { demand(phase === "absent" && installed === null && !invalid, "install_once"); access(db => { verify(db, false); for (const t of INVITE_ABORT_TABLES) demand(db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n === 0, "first_empty"); db.exec(sql); verify(db, true); }, true); phase = "installed"; installed = ++ordinal; access(db => verify(db, true)); return fact(); },
    clear() { demand(phase === "installed" && installed !== null && cleared === null && !invalid, "clear_once"); access(db => { verify(db, true); db.exec(`DROP TRIGGER ${INVITE_ABORT_TRIGGER}`); verify(db, false); }, true); phase = "cleared"; cleared = ++ordinal; access(db => verify(db, false)); return fact(); },
    failureCleanup() { if (phase === "installed" && !invalid) { this.clear(); return true; } return phase === "cleared" || phase === "absent"; },
  });
}
