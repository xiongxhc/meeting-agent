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
  readonly method: string;
};

export type CapabilityUse = {
  readonly file: string;
  readonly capability: string;
  readonly snippet: string;
};

export type EnvironmentAccess = {
  readonly file: string;
  /** The statically-known variable name, or null for an opaque computed key. */
  readonly key: string | null;
  readonly text: string;
};

export type ScanResult = {
  readonly imports: ImportRecord[];
  readonly callArgumentLiterals: CallArgumentLiteral[];
  readonly opaqueConstructs: OpaqueConstruct[];
  readonly writeLikeCalls: WriteLikeCall[];
  /** Every direct network capability use, independent of its endpoint text. */
  readonly runtimeBoundaryCalls: CapabilityUse[];
  /** fs write-capability imports; namespace/default imports are broad capability. */
  readonly fsWriteCapabilityImports: CapabilityUse[];
  readonly environmentAccesses: EnvironmentAccess[];
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
  "mkdir",
  "mkdirSync",
]);

const NETWORK_MODULES = new Set([
  "@larksuiteoapi/node-sdk", "ws",
  "node:http",
  "node:https",
  "http",
  "https",
  "undici",
  "axios",
  "got",
  "node-fetch",
]);
const NETWORK_METHOD_NAMES = new Set(["fetch", "request", "get", "post", "put", "delete", "patch"]);
const FS_MODULES = new Set(["node:fs", "node:fs/promises", "fs", "fs/promises"]);

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
    runtimeBoundaryCalls: [],
    fsWriteCapabilityImports: [],
    environmentAccesses: [],
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
    visit(sourceFile, sourceFile, file, result, createFileContext());
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
  context: FileScanContext,
): void {
  recordImportCapabilities(node, sourceFile, file, result, context);
  recordStaticBindings(node, sourceFile, file, result, context);
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
      if (NETWORK_MODULES.has(arg.text)) result.runtimeBoundaryCalls.push({file,capability:`dynamic-import:${arg.text}`,snippet:snippetOf(node,sourceFile)});
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

    for (const arg of node.arguments) recordStaticCallArgument(arg, file, result, context);

    const calleeName = lastCalleeSegment(node.expression);
    if (calleeName !== null && WRITE_LIKE_METHOD_NAMES.has(calleeName)) {
      result.writeLikeCalls.push({
        file,
        calleeText: node.expression.getText(sourceFile),
        argumentsText: node.arguments.map((a) => a.getText(sourceFile)).join(", "),
        method: calleeName,
      });
    }
    if (isNetworkCall(node.expression, context)) {
      result.runtimeBoundaryCalls.push({
        file,
        capability: node.expression.getText(sourceFile),
        snippet: snippetOf(node, sourceFile),
      });
    }
  }

  recordEnvironmentAccess(node, sourceFile, file, result, context);

  ts.forEachChild(node, (child) => visit(child, sourceFile, file, result, context));
}

type FileScanContext = {
  readonly networkAliases: Set<string>;
  readonly networkNamespaces: Set<string>;
  readonly environmentAliases: Map<string, string | null>;
  readonly staticStrings: Map<string, string>;
};

function createFileContext(): FileScanContext {
  return {
    networkAliases: new Set(["fetch"]),
    networkNamespaces: new Set(),
    environmentAliases: new Map(),
    staticStrings: new Map(),
  };
}

