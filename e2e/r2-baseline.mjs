// R2 rev1 preparation only. Observed facts cannot confer application authority.
import Database from "better-sqlite3";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { closeSync, constants, createReadStream, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import path from "node:path";
import { initialRuntimeSettled } from "./recovery-run.mjs";
import { readKnownEndRecoveryState } from "./recovery-state.mjs";

function requireFact(value, reason) { if (!value) throw new Error(reason); }
export function assertR2Plan(plan) {
  requireFact(!plan.r2Baseline || !(plan.interactive || plan.initialR1 || plan.d2Cut || plan.onlyRefusals || plan.packageRefusals), "R2 baseline cannot combine modes");
}
export function r2LaneIntervals(intervals) { return { ...intervals, backfill: 3_600_000 }; }
function cleanMaintenance(status) {
  const lane = status?.lanes?.find(row => row.lane === "backfill");
  return status?.codes?.length === 0 && lane?.intervalMs === 3_600_000 && lane.ticks === 1 && !lane.inFlight &&
    lane.lastOutcome === "backfill_enqueued" && lane.failures?.length === 0;
}
export async function runR2InitialBuild({ getComposition, occurrenceId, waitFor, budgetMs, event }) {
  const row = await waitFor(() => getComposition()?.occurrenceOutcomes().find(outcome =>
    outcome.occurrenceId === occurrenceId && initialRuntimeSettled(outcome)), { budgetMs, name: "r2_live_cleanup_confirmed" });
  requireFact(row?.occurrenceId === occurrenceId && initialRuntimeSettled(row), "r2_live_cleanup_unconfirmed");
  event("r2_live_cleanup_confirmed", { occurrenceId });
  const app = getComposition();
  const outcome = await app.maintenanceTick("backfill"), maintenance = app.maintenanceStatus();
  requireFact(outcome === "backfill_enqueued" && cleanMaintenance(maintenance), "r2_initial_worker_outcome_refused");
  event("r2_initial_enqueued", { occurrenceId, outcome });
  return maintenance;
}
/** Registration precedes the next startup. Work must await app shutdown before
 * returning; every registered close is attempted even after a refusal. */
export async function withOwnedPeers(starters, work) {
  const peers = {}; let failure, value;
  try {
    for (const [name, start] of Object.entries(starters)) peers[name] = await start();
    value = await work(peers);
  } catch (error) { failure = error; }
  const results = await Promise.allSettled(Object.values(peers).reverse().filter(Boolean).map(peer => Promise.resolve().then(() => peer.close())));
  if (results.some(result => result.status === "rejected")) {
    if (failure) throw new AggregateError([failure], "owned_peer_close_unconfirmed_after_failure");
    throw new Error("owned_peer_close_unconfirmed");
  }
  if (failure) throw failure;
  return value;
}
/** Inspect the SQLite file header before SQLite can create WAL sidecars. */
export function preflightR2Database(databasePath) {
  requireFact(typeof databasePath === "string" && path.isAbsolute(databasePath), "invalid R2 database path");
  requireFact(!existsSync(`${databasePath}-wal`) && !existsSync(`${databasePath}-shm`), "R2 reader requires a non-WAL snapshot");
  const before = lstatSync(databasePath, { bigint: true });
  requireFact(before.isFile(), "invalid R2 database file");
  const fd = openSync(databasePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = fstatSync(fd, { bigint: true }), header = Buffer.alloc(100);
    requireFact(actual.isFile() && actual.dev === before.dev && actual.ino === before.ino && actual.size === before.size,
      "R2 database identity changed");
    requireFact(readSync(fd, header, 0, header.length, 0) === 100 && header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")), "invalid R2 SQLite header");
    // SQLite header bytes18/19 are the write/read format versions:2 is WAL,
    // 1 is rollback journaling. Refuse unknown/mixed versions before opening.
    requireFact(header[18] === 1 && header[19] === 1, "R2 reader requires a non-WAL snapshot");
    const after = lstatSync(databasePath, { bigint: true });
    requireFact(after.isFile() && actual.dev === after.dev && actual.ino === after.ino && actual.size === after.size &&
      actual.mtimeNs === after.mtimeNs, "R2 database changed during preflight");
  } finally { closeSync(fd); }
  requireFact(!existsSync(`${databasePath}-wal`) && !existsSync(`${databasePath}-shm`), "R2 reader requires a non-WAL snapshot");
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    requireFact(db.readonly, "R2 database was not opened readonly");
    requireFact(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version === 30, "unsupported R2 schema");
  } finally { db.close(); }
}
export function readR2BaselineState({ databasePath, occurrenceId }) {
  // This existing bound reader verifies source/generation/session/deadlines and
  // lstat identity; its retained-source branch is shared, never its R1 deletion.
  preflightR2Database(databasePath);
  const base = readKnownEndRecoveryState({ databasePath, occurrenceId });
  preflightR2Database(databasePath);
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    requireFact(db.readonly && db.pragma("journal_mode", { simple: true }) !== "wal", "R2 reader requires a non-WAL snapshot");
    return db.transaction(() => {
      requireFact(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version === 30, "unsupported R2 schema");
      const counts = {};
      for (const [name, table] of Object.entries({ sessions: "sessions", seeds: "backfill_seeds", delivery: "delivery_journal", jobs: "backfill_jobs" }))
        counts[name] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
      const delivery = db.prepare(`SELECT revision,artifact_hash AS artifactHash,ended_at_ms AS endedAtMs,
        transcript_complete AS transcriptComplete,published_at_ms AS publishedAtMs,deleted_at_ms AS deletedAtMs,
        publication_url AS publicationUrl,vault_commit AS vaultCommit,
        recording_path=? AND recording_handle=? AS sourceBound
        FROM delivery_journal WHERE occurrence_id=? ORDER BY revision LIMIT 2`).all(base.source.path, base.source.handle, occurrenceId);
      const job = db.prepare(`SELECT state,attempt_count AS attemptCount,target_revision AS targetRevision,
        claim_token IS NOT NULL AS claimed,claim_expires_at_ms AS claimExpiresAtMs,
        completion_revision AS completionRevision,completion_artifact_hash AS completionArtifactHash,stop_at_ms AS stopAtMs
        FROM backfill_jobs WHERE occurrence_id=?`).get(occurrenceId);
      return { ...base, counts, delivery: delivery.length === 1 ? delivery[0] : null, job: job ?? null };
    })();
  } finally { db.close(); }
}
async function measureFile(filename) {
  const before = lstatSync(filename, { bigint: true });
  const directory = lstatSync(path.dirname(filename), { bigint: true });
  requireFact(directory.isDirectory(), "invalid R2 ciphertext directory");
  requireFact(before.isFile(), "R2 ciphertext must be a regular file");
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  const same = (a, b) => b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.nlink === b.nlink;
  try {
    requireFact(same(before, fstatSync(fd, { bigint: true })), "R2 ciphertext replaced before measurement");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filename, { fd, autoClose: false })) hash.update(chunk);
    const after = fstatSync(fd, { bigint: true });
    requireFact(same(before, after) && same(after, lstatSync(filename, { bigint: true })), "R2 ciphertext changed during measurement");
    const afterDirectory = lstatSync(path.dirname(filename), { bigint: true });
    requireFact(afterDirectory.isDirectory() && directory.dev === afterDirectory.dev && directory.ino === afterDirectory.ino, "R2 ciphertext directory changed");
    return { sha256: hash.digest("hex"), bytes: Number(after.size), device: after.dev.toString(), inode: after.ino.toString(), nlink: Number(after.nlink),
      directoryDevice: directory.dev.toString(), directoryInode: directory.ino.toString() };
  } finally { closeSync(fd); }
}
export async function measureR2Sources({ state, recordingsDir, audioStore, privateRoot }) {
  requireFact(typeof privateRoot === "string" && path.isAbsolute(privateRoot) && privateRoot !== path.parse(privateRoot).root, "invalid R2 private root");
  const ancestors = [];
  for (const scoped of [recordingsDir, audioStore]) {
    const relative = path.relative(privateRoot, scoped);
    requireFact(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "R2 ciphertext outside scoped private root");
    let current = privateRoot;
    for (const segment of ["", ...relative.split(path.sep)]) {
      current = path.join(current, segment);
      const stat = lstatSync(current, { bigint: true });
      requireFact(stat.isDirectory(), "R2 scoped ancestor is not a physical directory");
      ancestors.push({ path: current, device: stat.dev, inode: stat.ino });
    }
  }
  requireFact(path.dirname(state.source.path) === path.resolve(recordingsDir), "R2 source outside scoped recordings");
  const inventory = () => {
    const files = [], identities = [];
    function walk(filename) {
      const stat = lstatSync(filename, { bigint: true });
      requireFact(!stat.isSymbolicLink(), "R2 audio store contains a symlink");
      requireFact(stat.isDirectory() || stat.isFile(), "R2 audio store contains a special file");
      identities.push([filename, stat.dev, stat.ino, stat.size, stat.nlink, stat.mtimeNs].map(String).join("\0"));
      if (stat.isDirectory()) for (const name of readdirSync(filename).sort()) walk(path.join(filename, name));
      else files.push(filename);
    }
    walk(audioStore);
    return { files, identities };
  };
  const before = inventory(), imported = [];
  const source = await measureFile(state.source.path);
  for (const filename of before.files) imported.push(await measureFile(filename));
  requireFact(JSON.stringify(before.identities) === JSON.stringify(inventory().identities), "R2 ciphertext inventory changed during measurement");
  for (const ancestor of ancestors) {
    const stat = lstatSync(ancestor.path, { bigint: true });
    requireFact(stat.isDirectory() && stat.dev === ancestor.device && stat.ino === ancestor.inode, "R2 scoped ancestor changed during measurement");
  }
  return { ...source, imported, fileCount: imported.length, uniqueInodeCount: new Set(imported.map(row => `${row.device}:${row.inode}`)).size, inventoryStable: true };
}
export function r2BaselineOracles({ state, artifact, receipt, publishExit, providerCalls, unusedVoice, maintenance, sourceMeasurement }) {
  const rows = [], check = (name, condition) => rows.push({ name: `r2_${name}`, status: condition ? "pass" : "fail", detail: "observed incomplete rev1 baseline prerequisite" });
  const d = state?.delivery, j = state?.job, l = state?.lifecycle, s = state?.source;
  check("one_incomplete_delivery", Object.values(state?.counts ?? {}).length === 4 && Object.values(state.counts).every(n => n === 1) &&
    d?.revision === 1 && d.transcriptComplete === 0 && d.sourceBound === 1 && d.endedAtMs === state.endedAtMs &&
    artifact?.occurrenceId === state.occurrenceId && artifact.revision === 1 && artifact.hash === d.artifactHash &&
    artifact.actualHash === artifact.hash && artifact.meeting?.transcript_complete === false &&
    Date.parse(artifact.meeting.ended_at) === state.endedAtMs && artifact.files?.includes("READY"));
  check("initial_authority_retained", l?.owner === "delivery" && l.state === "pending" && l.initialBuildAttempts === 1 &&
    !l.buildClaimed && l.buildClaimExpiresAtMs === null && !l.cleanupClaimed && !l.processOwned && l.processCleanupState === null &&
    l.deletedAtMs === null && d?.deletedAtMs === null && j?.state === "due" && j.attemptCount === 0 &&
    j.targetRevision === null && j.claimed === 0 && j.claimExpiresAtMs === null && j.completionRevision === null &&
    j.completionArtifactHash === null && j.stopAtMs === state.stopAtMs && state.stopAtMs === state.endedAtMs + 11 * 86_400_000 &&
    state.expiresAtMs === state.endedAtMs + 14 * 86_400_000);
  const checks = receipt?.checks ?? [];
  check("published_incomplete_receipt", publishExit === 0 && receipt?.valid === true && receipt?.status === "present" && receipt.receipts?.length === 1 && checks.length === 1 &&
    checks.every(row => row.schema === "teammem-meeting-receipt/v1" && row.commitExists && row.commitIsAncestorOfRef &&
      row.noteBytes > 0 && row.occurrenceMatchesArtifact && row.revisionMatchesArtifact && row.artifactHashMatches &&
      row.noteNamesOccurrence && row.urlNamesCommit && row.noteWithholdsAudioPath && row.markdownUrl === d?.publicationUrl &&
      row.vaultCommit === d?.vaultCommit) && Number.isSafeInteger(d?.publishedAtMs));
  const calls = providerCalls ?? [];
  check("provider_outcomes", calls.some(row => row.route === "final" && row.outcome === "unavailable") &&
    calls.some(row => row.route === "synthesis" && row.outcome === "ok") &&
    calls.every(row => (row.route === "final" && row.outcome === "unavailable") || (row.route === "synthesis" && row.outcome === "ok") || (row.route === "health" && row.outcome === "ok")) &&
    unusedVoice?.calls?.length === 0 && unusedVoice.appended === 0 && unusedVoice.ready === false);
  check("one_settled_build", cleanMaintenance(maintenance));
  check("source_retained", s?.retention === "retained" && state.generationRetained && state.selectedAlignment?.state === "complete" &&
    sourceMeasurement?.sha256 === s.sha256 && sourceMeasurement.bytes === s.bytes && sourceMeasurement.device === s.device && sourceMeasurement.inode === s.inode &&
    sourceMeasurement.imported?.length === 2 && sourceMeasurement.imported.every(row => row.sha256 === s.sha256 && row.bytes === s.bytes && row.nlink === 2) &&
    new Set(sourceMeasurement.imported.map(row => `${row.device}:${row.inode}`)).size === 1 &&
    new Set(sourceMeasurement.imported.map(row => `${row.directoryDevice}:${row.directoryInode}`)).size === 1 &&
    sourceMeasurement.imported.every(row => row.device !== s.device || row.inode !== s.inode));
  return rows;
}
const pick = (value, names) => Object.fromEntries(names.filter(name => value && Object.hasOwn(value, name)).map(name => [name, value[name]]));
export function r2BaselineMetadata(input) {
  const { state, maintenance, sourceMeasurement, providerCalls, unusedVoice } = input;
  return {
    mode: "r2-baseline", ...pick(state, ["occurrenceId", "endedAtMs", "stopAtMs", "expiresAtMs", "generationRetained"]),
    counts: pick(state?.counts, ["sessions", "seeds", "delivery", "jobs"]),
    source: pick(state?.source, ["sourceSessionId", "bridgeSessionId", "generationId", "handle", "sha256", "bytes", "device", "inode", "retention"]),
    lifecycle: pick(state?.lifecycle, ["owner", "state", "initialBuildAttempts", "buildClaimed", "cleanupClaimed", "processOwned", "processCleanupState", "deletedAtMs"]),
    delivery: pick(state?.delivery, ["revision", "artifactHash", "endedAtMs", "transcriptComplete", "publishedAtMs", "deletedAtMs", "publicationUrl", "vaultCommit", "sourceBound"]),
    job: pick(state?.job, ["state", "attemptCount", "targetRevision", "claimed", "claimExpiresAtMs", "completionRevision", "completionArtifactHash", "stopAtMs"]),
    selectedAlignment: pick(state?.selectedAlignment, ["attemptId", "state", "coverageStatus"]),
    maintenance: { codes: maintenance?.codes ?? [], lanes: (maintenance?.lanes ?? []).filter(row => row.lane === "backfill")
      .map(row => pick(row, ["lane", "intervalMs", "ticks", "inFlight", "lastOutcome", "failures"])) },
    sourceMeasurement: { ...pick(sourceMeasurement, ["sha256", "bytes", "device", "inode", "nlink", "fileCount", "uniqueInodeCount", "inventoryStable"]), imported: (sourceMeasurement?.imported ?? []).map(row => pick(row, ["sha256", "bytes", "device", "inode", "nlink", "directoryDevice", "directoryInode"])) },
    providerCalls: (providerCalls ?? []).map(row => pick(row, ["ordinal", "route", "outcome", "requestBytes", "responseBytes"])),
    unusedVoice: { recordedCalls: unusedVoice?.calls?.length ?? null, ...pick(unusedVoice, ["appended", "ready"]), connectionCountObserved: false },
  };
}
