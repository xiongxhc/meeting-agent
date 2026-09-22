// Entry-point admission tests (Cut A). The private runStandalone seam proves
// ordering and exit-code mapping with injected dependencies; the real-process
// tests run src/main.ts under Node 24 with an empty environment to prove the
// wiring, the unchanged legacy path, and the two-process held-lock refusal.

import assert from "node:assert/strict";
import childProcess, { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";

import { acquireApplicationOwnerLock, type ApplicationOwnerLock } from "../src/adapters/application-owner-lock.ts";
import { runStandalone, type CompositionResult, type StandaloneDependencies } from "../src/main.ts";
import { STANDALONE_SCHEMA, StandaloneConfigError, type StandaloneConfigV1 } from "../src/standalone-config.ts";

const NODE24 = "/opt/homebrew/opt/node@24/bin/node";
const MAIN = path.resolve("src/main.ts");
const OWNER_LOCK_URL = pathToFileURL(path.resolve("src/adapters/application-owner-lock.ts")).href;

type Fixture = { readonly dir: string; readonly stateRoot: string; close(): void };

function fixture(): Fixture {
  const dir = realpathSync(mkdtempSync(path.join(realpathSync(tmpdir()), "meeting-standalone-main-")));
  const stateRoot = path.join(dir, "state");
  mkdirSync(stateRoot, { mode: 0o700 });
  chmodSync(stateRoot, 0o700);
  return { dir, stateRoot, close() { rmSync(dir, { recursive: true, force: true }); } };
}

function configFor(f: Fixture, stateRoot = f.stateRoot): StandaloneConfigV1 {
  return {
    schema: STANDALONE_SCHEMA,
    stateRoot,
    feishu: { region: "feishu", tenantKey: "tenant-a", appId: "cli_test_app_id", appSecretFile: path.join(f.dir, "app-secret") },
    agentIdentity: { aliases: ["Robo"] },
    dataPaths: {
      recordingsDir: path.join(f.dir, "recordings"),
      outboxDir: path.join(f.dir, "outbox"),
      receiptsDir: path.join(f.dir, "receipts"),
      teamVaultDir: path.join(f.dir, "vault-checkout"),
    },
    runtime: { launcherPath: path.join(f.dir, "bin", "runtime-launcher"), gatewayConfigPath: path.join(f.dir, "gateway.json"), protocolVersion: 4 },
    bridgeSlots: [{ physicalClientId: "mac-01", bridgeId: "bridge-a", executable: path.join(f.dir, "bin", "bridge"), staticConfigPath: path.join(f.dir, "bridge-a.json") }],
  };
}

function writeConfigFile(f: Fixture, config: StandaloneConfigV1, name = "standalone.json"): string {
  const file = path.join(f.dir, name);
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

type Calls = {
  readonly reads: string[];
  readonly inspected: StandaloneConfigV1[];
  readonly acquired: string[];
  readonly composed: Array<{ config: StandaloneConfigV1; owner: ApplicationOwnerLock }>;
  readonly closes: number[];
  readonly lines: Array<{ channel: "stdout" | "stderr"; line: string }>;
  readonly order: string[];
};

type Overrides = Partial<{
  readConfig(filename: string): StandaloneConfigV1;
  inspectStateRoot(config: StandaloneConfigV1): void;
  acquireOwnerLock(stateRoot: string): Promise<ApplicationOwnerLock>;
  composeAfterAdmission(config: StandaloneConfigV1, owner: ApplicationOwnerLock): Promise<CompositionResult>;
  closeError: Error;
}>;

function seam(f: Fixture, overrides: Overrides = {}): { readonly dependencies: StandaloneDependencies; readonly calls: Calls } {
  const calls: Calls = { reads: [], inspected: [], acquired: [], composed: [], closes: [], lines: [], order: [] };
  const config = configFor(f);
  const dependencies: StandaloneDependencies = {
    readConfig(filename) {
      calls.reads.push(filename); calls.order.push("read");
      return overrides.readConfig ? overrides.readConfig(filename) : config;
    },
    inspectStateRoot(value) {
      calls.inspected.push(value); calls.order.push("inspect");
      overrides.inspectStateRoot?.(value);
    },
    async acquireOwnerLock(stateRoot) {
      calls.acquired.push(stateRoot); calls.order.push("acquire");
      if (overrides.acquireOwnerLock) return overrides.acquireOwnerLock(stateRoot);
      let closed = 0;
      return {
        assertCurrentOwnership() { if (closed > 0) throw new Error("application_owner_lock_root_unsafe"); },
        close() {
          closed += 1; calls.closes.push(closed); calls.order.push("close");
          if (overrides.closeError) throw overrides.closeError;
        },
      };
    },
    async composeAfterAdmission(value, owner) {
      calls.composed.push({ config: value, owner }); calls.order.push("compose");
      owner.assertCurrentOwnership();
      if (overrides.composeAfterAdmission) return overrides.composeAfterAdmission(value, owner);
      return { status: "composition_unavailable" };
    },
    report(channel, line) { calls.lines.push({ channel, line }); },
  };
  return { dependencies, calls };
}

function assertRedacted(f: Fixture, calls: Calls): void {
  for (const { line } of calls.lines) {
    assert.doesNotMatch(line, new RegExp(f.dir.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(line, /app-secret|cli_test|tenant-a|mac-01|bridge-a|\/Users\/|\/private\/|\/tmp\//);
  }
}

/** Counting refusals for the capabilities admission must never exercise. */
function withCounters(t: TestContext): { readonly counts: { spawn: number; fetch: number } } {
  const counts = { spawn: 0, fetch: 0 };
  t.mock.method(childProcess, "spawn", (() => { counts.spawn += 1; throw new Error("spawn forbidden"); }) as unknown as typeof childProcess.spawn);
  t.mock.method(globalThis, "fetch", (() => { counts.fetch += 1; throw new Error("fetch forbidden"); }) as unknown as typeof fetch);
  return { counts };
}

test("--help is static, exits 0 and touches no dependency", async (t) => {
  const f = fixture();
  try {
    const { counts } = withCounters(t);
    const { dependencies, calls } = seam(f);
    assert.equal(await runStandalone(["--help"], dependencies), 0);
    assert.deepEqual(calls.order, []);
    assert.equal(calls.lines.length, 1);
    assert.equal(calls.lines[0]?.channel, "stdout");
    assert.match(calls.lines[0]?.line ?? "", /--standalone-config ABSOLUTE_PATH/);
    assert.deepEqual(counts, { spawn: 0, fetch: 0 });
  } finally { f.close(); }
});

test("any invocation other than exactly --standalone-config ABSOLUTE_PATH exits 64 before reading anything", async (t) => {
  const f = fixture();
  try {
    const { counts } = withCounters(t);
    const invalid: ReadonlyArray<readonly string[]> = [
      [],
      ["--standalone-config"],
      ["--standalone-config", "relative.json"],
      ["--standalone-config", `${f.dir}/./standalone.json`],
      ["--standalone-config", `${f.dir}/standalone.json`, "--standalone-config", `${f.dir}/standalone.json`],
      ["--standalone-config", `${f.dir}/standalone.json`, "--verbose"],
      [`--standalone-config=${f.dir}/standalone.json`],
      ["--help", "--standalone-config", `${f.dir}/standalone.json`],
      ["--help", "extra"],
      ["--nope"],
      ["standalone.json"],
    ];
    for (const argv of invalid) {
      const { dependencies, calls } = seam(f);
      assert.equal(await runStandalone(argv, dependencies), 64, JSON.stringify(argv));
      assert.deepEqual(calls.order, []);
      assert.equal(calls.lines.length, 1);
      assert.equal(calls.lines[0]?.channel, "stderr");
      assert.match(calls.lines[0]?.line ?? "", /invocation/);
      assertRedacted(f, calls);
    }
    assert.deepEqual(counts, { spawn: 0, fetch: 0 });
  } finally { f.close(); }
});

test("grammar errors exit 64 and reference errors exit 65 before the state root is inspected or locked", async (t) => {
  const f = fixture();
  try {
    const { counts } = withCounters(t);
    const grammar = seam(f, { readConfig() { throw new StandaloneConfigError("grammar", "bridgeSlots[0]"); } });
    assert.equal(await runStandalone(["--standalone-config", path.join(f.dir, "standalone.json")], grammar.dependencies), 64);
    assert.deepEqual(grammar.calls.order, ["read"]);
    assert.deepEqual(grammar.calls.reads, [path.join(f.dir, "standalone.json")]);
    assert.match(grammar.calls.lines[0]?.line ?? "", /grammar.*bridgeSlots\[0\]/);

    const reference = seam(f, { readConfig() { throw new StandaloneConfigError("reference", "config"); } });
    assert.equal(await runStandalone(["--standalone-config", path.join(f.dir, "standalone.json")], reference.dependencies), 65);
    assert.deepEqual(reference.calls.order, ["read"]);
    assert.match(reference.calls.lines[0]?.line ?? "", /reference.*config/);

    const unexpected = seam(f, { readConfig() { throw new Error(`ENOENT: ${f.dir}/leak`); } });
    assert.equal(await runStandalone(["--standalone-config", path.join(f.dir, "standalone.json")], unexpected.dependencies), 70);
    assert.deepEqual(unexpected.calls.order, ["read"]);
    assertRedacted(f, unexpected.calls);

    const unsafeRoot = seam(f, { inspectStateRoot() { throw new StandaloneConfigError("reference", "stateRoot"); } });
    assert.equal(await runStandalone(["--standalone-config", path.join(f.dir, "standalone.json")], unsafeRoot.dependencies), 65);
    assert.deepEqual(unsafeRoot.calls.order, ["read", "inspect"]);
    assert.deepEqual(unsafeRoot.calls.acquired, []);
    assert.match(unsafeRoot.calls.lines[0]?.line ?? "", /reference.*stateRoot/);
    for (const { calls } of [grammar, reference, unsafeRoot]) assertRedacted(f, calls);
    assert.deepEqual(counts, { spawn: 0, fetch: 0 });
  } finally { f.close(); }
});

test("owner-lock refusals map to 75, 70 and 65 and never reach composition", async (t) => {
  const f = fixture();
  try {
    const { counts } = withCounters(t);
    const mapping: ReadonlyArray<[string, number]> = [
      ["application_owner_lock_held", 75],
      ["application_owner_lock_helper_unavailable", 70],
      ["application_owner_lock_cleanup_unconfirmed", 70],
      ["application_owner_lock_root_unsafe", 65],
      ["application_owner_lock_unsupported", 65],
      ["synthetic /secret/path failure", 70],
    ];
    for (const [message, expected] of mapping) {
      const { dependencies, calls } = seam(f, { async acquireOwnerLock() { throw new Error(message); } });
      assert.equal(await runStandalone(["--standalone-config", path.join(f.dir, "standalone.json")], dependencies), expected, message);
      assert.deepEqual(calls.order, ["read", "inspect", "acquire"]);
      assert.deepEqual(calls.acquired, [f.stateRoot]);
      assert.deepEqual(calls.composed, []);
      assert.equal(calls.lines.length, 1);
      if (message.startsWith("application_owner_lock_")) assert.match(calls.lines[0]?.line ?? "", new RegExp(message));
      assert.doesNotMatch(calls.lines[0]?.line ?? "", /secret/);
      assertRedacted(f, calls);
    }
    assert.deepEqual(counts, { spawn: 0, fetch: 0 });
  } finally { f.close(); }
});

test("a successful acquisition composes once, reports composition_unavailable as 70 and closes the owner exactly once, last", async (t) => {
  const f = fixture();
  try {
    const { counts } = withCounters(t);
    const { dependencies, calls } = seam(f);
    assert.equal(await runStandalone(["--standalone-config", path.join(f.dir, "standalone.json")], dependencies), 70);
    assert.deepEqual(calls.order, ["read", "inspect", "acquire", "compose", "close"]);
    assert.equal(calls.composed.length, 1);
    assert.equal(calls.composed[0]?.config, calls.inspected[0]);
    assert.deepEqual(calls.closes, [1]);
    assert.equal(calls.lines.length, 1);
    assert.match(calls.lines[0]?.line ?? "", /composition_unavailable/);
    assertRedacted(f, calls);
    assert.deepEqual(counts, { spawn: 0, fetch: 0 });
  } finally { f.close(); }
});

test("a composition failure or an unconfirmed owner close still exits 70 with exactly one close", async (t) => {
  const f = fixture();
  try {
    withCounters(t);
    const failing = seam(f, { async composeAfterAdmission() { throw new Error(`compose leaked ${f.dir}`); } });
    assert.equal(await runStandalone(["--standalone-config", path.join(f.dir, "standalone.json")], failing.dependencies), 70);
    assert.deepEqual(failing.calls.order, ["read", "inspect", "acquire", "compose", "close"]);
    assert.deepEqual(failing.calls.closes, [1]);
    assertRedacted(f, failing.calls);

    const unconfirmed = seam(f, { closeError: new Error("application_owner_lock_cleanup_unconfirmed") });
    assert.equal(await runStandalone(["--standalone-config", path.join(f.dir, "standalone.json")], unconfirmed.dependencies), 70);
    assert.deepEqual(unconfirmed.calls.order, ["read", "inspect", "acquire", "compose", "close"]);
    assert.deepEqual(unconfirmed.calls.closes, [1]);
    assert.ok(unconfirmed.calls.lines.some(({ line }) => /cleanup_unconfirmed/.test(line)));
    assertRedacted(f, unconfirmed.calls);
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// Real-process wiring: node src/main.ts with an empty environment.
// ---------------------------------------------------------------------------

type Completed = { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly stdout: string; readonly stderr: string };

function runMain(args: readonly string[], timeoutMs = 15_000): Promise<Completed> {
  const child = spawn(NODE24, [MAIN, ...args], { stdio: ["ignore", "pipe", "pipe"], env: {}, shell: false, detached: false });
  return collect(child, timeoutMs);
}

function collect(child: ChildProcess, timeoutMs: number): Promise<Completed> {
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } reject(new Error("child timeout")); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

async function firstLine(child: ChildProcess, timeoutMs = 10_000): Promise<string> {
  assert.ok(child.stdout);
  const stdout = child.stdout;
  return await new Promise<string>((resolve, reject) => {
    let bytes = "";
    const timer = setTimeout(() => { cleanup(); reject(new Error("child output timeout")); }, timeoutMs);
    const onData = (chunk: Buffer) => {
      bytes += chunk.toString();
      const newline = bytes.indexOf("\n");
      if (newline >= 0) { cleanup(); resolve(bytes.slice(0, newline)); }
    };
    const onClose = () => { cleanup(); reject(new Error("child closed without output")); };
    function cleanup() { clearTimeout(timer); stdout.off("data", onData); stdout.off("close", onClose); }
    stdout.on("data", onData);
    stdout.once("close", onClose);
  });
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill("SIGTERM"); } catch { /* gone */ }
  await collect(child, 3_000).catch(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
}

test("real process: no arguments keeps the legacy env-config fail-closed path unchanged", async () => {
  const result = await runMain([]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /meeting-agent: configuration error in feishu\.appId/);
  assert.match(result.stderr, /MEETING_AGENT_FEISHU_APP_ID/);
  assert.equal(result.stdout, "");
});

test("real process: --help exits 0 on stdout and a bad flag exits 64", async () => {
  const help = await runMain(["--help"]);
  assert.deepEqual([help.code, help.stderr], [0, ""]);
  assert.match(help.stdout, /--standalone-config ABSOLUTE_PATH/);
  const bad = await runMain(["--standalone-config", "relative.json"]);
  assert.deepEqual([bad.code, bad.stdout], [64, ""]);
  assert.match(bad.stderr, /invocation/);
});

test("real process: a symlinked state root exits 65 before any lock file exists", async () => {
  const f = fixture();
  try {
    const link = path.join(f.dir, "state-link");
    symlinkSync(f.stateRoot, link);
    const file = writeConfigFile(f, configFor(f, link));
    const result = await runMain(["--standalone-config", file]);
    assert.deepEqual([result.code, result.stdout], [65, ""]);
    assert.match(result.stderr, /reference error in stateRoot/);
    assert.doesNotMatch(result.stderr, /state-link|meeting-standalone-main/);
    assert.throws(() => lstatSync(path.join(f.stateRoot, "application.lock")), { code: "ENOENT" });
  } finally { f.close(); }
});

test("real process: a grammar error exits 64 with no path in the message", async () => {
  const f = fixture();
  try {
    const file = path.join(f.dir, "broken.json");
    writeFileSync(file, "{", { mode: 0o600 });
    const result = await runMain(["--standalone-config", file]);
    assert.deepEqual([result.code, result.stdout], [64, ""]);
    assert.match(result.stderr, /grammar error in config/);
    assert.doesNotMatch(result.stderr, /broken\.json|meeting-standalone-main/);
  } finally { f.close(); }
});

test("real process: a state root held by another process exits 75 and never composes; after release the same config reaches composition_unavailable and frees the root", async () => {
  const f = fixture();
  const file = writeConfigFile(f, configFor(f));
  const holder = spawn(NODE24, ["--input-type=module", "--eval", `
    import { acquireApplicationOwnerLock } from ${JSON.stringify(OWNER_LOCK_URL)};
    const owner = await acquireApplicationOwnerLock(process.argv[1]);
    process.stdout.write("acquired\\n");
    process.stdin.resume();
    process.stdin.once("data", () => { owner.close(); process.stdout.write("closed\\n"); process.exit(0); });
  `, f.stateRoot], { stdio: ["pipe", "pipe", "pipe"], env: {}, shell: false, detached: false });
  try {
    assert.equal(await firstLine(holder), "acquired");
    const held = await runMain(["--standalone-config", file]);
    assert.deepEqual([held.code, held.stdout], [75, ""]);
    assert.match(held.stderr, /application_owner_lock_held/);
    assert.doesNotMatch(held.stderr, /composition|meeting-standalone-main/);

    holder.stdin!.end("close\n");
    assert.equal(await firstLine(holder), "closed");
    const holderExit = await collect(holder, 5_000);
    assert.deepEqual([holderExit.code, holderExit.signal], [0, null]);

    const admitted = await runMain(["--standalone-config", file]);
    assert.deepEqual([admitted.code, admitted.stdout], [70, ""]);
    assert.match(admitted.stderr, /composition_unavailable/);
    assert.doesNotMatch(admitted.stderr, /meeting-standalone-main|app-secret/);
    assert.equal(lstatSync(path.join(f.stateRoot, "application.lock")).isFile(), true);

    const contender = await acquireApplicationOwnerLock(f.stateRoot);
    contender.close();
  } finally {
    await terminate(holder);
    f.close();
  }
});