function recordImportCapabilities(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  file: string,
  result: ScanResult,
  context: FileScanContext,
): void {
  if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
    const specifier = node.moduleSpecifier.text;
    const clause = node.importClause;
    if (!clause && NETWORK_MODULES.has(specifier)) result.runtimeBoundaryCalls.push({file,capability:`import:${specifier}`,snippet:snippetOf(node,sourceFile)});
    if (!clause || clause.isTypeOnly) return;
    const bindings = clause.namedBindings;
    const valueImports = bindings && ts.isNamedImports(bindings)
      ? bindings.elements.filter((item) => !item.isTypeOnly)
      : [];
    const hasRuntimeBinding = clause.name !== undefined ||
      (bindings !== undefined && ts.isNamespaceImport(bindings)) || valueImports.length > 0;

    if (NETWORK_MODULES.has(specifier) && hasRuntimeBinding) {
      if (clause.name) context.networkNamespaces.add(clause.name.text);
      if (bindings && ts.isNamespaceImport(bindings)) context.networkNamespaces.add(bindings.name.text);
      for (const item of valueImports) {
        if (NETWORK_METHOD_NAMES.has(item.propertyName?.text ?? item.name.text)) {
          context.networkAliases.add(item.name.text);
        }
      }
      result.runtimeBoundaryCalls.push({ file, capability: `import:${specifier}`, snippet: snippetOf(node, sourceFile) });
    }
    for (const item of valueImports) {
      const imported = item.propertyName?.text ?? item.name.text;
      if (imported === "fetch" || imported === "request") context.networkAliases.add(item.name.text);
    }
    if (!FS_MODULES.has(specifier)) return;
    if (clause.name || (bindings && ts.isNamespaceImport(bindings))) {
      result.fsWriteCapabilityImports.push({ file, capability: "*", snippet: snippetOf(node, sourceFile) });
    }
    for (const item of valueImports) {
      const imported = item.propertyName?.text ?? item.name.text;
      if (WRITE_LIKE_METHOD_NAMES.has(imported)) {
        result.fsWriteCapabilityImports.push({ file, capability: imported, snippet: snippetOf(node, sourceFile) });
      }
    }
    return;
  }

  if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
    if (node.isTypeOnly) return;
    const specifier = node.moduleSpecifier.text;
    const clause = node.exportClause;
    const valueExports = clause && ts.isNamedExports(clause)
      ? clause.elements.filter((item) => !item.isTypeOnly)
      : [];
    const exportsRuntimeValue = clause === undefined || ts.isNamespaceExport(clause) || valueExports.length > 0;
    if (NETWORK_MODULES.has(specifier) && exportsRuntimeValue) {
      result.runtimeBoundaryCalls.push({ file, capability: `export:${specifier}`, snippet: snippetOf(node, sourceFile) });
    }
    if (!FS_MODULES.has(specifier)) return;
    if (clause === undefined || ts.isNamespaceExport(clause)) {
      result.fsWriteCapabilityImports.push({ file, capability: "*", snippet: snippetOf(node, sourceFile) });
      return;
    }
    for (const item of valueExports) {
      const exported = item.propertyName?.text ?? item.name.text;
      if (WRITE_LIKE_METHOD_NAMES.has(exported)) {
        result.fsWriteCapabilityImports.push({ file, capability: exported, snippet: snippetOf(node, sourceFile) });
      }
    }
    return;
  }

  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
    ts.isStringLiteralLike(node.moduleReference.expression)) {
    const specifier = node.moduleReference.expression.text;
    if (NETWORK_MODULES.has(specifier)) {
      context.networkNamespaces.add(node.name.text);
      result.runtimeBoundaryCalls.push({ file, capability: `import-equals:${specifier}`, snippet: snippetOf(node, sourceFile) });
    }
    if (FS_MODULES.has(specifier)) {
      result.fsWriteCapabilityImports.push({ file, capability: "*", snippet: snippetOf(node, sourceFile) });
    }
  }
}

function recordStaticBindings(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  file: string,
  result: ScanResult,
  context: FileScanContext,
): void {
  if (!ts.isVariableDeclaration(node) || !node.initializer) return;
  if (ts.isIdentifier(node.name)) {
    const value = staticString(node.initializer, context);
    if (value !== null) context.staticStrings.set(node.name.text, value);
    if (isProcessEnvironment(node.initializer, context)) context.environmentAliases.set(node.name.text, null);
    if (isNetworkExpression(node.initializer, context)) context.networkAliases.add(node.name.text);
    return;
  }
  if (!ts.isObjectBindingPattern(node.name) || !isProcessEnvironment(node.initializer, context)) return;
  for (const element of node.name.elements) {
    if (ts.isIdentifier(element.name)) {
      const key = bindingPropertyName(element, context);
      context.environmentAliases.set(element.name.text, key);
      result.environmentAccesses.push({ file, key, text: element.getText(sourceFile) });
    }
  }
}

function isNetworkCall(expression: ts.Expression, context: FileScanContext): boolean {
  if (ts.isIdentifier(expression)) return context.networkAliases.has(expression.text);
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return false;
  const method = ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : staticString(expression.argumentExpression, context);
  if (method === null || !NETWORK_METHOD_NAMES.has(method)) return false;
  return (ts.isIdentifier(expression.expression) && context.networkNamespaces.has(expression.expression.text)) ||
    (method === "fetch" && ts.isIdentifier(expression.expression) && expression.expression.text === "globalThis");
}

function isNetworkExpression(expression: ts.Expression, context: FileScanContext): boolean {
  if (ts.isIdentifier(expression)) return context.networkAliases.has(expression.text);
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return false;
  const method = ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : staticString(expression.argumentExpression, context);
  if (method === null || !NETWORK_METHOD_NAMES.has(method)) return false;
  if (ts.isIdentifier(expression.expression) && context.networkNamespaces.has(expression.expression.text)) return true;
  if (method === "fetch" && ts.isIdentifier(expression.expression) && expression.expression.text === "globalThis") return true;
  return false;
}

