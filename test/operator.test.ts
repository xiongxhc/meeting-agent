import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
test("operator requires exact generation and explicit inspected-idle assertion before audited clear", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "custody-operator-")), filename = path.join(dir, "orchestration.db");
  const binding = { physicalClientId: "slot", physicalGenerationId: "a".repeat(32), occurrenceId: "meeting@2026-09-02T14:00:00Z", bridgeSessionId: "session" };
  const run = (...args: string[]) => spawnSync(process.execPath, [path.resolve("src/operator.ts"), ...args], { encoding: "utf8", timeout: 3000 });
  try {
    const missing = path.join(dir, "absent.db");
    assert.equal(run("physical-client-clear", "--db", missing).status, 2);
    assert.equal(existsSync(missing), false);
    const store = openSessionStore({ filename }); store.claimPhysicalClient(binding, 1); store.close();
    const args = ["physical-client-clear", "--db", filename, "--slot", "slot", "--generation", binding.physicalGenerationId, "--operator", "human"];
    assert.equal(run(...args).status, 2);
    assert.equal(run(...args, "--assert-inspected-idle").status, 0);
    assert.equal(run(...args, "--assert-inspected-idle").status, 2);
    const status = run("physical-client-status", "--db", filename);
    assert.equal(status.status, 0);
    const rows = JSON.parse(status.stdout);
    assert.equal(rows[0].state, "cleared"); assert.equal(rows[0].clearOperator, "human");
    assert.equal(rows[0].clearReason, "operator_inspected_idle");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
