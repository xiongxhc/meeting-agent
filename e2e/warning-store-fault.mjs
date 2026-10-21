// Test-only SQLite statement/acceptance-transaction abort, not COMMIT/fsync
// failure. Owns one exact trigger in an already-created disposable seed DB.
// Never constructs seeds/receipts or substitutes for the real store method.
import Database from "better-sqlite3";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { readKnownEndRecoveryState } from "./recovery-state.mjs";

export const WARNING_STORE_FAULT_TRIGGER = "e2e_warning_acceptance_abort";
const requireFact = (value, reason) => { if (!value) throw new Error(reason); };
const identity = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;

/** A persisted retry instant, not a newly computed deadline or claim expiry. */
export function warningSqlReplayBoundary({ state, plan }) {
  const warning = state.warning;
  requireFact(state.occurrenceId === plan.occurrenceId && state.stopAtMs === plan.stopAtMs &&
    state.expiresAtMs === plan.expiresAtMs && warning?.state === "pending" && warning.claimed === false &&
    warning.acceptedAtMs === null && warning.claimExpiresAtMs === null && warning.attemptCount === 1 &&
    Number.isSafeInteger(warning.nextAttemptAtMs) && warning.nextAttemptAtMs > state.stopAtMs &&
    warning.nextAttemptAtMs < state.expiresAtMs && warning.nextAttemptAtMs === plan.nextAttemptAtMs,
  "warning SQL replay binding or retry instant mismatch");
  return warning.nextAttemptAtMs;
}

function inspectBinding({ root, databasePath }) {
  requireFact(typeof root === "string" && typeof databasePath === "string" &&
    path.isAbsolute(root) && path.isAbsolute(databasePath) &&
    realpathSync(root) === root && realpathSync(databasePath) === databasePath,
  "warning fault requires canonical private database binding");
  const tempParents = [realpathSync(tmpdir()), realpathSync("/private/tmp")];
  requireFact(tempParents.includes(path.dirname(root)) && /^meeting-(?:e2e|warning-crash)-[A-Za-z0-9]{6}$/.test(path.basename(root)),
    "warning fault requires a disposable meeting root");
  const relative = path.relative(root, databasePath);
  requireFact(relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative) && typeof process.getuid === "function",
    "warning fault database is outside private root");
  const uid = BigInt(process.getuid()), rootStat = lstatSync(root, { bigint: true });
  for (let directory = path.dirname(databasePath); ; directory = path.dirname(directory)) {
    const stat = lstatSync(directory, { bigint: true });
    requireFact(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid && (stat.mode & 0o077n) === 0n,
      "warning fault requires owned private database parents");
    if (directory === root) break;
  }
  const stat = lstatSync(databasePath, { bigint: true });
  requireFact(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.uid === uid && (stat.mode & 0o022n) === 0n,
    "warning fault requires an owned regular database");
  requireFact(!existsSync(databasePath + "-wal") && !existsSync(databasePath + "-shm"),
    "warning fault requires a non-WAL database");
  return { root: identity(rootStat), database: identity(stat) };
}

function verifySeed(input) {
  const state = readKnownEndRecoveryState(input);
  requireFact(state.stopAtMs === input.stopAtMs && state.expiresAtMs === input.expiresAtMs &&
    state.source.retention === "retained" && state.lifecycle.state === "stopped" &&
    state.r1Preconditions.runtimeCleanupMarkerCleared && state.warning !== null &&
    ["pending", "claimed"].includes(state.warning.state), "warning fault target seed/deadlines mismatch");
}

function triggerSql(occurrenceId) {
  requireFact(typeof occurrenceId === "string" && occurrenceId.length > 0 && occurrenceId.length <= 8192 && !occurrenceId.includes("\0"),
    "invalid warning fault occurrence");
  // A hex-encoded SQLite text literal cannot terminate the SQL statement, even
  // when the real occurrence contains quotes. No identifier is caller supplied.
  const occurrence = `CAST(X'${Buffer.from(occurrenceId, "utf8").toString("hex")}' AS TEXT)`;
  return `CREATE TRIGGER ${WARNING_STORE_FAULT_TRIGGER}
AFTER UPDATE OF state ON backfill_warning_intents
WHEN OLD.occurrence_id=${occurrence} AND NEW.occurrence_id=${occurrence}
  AND OLD.state='claimed' AND NEW.state='accepted'
BEGIN SELECT RAISE(ABORT,'e2e_warning_accept_abort'); END`;
}

/** Caller owns the disposable root and must preserve it after interruption.
 * Identity checks do not promise atomic defence against hostile same-UID path
 * replacement. No helper repairs permissions, checkpoints WAL or unlinks DBs. */
export function installWarningStoreFault(input) {
  const binding = Object.freeze({ root: input.root, databasePath: input.databasePath,
    occurrenceId: input.occurrenceId, stopAtMs: input.stopAtMs, expiresAtMs: input.expiresAtMs });
  const expected = inspectBinding(binding), sql = triggerSql(binding.occurrenceId);
  verifySeed(binding);
  const templateSha256 = createHash("sha256").update(sql).digest("hex");
  function assertIdentity() {
    const current = inspectBinding(binding);
    requireFact(current.root === expected.root && current.database === expected.database,
      "warning fault database identity changed");
  }
  function mutate(work) {
    assertIdentity();
    const db = new Database(binding.databasePath, { fileMustExist: true });
    try {
      assertIdentity();
      requireFact(db.pragma("journal_mode", { simple: true }) !== "wal", "warning fault requires a non-WAL database");
      db.transaction(() => {
        requireFact(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version === 30,
          "unsupported warning fault schema");
        work(db);
        assertIdentity();
      }).immediate();
    } finally { db.close(); }
  }
  mutate(db => {
    requireFact(!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(WARNING_STORE_FAULT_TRIGGER),
      "conflicting warning fault trigger");
    db.exec(sql);
  });
  return Object.freeze({ triggerName: WARNING_STORE_FAULT_TRIGGER, templateSha256,
    clear() {
      mutate(db => {
        const trigger = db.prepare("SELECT type,tbl_name,sql FROM sqlite_master WHERE name=?").get(WARNING_STORE_FAULT_TRIGGER);
        requireFact(trigger?.type === "trigger" && trigger.tbl_name === "backfill_warning_intents" && trigger.sql === sql,
          "conflicting warning fault trigger");
        db.exec(`DROP TRIGGER ${WARNING_STORE_FAULT_TRIGGER}`);
      });
    },
  });
}