function recordEnvironmentAccess(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  file: string,
  result: ScanResult,
  context: FileScanContext,
): void {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return;
  if (!isProcessEnvironment(node.expression, context)) return;
  const key = ts.isPropertyAccessExpression(node)
    ? node.name.text
    : staticString(node.argumentExpression, context);
  // `process.env` itself is an environment object, not a secret lookup.
  result.environmentAccesses.push({ file, key, text: node.getText(sourceFile) });
}

function isProcessEnvironment(expression: ts.Expression, context: FileScanContext): boolean {
  if (ts.isIdentifier(expression)) return context.environmentAliases.has(expression.text);
  if (ts.isParenthesizedExpression(expression)) return isProcessEnvironment(expression.expression, context);
  if (ts.isBinaryExpression(expression) &&
    (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
    return isProcessEnvironment(expression.left, context) || isProcessEnvironment(expression.right, context);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return ts.isIdentifier(expression.expression) && expression.expression.text === "process" && expression.name.text === "env";
  }
  if (ts.isElementAccessExpression(expression)) {
    return ts.isIdentifier(expression.expression) && expression.expression.text === "process" &&
      staticString(expression.argumentExpression, context) === "env";
  }
  return false;
}

function bindingPropertyName(element: ts.BindingElement, context: FileScanContext): string | null {
  if (!element.propertyName) return ts.isIdentifier(element.name) ? element.name.text : null;
  if (ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName)) return element.propertyName.text;
  if (ts.isComputedPropertyName(element.propertyName)) return staticString(element.propertyName.expression, context);
  return null;
}

function staticString(expression: ts.Expression | undefined, context: FileScanContext): string | null {
  if (!expression) return null;
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isIdentifier(expression)) return context.staticStrings.get(expression.text) ?? null;
  if (ts.isParenthesizedExpression(expression)) return staticString(expression.expression, context);
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(expression.left, context);
    const right = staticString(expression.right, context);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === "join") {
    const receiver = expression.expression.expression;
    if (!ts.isArrayLiteralExpression(receiver)) return null;
    const pieces = receiver.elements.map((element) =>
      ts.isExpression(element) ? staticString(element, context) : null,
    );
    const separator = staticString(expression.arguments[0], context);
    return separator === null || pieces.some((piece) => piece === null) ? null : pieces.join(separator);
  }
  return null;
}

