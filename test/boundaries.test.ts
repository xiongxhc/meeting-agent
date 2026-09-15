// Structural dependency-boundary test. Per LANE-CONSTRAINTS.md and the design
// spec's ownership table, Meeting Agent production code must never:
//   - call OpenAI directly (all provider work flows through Conversation Runtime);
//   - import a TeamMem Python/module path or open TeamMem's SQLite ledger file;
//   - import a Team Vault write helper (Meeting Agent only reads rendered Markdown).
//
// This test walks src/ itself (it does not consult a hard-coded file list), so a
// file added in a later task is covered automatically. It also proves, against
// synthetic temp-directory fixtures, that the scanner actually catches each
// forbidden shape rather than trivially passing because src/ is empty or small.
//
// Four layers, from cheap-but-narrow to expensive-but-hard-to-evade:
//   1. import-specifier rules (findViolations) -- only sees a violation that
//      takes the shape of an actual import.
//   2. call-argument string-literal rules (findForbiddenPathLiterals) -- sees
//      a TeamMem ledger/data path handed straight to a driver or path-join
//      call, not only an import.
//   3. fs write-capability ownership -- permits only the application outbox
//      mkdir and the explicitly reserved filesystem-outbox adapter.
//   4. dependency-level SQLite gate (findForbiddenSqliteDependencies /
//      findUnconfinedSqliteImports) -- a rule a renamed variable cannot evade.
// Plus a catch-all: any require()/computed dynamic import() is itself flagged
// as requiring manual review, since the specifier-based layers above cannot
// see into it at all.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  collectImports,
  findForbiddenRuntimeBoundaryAccess,
  findForbiddenFilesystemWriteCapabilities,
  findForbiddenPathLiterals,
  findForbiddenSqliteDependencies,
  findOpaqueConstructs,
  findUnconfinedSqliteImports,
  findViolations,
  scanProductionTree,
  type PackageJsonLike,
} from "./lib/import-scanner.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

test("SDK value aliases, reexports and dynamic imports are confined to exact Feishu owners",()=>{
  withTempDir((root)=>{
    const forms=['import { Client as Renamed } from "@larksuiteoapi/node-sdk";',
      'export { WSClient as Socket } from "@larksuiteoapi/node-sdk";',
      'const load=()=>import("@larksuiteoapi/node-sdk");',
      'import "@larksuiteoapi/node-sdk";', 'import { WebSocket as Renamed } from "ws";'];
    mkdirSync(path.join(root,"src"),{recursive:true});
    for(const [index,form] of forms.entries())writeFileSync(path.join(root,"src",`bad${index}.ts`),form);
    assert.equal(findForbiddenRuntimeBoundaryAccess(scanProductionTree(path.join(root,"src")),root).length,5);
    mkdirSync(path.join(root,"src/adapters"),{recursive:true});
    writeFileSync(path.join(root,"src/adapters/feishu-invite-ingress.ts"),forms[0]!);
    writeFileSync(path.join(root,"src/types.ts"),'import type { Client } from "@larksuiteoapi/node-sdk";');
    assert.equal(findForbiddenRuntimeBoundaryAccess(scanProductionTree(path.join(root,"src")),root).length,5);
    writeFileSync(path.join(root,"src/adapters/feishu-api.ts"),forms[0]!);
    assert.equal(findForbiddenRuntimeBoundaryAccess(scanProductionTree(path.join(root,"src")),root).length,6);
  });
});

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), "boundary-scan-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("src/ discovers files structurally and contains no forbidden production imports", () => {
  const imports = collectImports(SRC_ROOT);
  // Guard against the test silently passing because src/ is empty: it must
  // actually find production imports to have inspected anything meaningful.
  assert.ok(
    imports.length > 0,
    "expected src/ to contain at least one production import once implemented",
  );
  const violations = findViolations(imports);
  assert.deepEqual(
    violations,
    [],
    `forbidden production imports found:\n${violations
      .map((v) => `  ${v.file}: "${v.specifier}" (${v.rule})`)
      .join("\n")}`,
  );
});

test("scanner walks nested directories it was never told about", () => {
  withTempDir((dir) => {
    const nested = path.join(dir, "a", "b", "c");
    writeFileSync(
      path.join(dir, "top.ts"),
      'export const a = 1;\nimport { z } from "zod";\n',
      { flag: "w" },
    );
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      path.join(nested, "deep.ts"),
      'import { something } from "some-package";\nexport const b = something;\n',
    );

    const imports = collectImports(dir);
    const specifiers = imports.map((i) => i.specifier).sort();
    assert.deepEqual(specifiers, ["some-package", "zod"]);
  });
});

