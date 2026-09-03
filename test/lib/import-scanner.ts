// Test infrastructure for test/boundaries.test.ts. Not itself a *.test.ts file,
// so `npm test`'s glob does not pick it up as a suite.
//
// Recursively walks a directory tree and parses every production TypeScript
// file with the TypeScript compiler API (not a grep), collecting four kinds
// of structural evidence in one pass:
//   - imports:            module specifiers on import/export-from/import=/
//                          literal-argument dynamic import()
//   - callArgumentLiterals: every string-literal argument passed to any call
//                          expression, wherever it appears (catches a path
//                          fragment buried inside `path.join(...)` or handed
//                          straight to a driver constructor -- not just an
//                          import specifier)
//   - opaqueConstructs:    `require(...)` calls and dynamic `import(expr)`
//                          calls whose argument is not a string literal --
//                          constructs the specifier-based checks below
//                          cannot see into, and which must not be allowed to
//                          silently pass
//   - writeLikeCalls:      calls to a writable fs-shaped method (writeFile,
//                          rm, createWriteStream, ...), with the raw source
//                          text of their arguments, so a caller can check
//                          whether a forbidden value (e.g. the Team Vault
//                          directory) reaches a write

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export type ImportRecord = {
  readonly file: string;
  readonly specifier: string;
};

export type CallArgumentLiteral = {
  readonly file: string;
  readonly value: string;
};

export type OpaqueConstruct = {
  readonly file: string;
  readonly kind: "require_call" | "computed_dynamic_import";
  readonly snippet: string;
};

export type WriteLikeCall = {
  readonly file: string;
  readonly calleeText: string;
  readonly argumentsText: string;
};

export type ScanResult = {
  readonly imports: ImportRecord[];
  readonly callArgumentLiterals: CallArgumentLiteral[];
  readonly opaqueConstructs: OpaqueConstruct[];
  readonly writeLikeCalls: WriteLikeCall[];
};

const SKIP_DIRS = new Set(["node_modules", "dist", ".build"]);

const WRITE_LIKE_METHOD_NAMES = new Set([
  "write",
  "writeSync",
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "unlink",
  "unlinkSync",
  "createWriteStream",
]);

const MAX_SNIPPET_LENGTH = 240;

/**
 * Recursively discovers every `.ts` production source file under `rootDir`
 * (excluding `*.test.ts` and the directories in SKIP_DIRS) and scans each in
 * a single AST pass for imports, call-argument string literals, opaque
 * require()/computed-import constructs, and writable-fs-shaped calls.
 */
export function scanProductionTree(rootDir: string): ScanResult {
  const result: ScanResult = {
    imports: [],
    callArgumentLiterals: [],
    opaqueConstructs: [],
    writeLikeCalls: [],
  };
  for (const file of walkTsFiles(rootDir)) {
    const source = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      ts.ScriptKind.TS,
    );
    visit(sourceFile, sourceFile, file, result);
  }
  return result;
}

/** Backward-compatible convenience wrapper: import/export specifiers only. */
export function collectImports(rootDir: string): ImportRecord[] {
  return scanProductionTree(rootDir).imports;
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

function visit(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  file: string,
  result: ScanResult,
): void {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    result.imports.push({ file, specifier: node.moduleSpecifier.text });
  } else if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    ts.isStringLiteralLike(node.moduleReference.expression)
  ) {
    result.imports.push({ file, specifier: node.moduleReference.expression.text });
  } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const arg = node.arguments[0];
    if (arg && ts.isStringLiteralLike(arg)) {
      result.imports.push({ file, specifier: arg.text });
    } else {
      result.opaqueConstructs.push({
        file,
        kind: "computed_dynamic_import",
        snippet: snippetOf(node, sourceFile),
      });
    }
  } else if (ts.isCallExpression(node)) {
    if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
      result.opaqueConstructs.push({
        file,
        kind: "require_call",
        snippet: snippetOf(node, sourceFile),
      });
    }

    for (const arg of node.arguments) {
      if (ts.isStringLiteralLike(arg)) {
        result.callArgumentLiterals.push({ file, value: arg.text });
      }
    }

    const calleeName = lastCalleeSegment(node.expression);
    if (calleeName !== null && WRITE_LIKE_METHOD_NAMES.has(calleeName)) {
      result.writeLikeCalls.push({
        file,
        calleeText: node.expression.getText(sourceFile),
        argumentsText: node.arguments.map((a) => a.getText(sourceFile)).join(", "),
      });
    }
  }

  ts.forEachChild(node, (child) => visit(child, sourceFile, file, result));
}

