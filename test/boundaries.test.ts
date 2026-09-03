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

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { collectImports, findViolations } from "./lib/import-scanner.ts";

const SRC_ROOT = path.resolve(import.meta.dirname, "..", "src");

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
