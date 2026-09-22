// Standalone config v1 parser tests (Cut A). Every rejection here must be
// static: reading the operator-selected config file is the only filesystem
// access, and no test may observe a spawn, a network call, a SQLite driver
// load, a secret-file read, or any write-shaped fs call.

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs, { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import {
  MAX_STANDALONE_CONFIG_BYTES,
  STANDALONE_SCHEMA,
  StandaloneConfigError,
  inspectStateRoot,
  parseStandaloneConfig,
  readStandaloneConfig,
  type StandaloneConfigV1,
} from "../src/standalone-config.ts";
import { scanProductionTree } from "./lib/import-scanner.ts";

const require = createRequire(import.meta.url);

type Fixture = {
  readonly dir: string;
  readonly stateRoot: string;
  readonly secretFile: string;
  close(): void;
};

function fixture(): Fixture {
  const dir = realpathSync(mkdtempSync(path.join(realpathSync(tmpdir()), "meeting-standalone-config-")));
  const stateRoot = path.join(dir, "state");
  mkdirSync(stateRoot, { mode: 0o700 });
  return {
    dir,
    stateRoot,
    secretFile: path.join(dir, "app-secret"),
    close() { rmSync(dir, { recursive: true, force: true }); },
  };
}

function validConfig(f: Fixture): Record<string, unknown> {
  return {
    schema: STANDALONE_SCHEMA,
    stateRoot: f.stateRoot,
    feishu: { region: "feishu", tenantKey: "tenant-a", appId: "cli_test_app_id", appSecretFile: f.secretFile },
    agentIdentity: { aliases: ["Robo", "机器人"] },
    dataPaths: {
      recordingsDir: path.join(f.dir, "recordings"),
      outboxDir: path.join(f.dir, "outbox"),
      receiptsDir: path.join(f.dir, "receipts"),
      teamVaultDir: path.join(f.dir, "vault-checkout"),
    },
    runtime: { launcherPath: path.join(f.dir, "bin", "runtime-launcher"), gatewayConfigPath: path.join(f.dir, "gateway.json"), protocolVersion: 4 },
    bridgeSlots: [
      { physicalClientId: "mac-01", bridgeId: "bridge-a", executable: path.join(f.dir, "bin", "bridge"), staticConfigPath: path.join(f.dir, "bridge-a.json") },
      { physicalClientId: "mac-02", bridgeId: "bridge-b", executable: path.join(f.dir, "bin", "bridge"), staticConfigPath: path.join(f.dir, "bridge-b.json"), argv: ["--headless"], cooperativeGraceMs: 5000 },
    ],
  };
}

function writeConfig(f: Fixture, contents: string | Record<string, unknown>, mode = 0o600, name = "standalone.json"): string {
  const file = path.join(f.dir, name);
  writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents), { mode });
  chmodSync(file, mode);
  return file;
}

function bytes(value: string | Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
}

type Counters = { spawn: number; fetch: number; write: number; readFile: number; secretOpen: number };
const ZERO: Counters = { spawn: 0, fetch: 0, write: 0, readFile: 0, secretOpen: 0 };
const WRITE_SHAPED = ["mkdirSync", "chmodSync", "unlinkSync", "writeFileSync", "rmSync", "rmdirSync", "renameSync", "linkSync", "symlinkSync", "appendFileSync", "copyFileSync"] as const;

/** Runs `run` with every side-effect capability replaced by a counting refusal,
 * then proves nothing was counted and the SQLite driver never loaded. */