test("scanner ignores *.test.ts files (production imports only)", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "openai-user.test.ts"),
      'import OpenAI from "openai";\n',
    );
    const imports = collectImports(dir);
    assert.deepEqual(imports, []);
  });
});

test("negative control: flags a direct OpenAI SDK import", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "bad-openai.ts"),
      'import OpenAI from "openai";\nexport const client = new OpenAI();\n',
    );
    const violations = findViolations(collectImports(dir));
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.rule, "OpenAI SDK");
  });
});

test("negative control: flags an openai/* subpath import", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "bad-openai-sub.ts"),
      'export { toFile } from "openai/uploads";\n',
    );
    const violations = findViolations(collectImports(dir));
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.rule, "OpenAI SDK");
  });
});

test("negative control: flags a TeamMem module path", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "bad-teammem.ts"),
      'import { importLedger } from "../../../team-memory-agent/engine/importer.py";\n',
    );
    const violations = findViolations(collectImports(dir));
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.rule, "TeamMem Python/module path");
  });
});

test("explicit local v1 and v2 meeting contract imports are allowed", () => {
  withTempDir((dir) => {
    const specifiers = [
      "../contracts/teammem-meeting-v1.ts",
      "./teammem-meeting-v1.ts",
      "../contracts/teammem-meeting-v2.ts",
      "./contracts/teammem-meeting-v2.ts",
      "./teammem-meeting-v2.ts",
    ];
    writeFileSync(path.join(dir, "local-contracts.ts"), specifiers.map(
      (specifier) => `export * from ${JSON.stringify(specifier)};`,
    ).join("\n"));
    assert.deepEqual(findViolations(collectImports(dir)), []);
  });
});

test("local contract exceptions do not admit external or lookalike TeamMem paths", () => {
  withTempDir((dir) => {
    const specifiers = [
      "../contracts/teammem-meeting-v2.py",
      "../contracts/teammem-meeting-v3.ts",
      "../contracts/teammem-meeting-v2.ts/helper",
      "../../team-memory-agent/teammem-meeting-v2.ts",
      "teammem-meeting-v2.ts",
    ];
    writeFileSync(path.join(dir, "lookalikes.ts"), specifiers.map(
      (specifier) => `export * from ${JSON.stringify(specifier)};`,
    ).join("\n"));
    const violations = findViolations(collectImports(dir));
    assert.deepEqual(violations.map((violation) => violation.specifier), specifiers);
    assert.ok(violations.every((violation) => violation.rule === "TeamMem Python/module path"));
  });
});

test("negative control: flags TeamMem's SQLite ledger file", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "bad-ledger.ts"),
      'import db from "~/.local/share/teammem/ledger.db";\n',
    );
    const violations = findViolations(collectImports(dir));
    assert.ok(violations.some((v) => v.rule === "TeamMem SQLite ledger file"));
  });
});

test("negative control: flags a Team Vault write helper", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "bad-vault-write.ts"),
      'import { writeVaultNote } from "./adapters/team-vault-writer.ts";\n',
    );
    const violations = findViolations(collectImports(dir));
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.rule, "Team Vault write helper");
  });
});

test("a legitimate import is never flagged", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "ok.ts"),
      [
        'import { z } from "zod";',
        'import type { Something } from "./domain/meeting.ts";',
        'export { z };',
        '',
      ].join("\n"),
    );
    const violations = findViolations(collectImports(dir));
    assert.deepEqual(violations, []);
  });
});

// ---------------------------------------------------------------------------
// Layer 2: call-argument string literals that reveal TeamMem's ledger/data
// paths even when no import ever names them (e.g. handed straight to a
// driver constructor, or built through path.join).
// ---------------------------------------------------------------------------

test("src/ has no TeamMem ledger/data path literal in any call argument", () => {
  const { callArgumentLiterals } = scanProductionTree(SRC_ROOT);
  const violations = findForbiddenPathLiterals(callArgumentLiterals);
  assert.deepEqual(
    violations,
    [],
    `forbidden path literals found:\n${violations
      .map((v) => `  ${v.file}: "${v.specifier}" (${v.rule})`)
      .join("\n")}`,
  );
});

