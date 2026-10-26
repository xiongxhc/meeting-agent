import assert from "node:assert/strict";
import { cpSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const repository = path.resolve(import.meta.dirname, "..");

async function helper() {
  // A missing helper is the behavior absent in the initial red run.
  // @ts-expect-error Test-only JavaScript driver has no public declaration.
  const module = await import("./package-refusal-cuts.mjs").catch(() => ({}));
  assert.equal(typeof module.runPackageRefusalCuts, "function", "package refusal driver is available");
  return module.runPackageRefusalCuts;
}

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "meeting-package-cuts-test-")));
  chmodSync(root, 0o700);
  const directories = Object.fromEntries(["app", "stateRoot", "configDir", "recordingsDir", "outboxDir", "receiptsDir", "teamVaultDir", "control", "runtimeRoot"]
    .map((name) => { const directory = path.join(root, name); mkdirSync(directory, { mode: 0o700 }); return [name, directory]; }));
  for (const entry of ["dist", "node_modules", "package.json"]) cpSync(path.join(repository, entry), path.join(directories.app!, entry), { recursive: true, dereference: true });
  const launcherPath = path.join(root, "launcher");
  const bridgeStaticConfigPath = path.join(directories.configDir!, "bridge.json");
  const appSecretFile = path.join(directories.configDir!, "app-secret");
  const keyPath = path.join(root, "never-created-key");
  const gatewayPidsPath = path.join(root, "gateway-pids");
  writeFileSync(launcherPath, `#!/bin/sh\nexit 91\n`, { mode: 0o700 });
  writeFileSync(appSecretFile, "synthetic-refusal-fixture\n", { mode: 0o600 });
  writeFileSync(bridgeStaticConfigPath, JSON.stringify({ schema: "feishu-bridge-config/v1", audio: { captureDisplayId: 1, outputDeviceUid: "synthetic" } }), { mode: 0o600 });
  const standaloneConfig = {
    schema: "meeting-agent-standalone/v1", stateRoot: directories.stateRoot,
    feishu: { region: "feishu", tenantKey: "synthetic", appId: "cli_synthetic", appSecretFile },
    agentIdentity: { aliases: ["Synthetic"] },
    dataPaths: Object.fromEntries(["recordingsDir", "outboxDir", "receiptsDir", "teamVaultDir"].map((field) => [field, directories[field]])),
    runtime: { launcherPath, gatewayConfigPath: path.join(root, "gateway.toml"), protocolVersion: 4 },
    bridgeSlots: [{ physicalClientId: "synthetic", bridgeId: "synthetic", executable: process.execPath, staticConfigPath: bridgeStaticConfigPath }],
  };
  const standaloneConfigPath = path.join(directories.configDir!, "standalone.json");
  writeFileSync(standaloneConfigPath, JSON.stringify(standaloneConfig), { mode: 0o600 });
  return { root, directories, standaloneConfig, standaloneConfigPath, launcherPath, bridgeStaticConfigPath, keyPath, gatewayPidsPath,
    mainPath: path.join(directories.app!, "dist/src/main.js"), sdkCheckPath: path.join(repository, "scripts/check-runtime-sdk.mjs") };
}

