import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

test("valid R2 grammar yields a noninteractive plan without staging or running an application", async () => {
  const modulePath = path.join(import.meta.dirname, "run.mjs");
  const module = await import(modulePath);
  assert.equal(typeof module.parseArguments, "function");
  const options = module.parseArguments(["--r2-baseline", "--out", "/private/tmp/unused-r2-plan"]);
  assert.equal(options.r2Baseline, true); assert.equal(options.interactive, false);
  assert.equal(options.d2Cut, null); assert.equal(options.onlyRefusals, false);
});

for (const [args, expected] of [
  [["--r2-baseline", "--r2-baseline", "--out", "/tmp/unused-r2-output"], "duplicate R2 baseline flag"],
  [["--r2-baseline", "--interactive", "--out", "/tmp/unused-r2-output"], "R2 baseline cannot combine modes"],
  [["--r2-baseline", "--d2-cut", "durable", "--out", "/tmp/unused-r2-output"], "R2 baseline cannot combine modes"],
  [["--r2-baseline", "--only-refusals", "--out", "/tmp/unused-r2-output"], "R2 baseline cannot combine modes"],
  [["--r2-baseline", "--package-refusals", "--out", "/tmp/unused-r2-output"], "R2 baseline cannot combine modes"],
  [["--interactive", "--d2-cut", "invalid", "--out", "/tmp/unused-d2-output"], "invalid D2 cut"],
  [["--d2-cut", "durable", "--out", "/tmp/unused-d2-output"], "D2 cuts require --interactive"],
  [["--interactive", "--d2-cut", "durable", "--only-refusals", "--out", "/tmp/unused-d2-output"], "D2 cuts cannot run only refusals"],
  [["--dependency-wheelhouse", "relative", "--out", "/tmp/unused-d2-output"], "absolute dependency wheelhouse required"],
  [["--dependency-wheelhouse"], "absolute dependency wheelhouse required"],
  [["--package-refusals", "--out", "/tmp/unused-d2-output"], "package refusal cuts require --only-refusals"],
] as const) {
  test(`D2 runner refuses before staging: ${expected}`, () => {
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "run.mjs"), ...args], {
      cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(expected), result.stderr);
    assert.equal(result.stdout, "");
  });
}