test("negative control: flags a TeamMem ledger path handed to a driver constructor, not imported", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "bad-driver.ts"),
      [
        'import Database from "better-sqlite3";',
        "import path from \"node:path\";",
        "import os from \"node:os\";",
        "",
        "export function openLedger() {",
        '  return new Database(path.join(os.homedir(), ".local/share/teammem/ledger.db"));',
        "}",
        "",
      ].join("\n"),
    );
    const { callArgumentLiterals } = scanProductionTree(dir);
    const violations = findForbiddenPathLiterals(callArgumentLiterals);
    assert.equal(violations.length, 1);
    assert.match(violations[0]?.specifier ?? "", /\.local\/share\/teammem/);
  });
});

test("negative control: flags a bare readFileSync call against the TeamMem ledger path", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "bad-read.ts"),
      [
        'import fs from "node:fs";',
        "",
        "export function peek() {",
        '  return readFileSync("/Users/x/.local/share/teammem/ledger.db");',
        "}",
        "",
      ].join("\n"),
    );
    const violations = findForbiddenPathLiterals(scanProductionTree(dir).callArgumentLiterals);
    assert.equal(violations.length, 1);
  });
});

test("an ordinary domain-vocabulary literal (e.g. a TeamMember-shaped string) is never flagged", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "ok-domain.ts"),
      [
        "export function label(count: number) {",
        '  return count === 1 ? "TeamMember" : "TeamMembers";',
        "}",
        "",
      ].join("\n"),
    );
    const violations = findForbiddenPathLiterals(scanProductionTree(dir).callArgumentLiterals);
    assert.deepEqual(violations, []);
  });
});

// ---------------------------------------------------------------------------
// Layer 3: filesystem write-capability ownership. The read-only Team Vault
// index is not an owner, so renaming its directory cannot make writes legal.
// ---------------------------------------------------------------------------

test("src/ grants no filesystem write capability outside explicit owners", () => {
  const result = scanProductionTree(SRC_ROOT);
  const violations = findForbiddenFilesystemWriteCapabilities(result, REPO_ROOT);
  assert.deepEqual(
    violations,
    [],
    `forbidden filesystem write capabilities found:\n${violations
      .map((v) => `  ${v.file}: ${v.specifier} (${v.rule})`)
      .join("\n")}`,
  );
});

test("negative control: flags fs.writeFileSync reachable from config.dataPaths.teamVaultDir", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "bad-vault-write.ts"),
      [
        'import fs from "node:fs";',
        "",
        "export function writeNote(config: { dataPaths: { teamVaultDir: string } }) {",
        '  fs.writeFileSync(config.dataPaths.teamVaultDir + "/note.md", "hi");',
        "}",
        "",
      ].join("\n"),
    );
    const violations = findForbiddenFilesystemWriteCapabilities(scanProductionTree(dir));
    assert.equal(violations.length, 2);
    assert.match(violations[0]?.rule ?? "", /filesystem write capability/);
  });
});

test("negative control: flags a destructured teamVaultDir reaching createWriteStream", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "bad-vault-stream.ts"),
      [
        'import fs from "node:fs";',
        "",
        "export function openForWrite(teamVaultDir: string, name: string) {",
        "  return fs.createWriteStream(teamVaultDir + \"/\" + name);",
        "}",
        "",
      ].join("\n"),
    );
    const violations = findForbiddenFilesystemWriteCapabilities(scanProductionTree(dir));
    assert.equal(violations.length, 2);
  });
});

test("reading from the Team Vault directory is never flagged (only write-shaped calls are)", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "ok-vault-read.ts"),
      [
        'import { readFileSync } from "node:fs";',
        "",
        "export function readNote(config: { dataPaths: { teamVaultDir: string } }) {",
        '  return readFileSync(config.dataPaths.teamVaultDir + "/note.md", "utf8");',
        "}",
        "",
      ].join("\n"),
    );
    const violations = findForbiddenFilesystemWriteCapabilities(scanProductionTree(dir));
    assert.deepEqual(violations, []);
  });
});

test("negative control: flags a renamed Team Vault capability reaching a write", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "bad-renamed-vault-write.ts"),
      [
        'import fs from "node:fs";',
        "",
        "export function writeNote(publishedVault: string) {",
        '  fs.writeFileSync(publishedVault + "/note.md", "hi");',
        "}",
        "",
      ].join("\n"),
    );
    assert.equal(findForbiddenFilesystemWriteCapabilities(scanProductionTree(dir)).length, 2);
  });
});

