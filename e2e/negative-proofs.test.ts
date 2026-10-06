import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
// @ts-expect-error Test-only scanner has no public declaration.
import { keyPresent, negativeProofs } from "./negative-proofs.mjs";

test("security scanner refuses emitted key leaks, unsafe key permissions, plaintext PCM and missing environment evidence", () => {
  const root = mkdtempSync(path.join(tmpdir(), "meeting-security-test-"));
  chmodSync(root, 0o700);
  const directories = Object.fromEntries(["recordingsDir", "outboxDir", "receiptsDir", "control", "teammem", "runtimeKeyDir"].map((name) => {
    const directory = path.join(root, name); mkdirSync(directory, { mode: 0o700 }); return [name, directory];
  }));
  const outDir = path.join(root, "emitted"); mkdirSync(outDir);
  const keyPath = path.join(directories.runtimeKeyDir!, "key"), appSecretFile = path.join(root, "secret");
  const key = "b".repeat(64);
  writeFileSync(keyPath, `${key}\n`, { mode: 0o600 }); writeFileSync(appSecretFile, "synthetic-feishu-secret");
  const staged = { root, directories, keyPath, appSecretFile, launcherLog: path.join(root, "launcher"), gatewayPidsPath: path.join(root, "pids") };
  const live = { childState: { envKeys: [] }, summary: { entryEnvKeys: [], trace: [] } };
  const teammem = { env: {}, paths: { audioStore: directories.recordingsDir } };
  const scan = () => negativeProofs({ staged, live, teammem, outDir });
  try {
    assert.equal(keyPresent(staged), true);
    assert.deepEqual(scan().leaks.key, []); assert.equal(scan().permissions.every((entry: { valid: boolean }) => entry.valid), true);
    assert.deepEqual(scan().scanErrors, []);
    const malformedRoot = path.join(root, "not-a-directory"); writeFileSync(malformedRoot, "synthetic evidence");
    const failedScan = negativeProofs({ staged: { ...staged, directories: { ...directories, control: malformedRoot } }, live, teammem, outDir });
    assert.ok(failedScan.scanErrors.some((entry: string) => entry.includes("directory scan failed")));
    const leakedLog = path.join(outDir, "entry.stderr.log"); writeFileSync(leakedLog, key);
    assert.deepEqual(scan().leaks.key, [leakedLog]);
    chmodSync(keyPath, 0o644); assert.equal(scan().permissions.every((entry: { valid: boolean }) => entry.valid), false);
    writeFileSync(path.join(directories.recordingsDir!, "audio"), new Uint8Array(960)); assert.equal(scan().pcmMarkers.length, 1);
    assert.match(negativeProofs({ staged, live: {}, teammem, outDir }).envLeaks[0], /mandatory process environment/);
    rmSync(keyPath); assert.equal(keyPresent(staged), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Exercises the real scanner: omitting observed helpers or ignoring inventory
// failure must not turn an empty gateway file into a no-orphan certificate.
function withProcessScanner(run: (scan: (evidence: object, probe: (pid: number) => void, bridgePid?: unknown) => ReturnType<typeof negativeProofs>) => void) {
  const root = mkdtempSync(path.join(tmpdir(), "meeting-process-scanner-"));
  const directories = Object.fromEntries(["recordingsDir", "outboxDir", "receiptsDir", "control", "teammem", "runtimeKeyDir"].map(name => {
    const directory = path.join(root, name); mkdirSync(directory, { mode: 0o700 }); return [name, directory];
  }));
  const outDir = path.join(root, "emitted"); mkdirSync(outDir);
  const keyPath = path.join(directories.runtimeKeyDir!, "key"), appSecretFile = path.join(root, "secret");
  writeFileSync(keyPath, "b".repeat(64), { mode: 0o600 }); writeFileSync(appSecretFile, "synthetic-feishu-secret");
  const staged = { root, directories, keyPath, appSecretFile, gatewayPidsPath: path.join(root, "pids") };
  writeFileSync(staged.gatewayPidsPath, "");
  const teammem = { env: {}, paths: { audioStore: directories.recordingsDir } };
  try {
    run((processEvidence, probe, bridgePid) => negativeProofs({ staged, live: { processEvidence, childState: { pid: bridgePid, envKeys: [] }, summary: { entryEnvKeys: [], trace: [] } }, teammem, outDir, probe }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const exitedApp = [{ role: "meeting_app", pid: 10, outcome: { code: 0, signal: null, exitObserved: true } }];
const observedAbsent = () => { throw Object.assign(new Error("absent"), { code: "ESRCH" }); };

test("actual negative proof refuses unavailable inventory despite a known owned exit", () => {
  withProcessScanner(scan => {
    const proofs = scan({ inventory: { samples: 0, failures: ["process_inventory_unavailable"] }, children: exitedApp, observed: [] }, observedAbsent);
    assert.equal(proofs.processCleanup?.cleanupConfirmed, false);
    assert.equal(proofs.processCleanup.inventoryCoverage, "incomplete");
  });
});

test("actual negative proof checks a non-gateway observed helper after its owner exited", () => {
  withProcessScanner(scan => {
    const proofs = scan({ inventory: { samples: 2, failures: [] }, children: exitedApp, observed: [{ pid: 12, origins: ["meeting_app"] }] }, pid => { if (pid !== 12) observedAbsent(); }, 10);
    assert.deepEqual(proofs.orphans.map((row: { pid: number }) => row.pid), [12]);
    assert.equal(proofs.processCleanup?.cleanupConfirmed, false);
    assert.deepEqual(proofs.pids.find((row: { pid: number }) => row.pid === 10).origins, ["meeting_app", "bridge_child"]);
  });
});

test("actual negative proof distinguishes complete absent evidence from denied probes and missing exits", () => {
  withProcessScanner(scan => {
    const evidence = { inventory: { samples: 1, failures: [] }, children: exitedApp, observed: [{ pid: 12, origins: ["meeting_app"] }] };
    const complete = scan(evidence, observedAbsent);
    assert.equal(complete.processCleanup?.cleanupConfirmed, true);
    assert.deepEqual(complete.processCleanup.probes.map((row: { status: string }) => row.status), ["absent", "absent"]);
    const denied = scan(evidence, () => { throw Object.assign(new Error("private"), { code: "EPERM" }); });
    assert.equal(denied.processCleanup.cleanupConfirmed, false);
    assert.ok(denied.processCleanup.probes.every((row: { status: string }) => row.status === "unverified"));
    assert.equal(scan({ ...evidence, children: [{ ...exitedApp[0], outcome: null }] }, observedAbsent).processCleanup.cleanupConfirmed, false);
    assert.equal(scan({ ...evidence, inventory: { samples: 0, failures: [] } }, observedAbsent).processCleanup.cleanupConfirmed, false);
    assert.equal(scan(evidence, observedAbsent, -1).processCleanup.cleanupConfirmed, false);
  });
});
