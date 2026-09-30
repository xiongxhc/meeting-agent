import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

test("built interactive smoke checks name gating, grounded retrieval and acknowledged interruption", { timeout: 900_000 }, () => {
  const out = mkdtempSync(path.join(tmpdir(), "meeting-interactive-evidence-"));
  try {
    const result = spawnSync("/opt/homebrew/opt/node@24/bin/node", [path.join(import.meta.dirname, "run.mjs"), "--interactive", "--out", out], {
      cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 900_000,
      env: { ...process.env, E2E_ALLOW_LOCAL_BARE_PUSH: "0", PATH: `/opt/homebrew/opt/node@24/bin:${process.env.PATH ?? ""}` },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const bundle = JSON.parse(readFileSync(path.join(out, "bundle.json"), "utf8")) as {
      oracles: { name: string; status: string; detail: string }[];
    };
    assert.deepEqual(bundle.oracles.filter((entry) => entry.status === "fail"), []);
    for (const name of ["silent_name_gate", "current_meeting_grounding", "vault_grounding", "vault_unavailable",
      "acknowledged_interruption", "capture_after_interrupt", "no_orphan_process", "no_key_or_plaintext_audio"]) {
      const oracle = bundle.oracles.find((entry) => entry.name === name);
      assert.equal(oracle?.status, "pass", `${name}: ${oracle?.detail ?? "missing oracle"}`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