test("private package cuts run real prerequisites and built main without mutating the staged baseline", async (context) => {
  const runPackageRefusalCuts = await helper();
  const staged = fixture();
  try {
    const protectedFiles = [staged.mainPath, staged.standaloneConfigPath, staged.bridgeStaticConfigPath, staged.launcherPath,
      path.join(staged.directories.app!, "node_modules/@conversation/runtime/package.json"),
      path.join(staged.directories.app!, "node_modules/@conversation/runtime/dist/src/client.d.ts")];
    const before = protectedFiles.map((filename) => readFileSync(filename));
    const result = await runPackageRefusalCuts({ staged });
    context.diagnostic(JSON.stringify(result.cuts.map((cut: { name: string; status: string; observed: { exit: number; stderr: string } | null }) =>
      ({ name: cut.name, status: cut.status, exit: cut.observed?.exit ?? null, stderr: cut.observed?.stderr ?? null }))));
    for (const name of ["sdk_hash", "sdk_pin", "sdk_package_missing", "package_loader_missing", "runtime_wire_version"])
      assert.equal(result.cuts.find((cut: { name: string }) => cut.name === name)?.status, "pass", name);
    const wire = result.cuts.find((cut: { name: string }) => cut.name === "runtime_wire_version");
    assert.equal(wire.observed.exit, 64);
    assert.equal(wire.observed.stderr, "meeting-agent: standalone config grammar error in runtime.protocolVersion\n");
    const bridge = result.cuts.find((cut: { name: string }) => cut.name === "bridge_static_unsupported");
    assert.ok(["pass", "masked"].includes(bridge.status), JSON.stringify(bridge));
    if (bridge.status === "masked") assert.match(bridge.observed.stderr, /^meeting-agent: application_owner_lock_(root_unsafe|unsupported)\n$/);
    const missing = result.cuts.find((cut: { name: string }) => cut.name === "missing_launcher");
    assert.equal(missing.status, "not_executed");
    assert.equal(missing.observed, null);
    assert.equal(existsSync(JSON.parse(readFileSync(missing.preparedConfigPath, "utf8")).runtime.launcherPath), false);
    assert.deepEqual(result.negativeProofs, { keyCreated: false, gatewayStarted: false, databaseCreated: false, bridgeEvidenceCreated: false });
    protectedFiles.forEach((filename, index) => assert.deepEqual(readFileSync(filename), before[index], filename));
    assert.equal(existsSync(staged.keyPath), false);
    // The actual scripted bridge's launch evidence is state.json, not an
    // invented marker. A previously used stage cannot prove no bridge ran.
    writeFileSync(path.join(staged.directories.control!, "state.json"), "{}", { mode: 0o600 });
    assert.throws(() => runPackageRefusalCuts({ staged }), /fresh private staged root required/);
  } finally { rmSync(staged.root, { recursive: true, force: true }); }
});

test("package cut driver refuses an app outside the private root before copying or spawning", async () => {
  const runPackageRefusalCuts = await helper();
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "meeting-package-cuts-unsafe-")));
  chmodSync(root, 0o700);
  try {
    assert.throws(() => runPackageRefusalCuts({ staged: { root, directories: { app: repository }, mainPath: path.join(repository, "dist/src/main.js") } }), /private staged package required/);
    assert.equal(existsSync(path.join(root, "package-refusal-cuts")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only the cut that reaches composition may print coordinator-log lines; the grammar refusal must keep stdout empty", async () => {
  const runPackageRefusalCuts = await helper();
  const staged = fixture();
  try {
    const logLine = "meeting-agent: 2026-10-23T00:00:00.000Z composition_lock_verified\n";
    // Injected process results: both main cuts print one coordinator-log line with their expected exit and stderr.
    const run = (_command: string, args: readonly string[]) => {
      const config = args[2] ?? "";
      if (config.endsWith("runtime_wire_version.json")) return { exit: 64, signal: null, stdout: logLine, stderr: "meeting-agent: standalone config grammar error in runtime.protocolVersion\n" };
      if (config.endsWith("bridge_static_unsupported.json")) return { exit: 70, signal: null, stdout: logLine, stderr: "meeting-agent: composition_unavailable bridge_slot_invalid\n" };
      return { exit: 0, signal: null, stdout: "", stderr: "" };
    };
    const result = await runPackageRefusalCuts({ staged, run });
    const status = (name: string) => result.cuts.find((cut: { name: string }) => cut.name === name)?.status;
    assert.equal(status("runtime_wire_version"), "fail", "a grammar refusal exits before the lock and must print nothing");
    assert.equal(status("bridge_static_unsupported"), "pass", "a refusal inside composition may print coordinator-log lines");
  } finally { rmSync(staged.root, { recursive: true, force: true }); }
});