// ---------------------------------------------------------------------------
// Layer 3b: provider and recording-key access may not bypass the runtime.
// ---------------------------------------------------------------------------

test("src/ makes no unowned network call or reads a provider/recording-key environment variable", () => {
  assert.deepEqual(findForbiddenRuntimeBoundaryAccess(scanProductionTree(SRC_ROOT), REPO_ROOT), []);
});

test("negative control: flags direct provider HTTP and recording-key environment access", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "bad-runtime-boundary.ts"),
      [
        'export async function bypass() {',
        '  await fetch("https://api.openai.com/v1/responses");',
        '  return process.env.MEETING_RECORDING_KEY;',
        '}',
        '',
      ].join("\n"),
    );
    const violations = findForbiddenRuntimeBoundaryAccess(scanProductionTree(dir));
    assert.equal(violations.length, 2);
  });
});

test("negative control: endpoint spelling cannot exempt aliased fetch or an aliased HTTPS request capability", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "bad-network-capability.ts"),
      [
        'import { request as issueRequest } from "node:https";',
        'const send = fetch;',
        'const endpoint = "https://" + "model" + ".example.test/v1";',
        'export async function bypass() {',
        '  await send(endpoint);',
        '  return issueRequest(endpoint);',
        '}',
        '',
      ].join("\n"),
    );
    const violations = findForbiddenRuntimeBoundaryAccess(scanProductionTree(dir));
    assert.equal(violations.length, 3);
  });
});

test("negative control: direct network and filesystem capability re-exports are owned capabilities", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "bad-capability-reexports.ts"),
      [
        'export { request as providerRequest } from "node:https";',
        'export { writeFileSync as overwriteVault } from "node:fs";',
        '',
      ].join("\n"),
    );
    const result = scanProductionTree(dir);
    assert.equal(findForbiddenRuntimeBoundaryAccess(result).length, 1);
    assert.equal(findForbiddenFilesystemWriteCapabilities(result).length, 1);
  });
});

test("negative control: TypeScript import-equals cannot acquire network or filesystem capabilities", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "bad-import-equals.ts"),
      [
        'import https = require("node:https");',
        'import fs = require("node:fs");',
        'export const capabilities = { https, fs };',
        '',
      ].join("\n"),
    );
    const result = scanProductionTree(dir);
    assert.equal(findForbiddenRuntimeBoundaryAccess(result).length, 1);
    assert.equal(findForbiddenFilesystemWriteCapabilities(result).length, 1);
  });
});

test("type-only HTTP exports and read-only fs re-exports acquire no runtime/write capability", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "ok-capability-types.ts"),
      [
        'import type { RequestOptions } from "node:https";',
        'export type { AgentOptions } from "node:https";',
        'export { readFileSync } from "node:fs";',
        'export type Combined = RequestOptions;',
        '',
      ].join("\n"),
    );
    const result = scanProductionTree(dir);
    assert.deepEqual(findForbiddenRuntimeBoundaryAccess(result), []);
    assert.deepEqual(findForbiddenFilesystemWriteCapabilities(result), []);
  });
});

test("negative control: globalThis.fetch is direct network capability outside an adapter", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "bad-global-fetch.ts"),
      'export const bypass = () => globalThis.fetch("https://anything.example.test");\n',
    );
    assert.equal(findForbiddenRuntimeBoundaryAccess(scanProductionTree(dir)).length, 1);
  });
});

test("negative control: bracket, alias, and destructured provider/recording env access cannot evade the boundary", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "bad-env-capability.ts"),
      [
        'const environment = process.env;',
        'const recording = environment["MEETING_RECORDING_KEY"];',
        'const { OPENAI_API_KEY: providerKey } = process.env;',
        'export { recording, providerKey };',
        '',
      ].join("\n"),
    );
    const violations = findForbiddenRuntimeBoundaryAccess(scanProductionTree(dir));
    assert.equal(violations.length, 2);
  });
});

test("negative control: a renamed Team Vault path cannot receive an fs write capability", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "bad-renamed-vault-capability.ts"),
      [
        'import fs from "node:fs";',
        'export function write(config: { dataPaths: { teamVaultDir: string } }) {',
        '  const immutablePublishedKnowledge = config.dataPaths.teamVaultDir;',
        '  fs.writeFileSync(immutablePublishedKnowledge + "/note.md", "no");',
        '}',
        '',
      ].join("\n"),
    );
    assert.equal(findForbiddenFilesystemWriteCapabilities(scanProductionTree(dir)).length, 2);
  });
});