function lastCalleeSegment(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function snippetOf(node: ts.Node, sourceFile: ts.SourceFile): string {
  const text = node.getText(sourceFile);
  return text.length > MAX_SNIPPET_LENGTH ? `${text.slice(0, MAX_SNIPPET_LENGTH)}...` : text;
}

export type ForbiddenRule = {
  readonly name: string;
  readonly matches: (specifier: string) => boolean;
};

/**
 * The import-specifier layer: cheap, but only sees a violation that takes the
 * shape of an actual import. See findForbiddenPathLiterals and
 * findTeamVaultWriteAttempts below for the call-argument layer that catches
 * a violation reached through a driver call or a path-building helper
 * instead of a bare import.
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

export type Violation = {
  readonly file: string;
  readonly specifier: string;
  readonly rule: string;
};

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

/**
 * Path fragments that identify TeamMem's live SQLite ledger or its private
 * data directories, wherever a string literal carrying one appears as a call
 * argument -- not only as an import specifier. Narrower than the
 * import-specifier "TeamMem Python/module path" rule on purpose: this layer
 * scans every call-argument string literal in the tree, a much bigger
 * surface than import specifiers, so the patterns stay tied to actual path
 * shapes rather than the bare word "teammem" (which could appear in ordinary
 * domain vocabulary, e.g. a "TeamMember" type, without ever naming a path).
 */
export const TEAMMEM_PATH_FRAGMENT_PATTERNS: readonly RegExp[] = [
  /ledger\.db/i,
  /\.local\/share\/teammem/i,
  /\.config\/teammem/i,
  /team-memory-agent-overlay/i,
  /team-memory-agent\//i,
];

export function findForbiddenPathLiterals(
  literals: readonly CallArgumentLiteral[],
  patterns: readonly RegExp[] = TEAMMEM_PATH_FRAGMENT_PATTERNS,
): Violation[] {
  const violations: Violation[] = [];
  for (const literal of literals) {
    if (patterns.some((pattern) => pattern.test(literal.value))) {
      violations.push({
        file: literal.file,
        specifier: literal.value,
        rule: "TeamMem ledger/data path literal in a call argument",
      });
    }
  }
  return violations;
}

/**
 * A `require(...)` call or a dynamic `import(expr)` whose argument is not a
 * string literal is invisible to every specifier-based check above -- the
 * scanner cannot know what module it resolves to. Rather than silently
 * passing, any such construct in production code is itself the finding: it
 * requires a human to look at the file and confirm what it actually loads.
 */
export function findOpaqueConstructs(
  constructs: readonly OpaqueConstruct[],
): readonly OpaqueConstruct[] {
  return constructs;
}

/**
 * The Team Vault field name this scan treats as forbidden to reach a write.
 * Meeting Agent's config surface (src/config.ts) names this field
 * `dataPaths.teamVaultDir`; Task 6 builds a read-only index over it and nothes
 * else may hold a path derived from it in a write-shaped call.
 *
 * This is a name-based heuristic (it checks whether the call's argument
 * source text contains this identifier), not full data-flow analysis: it
 * catches `fs.writeFileSync(config.dataPaths.teamVaultDir + "/x.md", ...)`
 * and `fs.writeFileSync(teamVaultDir, ...)` alike, because both mention the
 * field/variable by name in the call's argument text, but it would not catch
 * the value being renamed to something unrelated before reaching a write.
 * That's an accepted, documented limit -- the convention is to always carry
 * the name through, exactly as `config.dataPaths.teamVaultDir` already does.
 */
export const TEAM_VAULT_DIR_FIELD_NAME = "teamVaultDir";

export function findTeamVaultWriteAttempts(
  calls: readonly WriteLikeCall[],
  marker: string = TEAM_VAULT_DIR_FIELD_NAME,
): Violation[] {
  return calls
    .filter((call) => call.argumentsText.includes(marker))
    .map((call) => ({
      file: call.file,
      specifier: call.calleeText,
      rule: "writable fs call reachable from the Team Vault directory",
    }));
}

/**
 * The dependency-level gate: no SQLite driver other than the one sanctioned
 * for Meeting Agent's own orchestration database may appear in package.json,
 * and even the sanctioned one may only be imported from the one adapter file
 * that owns it. A dependency-list check can't be evaded by renaming a
 * variable the way a specifier-only import check can be, and confining the
 * import keeps this rule meaningful once Task 3 actually adds
 * better-sqlite3 as a real dependency -- it survives Task 3 instead of being
 * deleted by it.
 */
export const SANCTIONED_SQLITE_DEPENDENCY = "better-sqlite3";
export const SANCTIONED_SQLITE_IMPORTER_RELATIVE_PATH = "src/adapters/sqlite-session-store.ts";

// The runtime driver's own @types/* package is not itself a SQLite
// dependency -- it ships no code, only ambient type declarations for the
// sanctioned driver above -- so it is named explicitly here rather than
// widening the /sqlite/i match itself. Any OTHER SQLite-shaped package
// (sqlite3, node:sqlite polyfills, @types/sqlite3, ...) is still caught.
export const SANCTIONED_SQLITE_TYPES_DEPENDENCY = "@types/better-sqlite3";

export type PackageJsonLike = {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
};

export function findForbiddenSqliteDependencies(pkg: PackageJsonLike): string[] {
  const names = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];
  const allowed: ReadonlySet<string> = new Set([
    SANCTIONED_SQLITE_DEPENDENCY,
    SANCTIONED_SQLITE_TYPES_DEPENDENCY,
  ]);
  return names.filter((name) => /sqlite/i.test(name) && !allowed.has(name));
}

export function findUnconfinedSqliteImports(
  records: readonly ImportRecord[],
  repoRoot: string,
): Violation[] {
  return records
    .filter((record) => /sqlite/i.test(record.specifier))
    .filter(
      (record) =>
        normalizeRelative(path.relative(repoRoot, record.file)) !==
        SANCTIONED_SQLITE_IMPORTER_RELATIVE_PATH,
    )
    .map((record) => ({
      ...record,
      rule: "SQLite driver imported outside the sanctioned orchestration adapter",
    }));
}

function normalizeRelative(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}
