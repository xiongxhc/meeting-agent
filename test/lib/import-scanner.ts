// Test infrastructure for test/boundaries.test.ts. Not itself a *.test.ts file,
// so `npm test`'s glob does not pick it up as a suite.
//
// Recursively walks a directory tree, parses every production TypeScript file
// with the TypeScript compiler API, and extracts every static import, static
// export-from, dynamic import(), and `import =` module specifier it finds.
// Parsing (rather than grepping) means the scan survives reformatting,
// comments, and string literals that merely mention a forbidden name.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export type ImportRecord = {
  readonly file: string;
  readonly specifier: string;
};

const SKIP_DIRS = new Set(["node_modules", "dist", ".build"]);

/**
 * Recursively discovers every `.ts` production source file under `rootDir`
 * (excluding `*.test.ts` and the directories in SKIP_DIRS) and returns every
 * import/export/dynamic-import module specifier found in each.
 */
export function collectImports(rootDir: string): ImportRecord[] {
  const records: ImportRecord[] = [];
  for (const file of walkTsFiles(rootDir)) {
    const source = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      ts.ScriptKind.TS,
    );
    visit(sourceFile, file, records);
  }
  return records;
}

function* walkTsFiles(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      yield* walkTsFiles(full);
      continue;
    }
    if (!info.isFile()) continue;
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    yield full;
  }
}

function visit(node: ts.Node, file: string, records: ImportRecord[]): void {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    records.push({ file, specifier: node.moduleSpecifier.text });
  } else if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    ts.isStringLiteralLike(node.moduleReference.expression)
  ) {
    records.push({ file, specifier: node.moduleReference.expression.text });
  } else if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword
  ) {
    const arg = node.arguments[0];
    if (arg && ts.isStringLiteralLike(arg)) {
      records.push({ file, specifier: arg.text });
    }
  }
  ts.forEachChild(node, (child) => visit(child, file, records));
}

export type ForbiddenRule = {
  readonly name: string;
  readonly matches: (specifier: string) => boolean;
};

/**
 * The four import shapes the spec forbids absolutely for Meeting Agent
 * production code (see LANE-CONSTRAINTS.md and the design spec's ownership
 * table): the OpenAI SDK, any TeamMem Python/module path, TeamMem's SQLite
 * ledger file, and any Team Vault write helper.
 */
export const FORBIDDEN_IMPORT_RULES: readonly ForbiddenRule[] = [
  {
    name: "OpenAI SDK",
    matches: (specifier) => /^openai(\/|$)/i.test(specifier),
  },
  {
    name: "TeamMem Python/module path",
    matches: (specifier) =>
      /team-?mem/i.test(specifier) ||
      /team-memory-agent/i.test(specifier) ||
      /\.py$/i.test(specifier),
  },
  {
    name: "TeamMem SQLite ledger file",
    matches: (specifier) => /ledger\.db/i.test(specifier),
  },
  {
    name: "Team Vault write helper",
    matches: (specifier) => /vault[-_]?writ/i.test(specifier),
  },
];

export type Violation = ImportRecord & { readonly rule: string };

export function findViolations(
  records: readonly ImportRecord[],
  rules: readonly ForbiddenRule[] = FORBIDDEN_IMPORT_RULES,
): Violation[] {
  const violations: Violation[] = [];
  for (const record of records) {
    for (const rule of rules) {
      if (rule.matches(record.specifier)) {
        violations.push({ ...record, rule: rule.name });
      }
    }
  }
  return violations;
}