function recordStaticCallArgument(
  argument: ts.Expression,
  file: string,
  result: ScanResult,
  context: FileScanContext,
): void {
  const value = staticString(argument, context);
  if (value !== null) result.callArgumentLiterals.push({ file, value });
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

const LOCAL_MEETING_CONTRACT_IMPORTS = new Set([
  "../contracts/teammem-meeting-v1.ts",
  "./teammem-meeting-v1.ts",
  "../contracts/teammem-meeting-v2.ts",
  "./contracts/teammem-meeting-v2.ts",
  "./teammem-meeting-v2.ts",
]);

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
      (!LOCAL_MEETING_CONTRACT_IMPORTS.has(specifier) && /team-?mem/i.test(specifier)) ||
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
 * scans every statically resolvable call argument in the tree, including
 * constant aliases and string construction, while staying tied to actual path
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

/** Explicit owners of filesystem writes. The application may create its own
 * outbox directory; the future outbox adapter owns durable publication. No
 * Team Vault module appears here, so its read-only git index cannot gain an
 * fs write capability by renaming a path variable. */
export const WRITE_CAPABILITY_OWNERS: Readonly<Record<string, ReadonlySet<string>>> = {
  "src/adapters/child-bridge-process.ts": new Set(["mkdtempSync", "writeFileSync", "unlinkSync", "rmdirSync"]),
  "src/application.ts": new Set(["mkdir", "mkdirSync"]),
  "src/adapters/filesystem-outbox.ts": new Set([
    "appendFile", "appendFileSync", "createWriteStream", "mkdir", "mkdirSync", "rm", "rmSync", "rmdirSync", "writeFile", "writeFileSync",
  ]),
};

/** Direct HTTP is an adapter capability, never an endpoint-text exception. */
export const NETWORK_CAPABILITY_OWNERS = new Set([
  "src/adapters/feishu-sdk-http.ts",
  "src/adapters/feishu-sdk-connection.ts",
  "src/adapters/feishu-invite-ingress.ts",
  "src/adapters/feishu-organizer-metadata.ts",
  "src/adapters/conversation-runtime-client.ts",
  "src/adapters/feishu-api.ts",
]);

export function findForbiddenFilesystemWriteCapabilities(result: ScanResult, repoRoot?: string): Violation[] {
  const violations: Violation[] = [];
  for (const use of result.fsWriteCapabilityImports) {
    if (!allowsWriteCapability(use.file, use.capability, repoRoot)) {
      violations.push({ file: use.file, specifier: use.capability, rule: "filesystem write capability outside approved owner" });
    }
  }
  for (const call of result.writeLikeCalls) {
    if (call.calleeText === "child.stdin!.write" && repoRoot !== undefined && normalizeRelative(path.relative(repoRoot, call.file)) === "src/adapters/child-bridge-process.ts") continue;
    if (!allowsWriteCapability(call.file, call.method, repoRoot)) {
      violations.push({ file: call.file, specifier: call.calleeText, rule: "filesystem write capability outside approved owner" });
    }
  }
  return violations;
}

/** Direct network capability and secret-bearing environment access are
 * ownership checks. A URL's spelling can never grant a production module a
 * capability it does not own. Runtime endpoint configuration is narrowly
 * allowed in config/runtime adapter; recording keys are never allowed. */
export function findForbiddenRuntimeBoundaryAccess(result: ScanResult, repoRoot?: string): Violation[] {
  const violations: Violation[] = [];
  for (const call of result.runtimeBoundaryCalls) {
    const relative = repoRoot === undefined ? "" : normalizeRelative(path.relative(repoRoot,call.file));
    if (call.capability.endsWith(":@larksuiteoapi/node-sdk") && !["src/adapters/feishu-sdk-http.ts","src/adapters/feishu-invite-ingress.ts","src/adapters/feishu-organizer-metadata.ts"].includes(relative)) {
      violations.push({file:call.file,specifier:call.capability,rule:"SDK value capability outside exact Feishu adapter"}); continue;
    }
    if (call.capability.endsWith(":ws")) {
      violations.push({file:call.file,specifier:call.capability,rule:"direct WebSocket is test-only"}); continue;
    }
    if (!allowsNetworkCapability(call.file, repoRoot)) {
      violations.push({ file: call.file, specifier: call.capability, rule: "direct network capability outside designated adapter" });
    }
  }
  for (const access of result.environmentAccesses) {
    if (access.key !== null && /(?:RECORDING.*KEY|KEY.*RECORDING)/i.test(access.key)) {
      violations.push({ file: access.file, specifier: access.text, rule: "recording-key environment access is forbidden" });
    } else if (access.key !== null && /(?:OPENAI|PROVIDER).*(?:KEY|TOKEN|SECRET)?|(?:KEY|TOKEN|SECRET).*(?:OPENAI|PROVIDER)/i.test(access.key)) {
      violations.push({ file: access.file, specifier: access.text, rule: "provider credential environment access is forbidden" });
    } else if (access.key !== null && /(?:RUNTIME|PROVIDER).*(?:ENDPOINT|URL)|(?:ENDPOINT|URL).*(?:RUNTIME|PROVIDER)/i.test(access.key)) {
      if (!allowsRuntimeConfiguration(access.file, repoRoot)) {
        violations.push({ file: access.file, specifier: access.text, rule: "runtime/provider endpoint environment access outside config/runtime adapter" });
      }
    } else if (access.key === null && !allowsRuntimeConfiguration(access.file, repoRoot)) {
      violations.push({ file: access.file, specifier: access.text, rule: "opaque environment key access outside config/runtime adapter" });
    }
  }
  return violations;
}

function allowsWriteCapability(file: string, capability: string, repoRoot?: string): boolean {
  if (!repoRoot) return false;
  const allowed = WRITE_CAPABILITY_OWNERS[normalizeRelative(path.relative(repoRoot, file))];
  return allowed?.has(capability) ?? false;
}

function allowsNetworkCapability(file: string, repoRoot?: string): boolean {
  return repoRoot !== undefined && NETWORK_CAPABILITY_OWNERS.has(normalizeRelative(path.relative(repoRoot, file)));
}

function allowsRuntimeConfiguration(file: string, repoRoot?: string): boolean {
  if (!repoRoot) return false;
  const relative = normalizeRelative(path.relative(repoRoot, file));
  return relative === "src/config.ts" || relative === "src/adapters/conversation-runtime-client.ts";
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
    // This gate confines the *driver*, not every local module whose filename
    // happens to describe the store.  The application composition is allowed
    // to import the store adapter; only importing better-sqlite3 itself would
    // leak the database driver past that adapter boundary.
    .filter((record) => record.specifier === SANCTIONED_SQLITE_DEPENDENCY)
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