test("negative control: statically computed TeamMem paths are recognized before a filesystem call", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "bad-computed-teammem-path.ts"),
      [
        'import { readFileSync } from "node:fs";',
        'const root = [".local", "share", "team" + "mem"].join("/");',
        'const ledger = ["led", "ger", ".db"].join("");',
        'export function bypass() { return readFileSync(root + "/" + ledger); }',
        '',
      ].join("\n"),
    );
    const violations = findForbiddenPathLiterals(scanProductionTree(dir).callArgumentLiterals);
    assert.equal(violations.length, 1);
  });
});

test("designated Runtime and Feishu adapters own direct network capability, and config alone may read a runtime endpoint", () => {
  withTempDir((dir) => {
    const adapters = path.join(dir, "src", "adapters");
    mkdirSync(adapters, { recursive: true });
    writeFileSync(
      path.join(adapters, "conversation-runtime-client.ts"),
      [
        'const send = globalThis.fetch;',
        'const endpoint = process.env["RUNTIME_ENDPOINT"];',
        'export async function call() { return send(endpoint ?? "https://runtime.example.test"); }',
        '',
      ].join("\n"),
    );
    writeFileSync(
      path.join(adapters, "feishu-api.ts"),
      [
        'import { request } from "node:https";',
        'export function call() { return request("https://open.feishu.example.test"); }',
        '',
      ].join("\n"),
    );
    writeFileSync(
      path.join(dir, "src", "config.ts"),
      'export const endpoint = process.env["RUNTIME_ENDPOINT"];\n',
    );
    assert.deepEqual(findForbiddenRuntimeBoundaryAccess(scanProductionTree(dir), dir), []);
  });
});

test("private child config writes and stdin do not grant general filesystem or provider capabilities", () => {
  withTempDir((dir) => {
    const adapters = path.join(dir, "src", "adapters"); mkdirSync(adapters, { recursive: true });
    const owner = path.join(adapters, "child-bridge-process.ts");
    writeFileSync(owner, 'import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs"; child.stdin!.write("control");');
    assert.deepEqual(findForbiddenFilesystemWriteCapabilities(scanProductionTree(dir), dir), []);
    writeFileSync(owner, 'import { write } from "node:fs"; write(1, "bad"); export const key = process.env.OPENAI_API_KEY;');
    assert.ok(findForbiddenFilesystemWriteCapabilities(scanProductionTree(dir), dir).length > 0);
    assert.ok(findForbiddenRuntimeBoundaryAccess(scanProductionTree(dir), dir).length > 0);
    writeFileSync(path.join(adapters, "team-vault-index.ts"), 'import { writeFileSync } from "node:fs"; child.stdin!.write("bad");');
    assert.ok(findForbiddenFilesystemWriteCapabilities(scanProductionTree(dir), dir).some((value) => value.file.endsWith("team-vault-index.ts")));
  });
});

test("application mkdir and filesystem outbox are explicit write owners, while the Vault index remains read-only", () => {
  withTempDir((dir) => {
    const adapters = path.join(dir, "src", "adapters");
    mkdirSync(adapters, { recursive: true });
    writeFileSync(
      path.join(dir, "src", "application.ts"),
      'import { mkdirSync } from "node:fs"; export const prepare = (dir: string) => mkdirSync(dir, { recursive: true });\n',
    );
    writeFileSync(
      path.join(adapters, "filesystem-outbox.ts"),
      'import { writeFileSync } from "node:fs"; export const publish = (file: string) => writeFileSync(file, "ok");\n',
    );
    writeFileSync(
      path.join(adapters, "team-vault-index.ts"),
      'import { readFileSync } from "node:fs"; export const read = (file: string) => readFileSync(file, "utf8");\n',
    );
    assert.deepEqual(findForbiddenFilesystemWriteCapabilities(scanProductionTree(dir), dir), []);
  });
});

// ---------------------------------------------------------------------------
// Catch-all: require() and computed dynamic import() bypass every
// specifier-based rule above silently unless flagged on their own.
// ---------------------------------------------------------------------------

