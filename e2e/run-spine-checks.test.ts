import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
// @ts-expect-error Test-only harness module has no public declaration.
import { readStateRows, storeSpineChecks, shutdownCleanCheck } from "./run.mjs";

const OCCURRENCE = "meeting-1@2026-10-21T00:00:00Z";
const ORDER = ["shutdown_fenced", "shutdown_owned_work_settled", "shutdown_application_closed",
  "shutdown_runtime_owners_closed", "shutdown_transports_closed", "shutdown_store_closed"];

function withDatabase(schema: string, body: (db: Database.Database) => void): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), "run-spine-checks-"));
  const db = new Database(path.join(dir, "orchestration.db"));
  try { db.exec(schema); body(db); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

const FULL = `CREATE TABLE sessions (occurrence_id TEXT, state TEXT, terminal_reason TEXT);
CREATE TABLE backfill_seeds (occurrence_id TEXT, ended_at INTEGER);
CREATE TABLE physical_client_custody (physical_client_id TEXT, occurrence_id TEXT, state TEXT);
CREATE TABLE recording_alignment_pages (page_index INTEGER, entry_count INTEGER, payload BLOB);`;

const byName = (rows: { name: string; pass: boolean; detail: string }[]) => Object.fromEntries(rows.map((row) => [row.name, row]));

test("a state database missing the custody, seed and alignment tables fails those spine oracles", () => {
  withDatabase("CREATE TABLE sessions (occurrence_id TEXT, state TEXT, terminal_reason TEXT);", (db) => {
    const reopen = readStateRows(db);
    assert.ok(reopen.queryErrors.custody, "the failed custody query is recorded, not returned as a row");
    assert.deepEqual(reopen.rows.custody, []);
    const checks = byName(storeSpineChecks(reopen, OCCURRENCE));
    for (const name of ["custody_claimed", "finalized_seed", "alignment_stored"]) {
      assert.equal(checks[name]?.pass, false, name);
      assert.match(checks[name]!.detail, /query failed/, name);
    }
  });
});

test("the store spine oracles pass only on exactly the expected occurrence facts", () => {
  withDatabase(FULL, (db) => {
    db.prepare("INSERT INTO physical_client_custody VALUES ('client', ?, 'cleared')").run(OCCURRENCE);
    db.prepare("INSERT INTO backfill_seeds VALUES (?, 1)").run(OCCURRENCE);
    db.prepare("INSERT INTO recording_alignment_pages VALUES (0, 1, x'00')").run();
    let checks = byName(storeSpineChecks(readStateRows(db), OCCURRENCE));
    assert.deepEqual(Object.values(checks).map((row) => [row.name, row.pass]),
      [["custody_claimed", true], ["finalized_seed", true], ["alignment_stored", true]]);
    // Custody must name this occurrence, be released, and be unique.
    checks = byName(storeSpineChecks(readStateRows(db), "other@2026-10-21T00:00:00Z"));
    assert.equal(checks.custody_claimed!.pass, false); assert.equal(checks.finalized_seed!.pass, false);
    db.exec("UPDATE physical_client_custody SET state = 'quarantined'");
    assert.equal(byName(storeSpineChecks(readStateRows(db), OCCURRENCE)).custody_claimed!.pass, false);
    db.exec("UPDATE physical_client_custody SET state = 'cleared'");
    db.prepare("INSERT INTO physical_client_custody VALUES ('client-2', ?, 'cleared')").run(OCCURRENCE);
    assert.equal(byName(storeSpineChecks(readStateRows(db), OCCURRENCE)).custody_claimed!.pass, false);
    db.exec("DELETE FROM physical_client_custody WHERE physical_client_id = 'client-2'; DELETE FROM recording_alignment_pages");
    assert.equal(byName(storeSpineChecks(readStateRows(db), OCCURRENCE)).alignment_stored!.pass, false);
    db.prepare("INSERT INTO backfill_seeds VALUES (?, 2)").run(OCCURRENCE);
    assert.equal(byName(storeSpineChecks(readStateRows(db), OCCURRENCE)).finalized_seed!.pass, false);
  });
});

test("shutdown_clean requires exit 0 and the exact shipped close order", () => {
  const trace = ["composition_store_opened", ...ORDER];
  assert.equal(shutdownCleanCheck({ code: 0, trace }).pass, true);
  assert.equal(shutdownCleanCheck({ code: 70, trace }).pass, false);
  assert.equal(shutdownCleanCheck({ code: 0, trace: ["shutdown_store_closed"] }).pass, false);
  const swapped = [...ORDER]; [swapped[3], swapped[5]] = [swapped[5]!, swapped[3]!];
  assert.equal(shutdownCleanCheck({ code: 0, trace: swapped }).pass, false);
  assert.equal(shutdownCleanCheck({ code: 0, trace: [...ORDER, "shutdown_store_closed"] }).pass, false);
  assert.equal(shutdownCleanCheck({ code: 0, trace: undefined }).pass, false);
});
