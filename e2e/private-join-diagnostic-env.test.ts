import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";

// Execute the actual entry-spawn env expression. Parsing only identifies the
// expression; no app, SDK client, import of run.mjs or child process is started.
function projectedEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const filename = fileURLToPath(new URL("./run.mjs", import.meta.url));
  const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "spawn" &&
      node.arguments[1] && ts.isArrayLiteralExpression(node.arguments[1]) && node.arguments[1].elements[0]?.getText(source) === "staged.entryPath") {
      const options = node.arguments[2];
      if (options && ts.isObjectLiteralExpression(options)) {
        const property = options.properties.find((item) => ts.isPropertyAssignment(item) && item.name.getText(source) === "env");
        if (property && ts.isPropertyAssignment(property)) expression = property.initializer;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(expression, "entry spawn must have a projected environment");
  return runInNewContext(`(${expression.getText(source)})`, {
    process: { env }, staged: { directories: { traceBin: "/synthetic/trace" } },
  }) as Record<string, string | undefined>;
}

const base = { HOME: "/synthetic/home", TMPDIR: "/synthetic/tmp", PATH: "/untrusted/path", LANG: "untrusted", UNRELATED_PRIVATE_TOKEN: "synthetic-only" };

test("the actual entry spawn forwards only the nominated private diagnostic variable", () => {
  const env = { ...base, MEETING_PRIVATE_JOIN_DIAGNOSTIC_DIR: "/synthetic/diagnostic" };
  const actual = projectedEnvironment(env);
  assert.equal(actual.MEETING_PRIVATE_JOIN_DIAGNOSTIC_DIR === env.MEETING_PRIVATE_JOIN_DIAGNOSTIC_DIR, true);
  assert.deepEqual(Object.keys(actual).sort(), ["HOME", "LANG", "MEETING_PRIVATE_JOIN_DIAGNOSTIC_DIR", "PATH", "TMPDIR"]);
  assert.equal(Object.hasOwn(actual, "UNRELATED_PRIVATE_TOKEN"), false);
});

test("absent diagnostic input preserves the original exact allowlist and values", () => {
  const actual = projectedEnvironment(base);
  assert.deepEqual(Object.keys(actual).sort(), ["HOME", "LANG", "PATH", "TMPDIR"]);
  assert.equal(actual.HOME === base.HOME, true);
  assert.equal(actual.TMPDIR === base.TMPDIR, true);
  assert.equal(actual.PATH === "/synthetic/trace:/opt/homebrew/opt/node@24/bin:/usr/bin:/bin", true);
  assert.equal(actual.LANG === "C.UTF-8", true);
});

test("undefined diagnostic input stays absent and missing TMPDIR keeps the original fallback", () => {
  const actual = projectedEnvironment({ HOME: base.HOME, MEETING_PRIVATE_JOIN_DIAGNOSTIC_DIR: undefined });
  assert.deepEqual(Object.keys(actual).sort(), ["HOME", "LANG", "PATH", "TMPDIR"]);
  assert.equal(actual.TMPDIR === "/tmp", true);
});

test("defined diagnostic input is forwarded exactly even when the helper later refuses its shape", () => {
  const actual = projectedEnvironment({ ...base, MEETING_PRIVATE_JOIN_DIAGNOSTIC_DIR: "" });
  assert.equal(Object.hasOwn(actual, "MEETING_PRIVATE_JOIN_DIAGNOSTIC_DIR"), true);
  assert.equal(actual.MEETING_PRIVATE_JOIN_DIAGNOSTIC_DIR === "", true);
});