test("src/ contains no require()/computed dynamic import that would bypass the scanner silently", () => {
  const { opaqueConstructs } = scanProductionTree(SRC_ROOT);
  const findings = findOpaqueConstructs(opaqueConstructs);
  assert.deepEqual(
    findings,
    [],
    `opaque require()/import() constructs found (need manual review):\n${findings
      .map((f) => `  ${f.file}: ${f.kind} -- ${f.snippet}`)
      .join("\n")}`,
  );
});

test("negative control: flags a require() call", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "bad-require.ts"),
      ['const openaiModule = require("openai");', "export { openaiModule };", ""].join("\n"),
    );
    const findings = findOpaqueConstructs(scanProductionTree(dir).opaqueConstructs);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.kind, "require_call");
  });
});

test("negative control: flags a computed dynamic import() argument", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "bad-computed-import.ts"),
      [
        'const moduleName = "openai";',
        "export function load() {",
        "  return import(moduleName);",
        "}",
        "",
      ].join("\n"),
    );
    const findings = findOpaqueConstructs(scanProductionTree(dir).opaqueConstructs);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.kind, "computed_dynamic_import");
  });
});

test("a literal dynamic import() is never flagged as opaque", () => {
  withTempDir((dir) => {
    writeFileSync(
      path.join(dir, "ok-dynamic-import.ts"),
      ["export function load() {", '  return import("zod");', "}", ""].join("\n"),
    );
    const findings = findOpaqueConstructs(scanProductionTree(dir).opaqueConstructs);
    assert.deepEqual(findings, []);
  });
});

// ---------------------------------------------------------------------------
// Layer 4: the SQLite dependency gate. Written so it survives Task 3, which
// will add better-sqlite3 as a real dependency for the orchestration store:
// the sanctioned driver is allowed, but only src/adapters/sqlite-session-
// store.ts may import it, and no other SQLite-shaped package may appear in
// package.json at all.
// ---------------------------------------------------------------------------

test("the repo's own package.json declares no forbidden SQLite dependency today", () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as PackageJsonLike;
  const forbidden = findForbiddenSqliteDependencies(pkg);
  assert.deepEqual(forbidden, []);
});

test("src/ imports no SQLite driver outside the sanctioned orchestration adapter today", () => {
  const imports = collectImports(SRC_ROOT);
  const violations = findUnconfinedSqliteImports(imports, REPO_ROOT);
  assert.deepEqual(violations, []);
});

test("negative control: flags a forbidden SQLite dependency in package.json (sqlite3 alongside the sanctioned driver)", () => {
  const pkg: PackageJsonLike = {
    dependencies: { "better-sqlite3": "^11.0.0", sqlite3: "^5.0.0" },
  };
  const forbidden = findForbiddenSqliteDependencies(pkg);
  assert.deepEqual(forbidden, ["sqlite3"]);
});

test("the sanctioned SQLite dependency alone is never flagged by the dependency gate", () => {
  const pkg: PackageJsonLike = { dependencies: { "better-sqlite3": "^11.0.0" } };
  assert.deepEqual(findForbiddenSqliteDependencies(pkg), []);
});

test("the sanctioned driver's own @types package is never flagged, even though its name matches /sqlite/i", () => {
  const pkg: PackageJsonLike = {
    dependencies: { "better-sqlite3": "^13.0.0" },
    devDependencies: { "@types/better-sqlite3": "^9.6.0" },
  };
  assert.deepEqual(findForbiddenSqliteDependencies(pkg), []);
});

test("negative control: a DIFFERENT @types/*sqlite* package is still flagged (the exception names one exact package)", () => {
  const pkg: PackageJsonLike = {
    dependencies: { "better-sqlite3": "^13.0.0" },
    devDependencies: { "@types/sqlite3": "^3.1.0" },
  };
  assert.deepEqual(findForbiddenSqliteDependencies(pkg), ["@types/sqlite3"]);
});

test("negative control: flags better-sqlite3 imported from outside the sanctioned adapter", () => {
  const repoRoot = "/repo";
  const records = [
    { file: "/repo/src/sessions/coordinator.ts", specifier: "better-sqlite3" },
  ];
  const violations = findUnconfinedSqliteImports(records, repoRoot);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.file, "/repo/src/sessions/coordinator.ts");
});

test("better-sqlite3 imported from the sanctioned adapter file is never flagged", () => {
  const repoRoot = "/repo";
  const records = [
    { file: "/repo/src/adapters/sqlite-session-store.ts", specifier: "better-sqlite3" },
  ];
  const violations = findUnconfinedSqliteImports(records, repoRoot);
  assert.deepEqual(violations, []);
});