function guarded<T>(t: TestContext, run: () => T): T {
  const counts: Counters = { ...ZERO };
  const originalOpen = fs.openSync;
  t.mock.method(childProcess, "spawn", (() => { counts.spawn += 1; throw new Error("spawn forbidden"); }) as unknown as typeof childProcess.spawn);
  t.mock.method(globalThis, "fetch", (() => { counts.fetch += 1; throw new Error("fetch forbidden"); }) as unknown as typeof fetch);
  for (const name of WRITE_SHAPED) {
    t.mock.method(fs, name, (() => { counts.write += 1; throw new Error(`${name} forbidden`); }) as never);
  }
  t.mock.method(fs, "readFileSync", (() => { counts.readFile += 1; throw new Error("readFileSync forbidden"); }) as never);
  t.mock.method(fs, "openSync", ((file: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode | null) => {
    if (String(file).endsWith("app-secret")) counts.secretOpen += 1;
    return originalOpen(file, flags ?? "r", mode);
  }) as typeof fs.openSync);
  syncBuiltinESMExports();
  try {
    return run();
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.deepEqual(counts, ZERO);
    assert.ok(!Object.keys(require.cache).some((key) => key.includes("better-sqlite3")), "SQLite driver must never load during admission");
  }
}

function rejects(run: () => unknown, category: "grammar" | "reference", field: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof StandaloneConfigError, `expected StandaloneConfigError, got ${String(error)}`);
    assert.equal(error.category, category);
    assert.equal(error.field, field);
    assert.doesNotMatch(error.message, /\/|tenant-a|cli_test|app-secret|mac-|bridge-|headless/, "message must name only category and field");
    return true;
  });
}

test("a complete valid config is read through a descriptor and parsed exactly", (t) => {
  const f = fixture();
  try {
    const file = writeConfig(f, validConfig(f), 0o644);
    const config = guarded(t, () => readStandaloneConfig(file));
    assert.equal(config.schema, STANDALONE_SCHEMA);
    assert.equal(config.stateRoot, f.stateRoot);
    assert.deepEqual(config.feishu, { region: "feishu", tenantKey: "tenant-a", appId: "cli_test_app_id", appSecretFile: f.secretFile });
    assert.deepEqual(config.agentIdentity.aliases, ["Robo", "机器人"]);
    assert.equal(config.runtime.protocolVersion, 4);
    assert.equal(config.bridgeSlots.length, 2);
    assert.deepEqual(config.bridgeSlots[1]?.argv, ["--headless"]);
    assert.equal(config.bridgeSlots[1]?.cooperativeGraceMs, 5000);
    assert.equal(Object.hasOwn(config.bridgeSlots[0]!, "argv"), false);
    guarded(t, () => inspectStateRoot(config));
  } finally { f.close(); }
});

test("invalid JSON, invalid UTF-8 and a BOM are grammar errors naming the config", (t) => {
  guarded(t, () => {
    rejects(() => parseStandaloneConfig(bytes("{ not json")), "grammar", "config");
    rejects(() => parseStandaloneConfig(new Uint8Array([0x7b, 0xff, 0x7d])), "grammar", "config");
    rejects(() => parseStandaloneConfig(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("{}")])), "grammar", "config");
    rejects(() => parseStandaloneConfig(bytes("[]")), "grammar", "config");
    rejects(() => parseStandaloneConfig(bytes("null")), "grammar", "config");
  });
});

test("a wrong, unsupported or missing schema version is a grammar error", (t) => {
  const f = fixture();
  try {
    guarded(t, () => {
      for (const schema of ["meeting-agent-standalone/v2", "meeting-agent-standalone/v0", "meeting-agent/v1", 1, null]) {
        rejects(() => parseStandaloneConfig(bytes({ ...validConfig(f), schema })), "grammar", "schema");
      }
      const { schema: _dropped, ...withoutSchema } = validConfig(f);
      void _dropped;
      rejects(() => parseStandaloneConfig(bytes(withoutSchema)), "grammar", "config");
    });
  } finally { f.close(); }
});

