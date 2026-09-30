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