test("unknown keys are rejected at the top level and inside every nested object", (t) => {
  const f = fixture();
  try {
    guarded(t, () => {
      rejects(() => parseStandaloneConfig(bytes({ ...validConfig(f), extension: {} })), "grammar", "config");
      rejects(() => parseStandaloneConfig(bytes(JSON.stringify(validConfig(f)).replace(/^\{/, '{"__proto__":{"polluted":true},'))), "grammar", "config");
      const cases: ReadonlyArray<[string, (value: Record<string, unknown>) => void]> = [
        ["feishu", (v) => { (v.feishu as Record<string, unknown>).appSecret = "inline"; }],
        ["agentIdentity", (v) => { (v.agentIdentity as Record<string, unknown>).displayName = "x"; }],
        ["dataPaths", (v) => { (v.dataPaths as Record<string, unknown>).cacheDir = "/tmp/x"; }],
        ["runtime", (v) => { (v.runtime as Record<string, unknown>).endpoint = "https://x"; }],
        ["bridgeSlots[0]", (v) => { (v.bridgeSlots as Record<string, unknown>[])[0]!.env = { A: "1" }; }],
      ];
      for (const [field, mutate] of cases) {
        const value = validConfig(f);
        mutate(value);
        rejects(() => parseStandaloneConfig(bytes(value)), "grammar", field);
      }
    });
  } finally { f.close(); }
});

test("missing required fields and wrong value types are grammar errors naming the field", (t) => {
  const f = fixture();
  try {
    guarded(t, () => {
      const mutate = (edit: (value: Record<string, unknown>) => void): Record<string, unknown> => {
        const value = JSON.parse(JSON.stringify(validConfig(f))) as Record<string, unknown>;
        edit(value);
        return value;
      };
      rejects(() => parseStandaloneConfig(bytes(mutate((v) => { delete v.feishu; }))), "grammar", "config");
      rejects(() => parseStandaloneConfig(bytes(mutate((v) => { (v.feishu as Record<string, unknown>).region = "global"; }))), "grammar", "feishu.region");
      rejects(() => parseStandaloneConfig(bytes(mutate((v) => { (v.feishu as Record<string, unknown>).tenantKey = " "; }))), "grammar", "feishu.tenantKey");
      rejects(() => parseStandaloneConfig(bytes(mutate((v) => { (v.feishu as Record<string, unknown>).tenantKey = "租户"; }))), "grammar", "feishu.tenantKey");
      rejects(() => parseStandaloneConfig(bytes(mutate((v) => { (v.feishu as Record<string, unknown>).appId = "app_123"; }))), "grammar", "feishu.appId");
      rejects(() => parseStandaloneConfig(bytes(mutate((v) => { (v.agentIdentity as Record<string, unknown>).aliases = []; }))), "grammar", "agentIdentity.aliases");
      rejects(() => parseStandaloneConfig(bytes(mutate((v) => { (v.agentIdentity as Record<string, unknown>).aliases = ["ok", "  "]; }))), "grammar", "agentIdentity.aliases");
      rejects(() => parseStandaloneConfig(bytes(mutate((v) => { (v.agentIdentity as Record<string, unknown>).aliases = "Robo"; }))), "grammar", "agentIdentity.aliases");
      rejects(() => parseStandaloneConfig(bytes(mutate((v) => { (v.runtime as Record<string, unknown>).protocolVersion = 3; }))), "grammar", "runtime.protocolVersion");
      rejects(() => parseStandaloneConfig(bytes(mutate((v) => { (v.runtime as Record<string, unknown>).protocolVersion = "4"; }))), "grammar", "runtime.protocolVersion");
      rejects(() => parseStandaloneConfig(bytes(mutate((v) => { v.bridgeSlots = {}; }))), "grammar", "bridgeSlots");
      rejects(() => parseStandaloneConfig(bytes(mutate((v) => { (v.bridgeSlots as unknown[])[0] = "slot"; }))), "grammar", "bridgeSlots[0]");
    });
  } finally { f.close(); }
});

test("an oversize config is rejected by byte count before parsing", (t) => {
  const f = fixture();
  try {
    const padded = { ...validConfig(f), agentIdentity: { aliases: ["a".repeat(MAX_STANDALONE_CONFIG_BYTES)] } };
    const file = writeConfig(f, padded);
    guarded(t, () => {
      rejects(() => parseStandaloneConfig(bytes(padded)), "grammar", "config");
      rejects(() => readStandaloneConfig(file), "grammar", "config");
      assert.equal(parseStandaloneConfig(new Uint8Array([...bytes(validConfig(f)), ...new Array<number>(MAX_STANDALONE_CONFIG_BYTES - bytes(validConfig(f)).length).fill(0x20)])).stateRoot, f.stateRoot);
    });
  } finally { f.close(); }
});

test("every path must be absolute and normalized; the parser never rewrites one", (t) => {
  const f = fixture();
  try {
    guarded(t, () => {
      const edit = (apply: (value: Record<string, unknown>) => void): Record<string, unknown> => {
        const value = JSON.parse(JSON.stringify(validConfig(f))) as Record<string, unknown>;
        apply(value);
        return value;
      };
      rejects(() => parseStandaloneConfig(bytes(edit((v) => { v.stateRoot = "state"; }))), "grammar", "stateRoot");
      rejects(() => parseStandaloneConfig(bytes(edit((v) => { v.stateRoot = `${f.stateRoot}/`; }))), "grammar", "stateRoot");
      rejects(() => parseStandaloneConfig(bytes(edit((v) => { v.stateRoot = `${f.dir}/./state`; }))), "grammar", "stateRoot");
      rejects(() => parseStandaloneConfig(bytes(edit((v) => { v.stateRoot = `${f.stateRoot}\0`; }))), "grammar", "stateRoot");
      rejects(() => parseStandaloneConfig(bytes(edit((v) => { (v.feishu as Record<string, unknown>).appSecretFile = "secrets/app"; }))), "grammar", "feishu.appSecretFile");
      rejects(() => parseStandaloneConfig(bytes(edit((v) => { (v.dataPaths as Record<string, unknown>).outboxDir = "outbox"; }))), "grammar", "dataPaths.outboxDir");
      rejects(() => parseStandaloneConfig(bytes(edit((v) => { (v.runtime as Record<string, unknown>).launcherPath = "../launcher"; }))), "grammar", "runtime.launcherPath");
      rejects(() => parseStandaloneConfig(bytes(edit((v) => { (v.runtime as Record<string, unknown>).gatewayConfigPath = "gateway.json"; }))), "grammar", "runtime.gatewayConfigPath");
      rejects(() => parseStandaloneConfig(bytes(edit((v) => { (v.bridgeSlots as Record<string, unknown>[])[0]!.executable = "bin/bridge"; }))), "grammar", "bridgeSlots[0]");
      rejects(() => parseStandaloneConfig(bytes(edit((v) => { (v.bridgeSlots as Record<string, unknown>[])[1]!.staticConfigPath = "bridge.json"; }))), "grammar", "bridgeSlots[1]");
    });
  } finally { f.close(); }
});

test("a non-canonical stateRoot is refused as a reference error and never remapped", (t) => {
  const f = fixture();
  try {
    const link = path.join(f.dir, "state-link");
    symlinkSync(f.stateRoot, link);
    const viaLink = parseStandaloneConfig(bytes({ ...validConfig(f), stateRoot: link }));
    const missing = parseStandaloneConfig(bytes({ ...validConfig(f), stateRoot: path.join(f.dir, "absent") }));
    guarded(t, () => {
      rejects(() => inspectStateRoot(viaLink), "reference", "stateRoot");
      assert.equal(viaLink.stateRoot, link);
      rejects(() => inspectStateRoot(missing), "reference", "stateRoot");
    });
  } finally { f.close(); }
});

test("data paths may not overlap each other or the state root", (t) => {
  const f = fixture();
  try {
    guarded(t, () => {
      const configWith = (dataPaths: Record<string, string>): StandaloneConfigV1 =>
        parseStandaloneConfig(bytes({ ...validConfig(f), dataPaths: { ...(validConfig(f).dataPaths as Record<string, string>), ...dataPaths } }));
      rejects(() => inspectStateRoot(configWith({ outboxDir: path.join(f.dir, "recordings") })), "reference", "dataPaths.recordingsDir");
      rejects(() => inspectStateRoot(configWith({ receiptsDir: path.join(f.dir, "recordings", "receipts") })), "reference", "dataPaths.receiptsDir");
      rejects(() => inspectStateRoot(configWith({ teamVaultDir: path.join(f.dir, "outbox", "vault") })), "reference", "dataPaths.teamVaultDir");
      rejects(() => inspectStateRoot(configWith({ recordingsDir: f.stateRoot })), "reference", "dataPaths.recordingsDir");
      rejects(() => inspectStateRoot(configWith({ outboxDir: path.join(f.stateRoot, "outbox") })), "reference", "dataPaths.outboxDir");
      rejects(() => inspectStateRoot(configWith({ receiptsDir: f.dir })), "reference", "dataPaths.recordingsDir");
      rejects(() => inspectStateRoot(configWith({ receiptsDir: path.dirname(f.dir) })), "reference", "dataPaths.recordingsDir");
      inspectStateRoot(configWith({ recordingsDir: `${f.stateRoot}-archive` }));
    });
  } finally { f.close(); }
});

test("bridgeSlots must hold between one and eight bindings with unique labels", (t) => {
  const f = fixture();
  try {
    guarded(t, () => {
      const slot = (index: number): Record<string, unknown> => ({
        physicalClientId: `mac-${index}`, bridgeId: `bridge-${index}`, executable: path.join(f.dir, "bin", "bridge"), staticConfigPath: path.join(f.dir, `bridge-${index}.json`),
      });
      rejects(() => parseStandaloneConfig(bytes({ ...validConfig(f), bridgeSlots: [] })), "grammar", "bridgeSlots");
      rejects(() => parseStandaloneConfig(bytes({ ...validConfig(f), bridgeSlots: Array.from({ length: 9 }, (_, index) => slot(index)) })), "grammar", "bridgeSlots");
      assert.equal(parseStandaloneConfig(bytes({ ...validConfig(f), bridgeSlots: Array.from({ length: 8 }, (_, index) => slot(index)) })).bridgeSlots.length, 8);
      rejects(() => parseStandaloneConfig(bytes({ ...validConfig(f), bridgeSlots: [slot(1), { ...slot(2), physicalClientId: "mac-1" }] })), "grammar", "bridgeSlots");
      rejects(() => parseStandaloneConfig(bytes({ ...validConfig(f), bridgeSlots: [slot(1), { ...slot(2), bridgeId: "bridge-1" }] })), "grammar", "bridgeSlots");
      rejects(() => parseStandaloneConfig(bytes({ ...validConfig(f), bridgeSlots: [{ ...slot(1), physicalClientId: ".." }] })), "grammar", "bridgeSlots[0]");
      rejects(() => parseStandaloneConfig(bytes({ ...validConfig(f), bridgeSlots: [{ ...slot(1), bridgeId: "" }] })), "grammar", "bridgeSlots[0]");
    });
  } finally { f.close(); }
});

test("bridge argv and cooperative grace reuse the child launch limits", (t) => {
  const f = fixture();
  try {
    guarded(t, () => {
      const withSlot = (extra: Record<string, unknown>): Record<string, unknown> => {
        const value = validConfig(f);
        (value.bridgeSlots as Record<string, unknown>[])[0] = { ...(value.bridgeSlots as Record<string, unknown>[])[0], ...extra };
        return value;
      };
      rejects(() => parseStandaloneConfig(bytes(withSlot({ argv: Array.from({ length: 17 }, () => "x") }))), "grammar", "bridgeSlots[0]");
      rejects(() => parseStandaloneConfig(bytes(withSlot({ argv: ["a\0b"] }))), "grammar", "bridgeSlots[0]");
      rejects(() => parseStandaloneConfig(bytes(withSlot({ argv: ["x".repeat(4100)] }))), "grammar", "bridgeSlots[0]");
      rejects(() => parseStandaloneConfig(bytes(withSlot({ argv: [1] }))), "grammar", "bridgeSlots[0]");
      rejects(() => parseStandaloneConfig(bytes(withSlot({ argv: "--flag" }))), "grammar", "bridgeSlots[0]");
      rejects(() => parseStandaloneConfig(bytes(withSlot({ cooperativeGraceMs: 999 }))), "grammar", "bridgeSlots[0]");
      rejects(() => parseStandaloneConfig(bytes(withSlot({ cooperativeGraceMs: 30_001 }))), "grammar", "bridgeSlots[0]");
      rejects(() => parseStandaloneConfig(bytes(withSlot({ cooperativeGraceMs: 1500.5 }))), "grammar", "bridgeSlots[0]");
      rejects(() => parseStandaloneConfig(bytes(withSlot({ cooperativeGraceMs: "5000" }))), "grammar", "bridgeSlots[0]");
      assert.equal(parseStandaloneConfig(bytes(withSlot({ argv: Array.from({ length: 16 }, () => "x"), cooperativeGraceMs: 30_000 }))).bridgeSlots[0]?.argv?.length, 16);
    });
  } finally { f.close(); }
});

test("a symlinked, non-regular, foreign-owned or group/other-writable config file is a reference error", (t) => {
  const f = fixture();
  try {
    const real = writeConfig(f, validConfig(f));
    const link = path.join(f.dir, "standalone-link.json");
    symlinkSync(real, link);
    const groupWritable = writeConfig(f, validConfig(f), 0o664, "group.json");
    const otherWritable = writeConfig(f, validConfig(f), 0o606, "other.json");
    guarded(t, () => {
      rejects(() => readStandaloneConfig(link), "reference", "config");
      rejects(() => readStandaloneConfig(f.stateRoot), "reference", "config");
      rejects(() => readStandaloneConfig(path.join(f.dir, "absent.json")), "reference", "config");
      rejects(() => readStandaloneConfig(groupWritable), "reference", "config");
      rejects(() => readStandaloneConfig(otherWritable), "reference", "config");
      rejects(() => readStandaloneConfig("relative.json"), "grammar", "config");
    });
    const originalFstat = fs.fstatSync;
    t.mock.method(fs, "fstatSync", ((fd: number, options?: { bigint?: boolean }) => {
      const value = originalFstat(fd, { bigint: true });
      value.uid += 1n;
      return options?.bigint ? value : originalFstat(fd);
    }) as typeof fs.fstatSync);
    syncBuiltinESMExports();
    try { rejects(() => readStandaloneConfig(real), "reference", "config"); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  } finally { f.close(); }
});

test("the parser module owns no network, SQLite, environment or filesystem-write capability", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "standalone-config-scan-"));
  try {
    mkdirSync(path.join(dir, "src"));
    fs.copyFileSync(path.resolve("src/standalone-config.ts"), path.join(dir, "src", "standalone-config.ts"));
    const result = scanProductionTree(path.join(dir, "src"));
    const specifiers = result.imports.map((record) => record.specifier);
    assert.ok(specifiers.includes("node:fs"));
    assert.ok(specifiers.every((specifier) => !/sqlite|http|net|ws|lark|child_process/i.test(specifier)), specifiers.join(", "));
    assert.deepEqual(result.runtimeBoundaryCalls, []);
    assert.deepEqual(result.environmentAccesses, []);
    assert.deepEqual(result.fsWriteCapabilityImports, []);
    assert.deepEqual(result.writeLikeCalls, []);
    assert.deepEqual(result.opaqueConstructs, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
