import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, existsSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createChildBridgeSlot } from "../src/adapters/child-bridge-process.ts";
import { validateCustodyBinding } from "../src/contracts/bridge-process-outcome-v1.ts";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";

const fixture = JSON.parse(readFileSync(new URL("../spikes/feishu/fixtures/process/config-v2.json", import.meta.url), "utf8"));
const binding = validateCustodyBinding(fixture.custody);
test("actual child private pipe handles fragmented outcome and rejects duplicate/truncated/wrong/oversized/absent results", async () => {
  for (const mode of ["fragmented", "duplicate", "duplicate-key", "conflicting", "truncated", "wrong", "oversized", "exit", "environment"]) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "custody-child-"));
    const configPath = path.join(dir, "static.json");
    const fields = { ...fixture }; delete fields.custody;
    writeFileSync(configPath, JSON.stringify({ ...fields, schema: "feishu-bridge-config/v1", bundleVersion: mode }), { mode: 0o600 });
    process.env.RUNTIME_SECRET = "synthetic-canary"; process.env.FEISHU_APP_SECRET = "synthetic-canary";
    process.env.DYLD_TEST_CANARY = "synthetic-canary";
    const oldNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = "--no-warnings";
    try {
      const slot = createChildBridgeSlot({ physicalClientId: binding.physicalClientId, bridgeId: "bridge", executable: process.execPath,
        argv: [path.resolve("test/fixtures/custody-child.mjs")], staticConfigPath: configPath, cooperativeGraceMs: 1000 });
      const child = await slot.launch(binding);
      const first = child.shutdown();
      assert.equal(child.shutdown(), first);
      const result = await first;
      assert.equal(result.reaped, true);
      if (["fragmented", "environment"].includes(mode)) {
        assert.equal(result.failure, null); assert.equal(result.outcome?.outcome, "no_join_action");
      } else { assert.notEqual(result.failure, null); assert.equal(result.outcome, null); }
      assert.deepEqual(readdirSync(dir), ["static.json"]);
    } finally {
      delete process.env.RUNTIME_SECRET; delete process.env.FEISHU_APP_SECRET; delete process.env.DYLD_TEST_CANARY;
      if (oldNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldNodeOptions;
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
test("ordinary nonzero exit is an independent durable diagnostic, never departure proof or veto", async () => {
  for (const mode of ["failed-outcome", "confirmed-exit2", "unconfirmed-exit2", "malformed-exit2", "wrong-exit2", "protocol-exit2", "forced-exit2", "signal-outcome"]) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "custody-exit-audit-"));
    const configPath = path.join(dir, "static.json"), filename = path.join(dir, "orchestration.db");
    const fields = { ...fixture }; delete fields.custody;
    writeFileSync(configPath, JSON.stringify({ ...fields, schema: "feishu-bridge-config/v1", bundleVersion: mode, evidenceRoot: dir }));
    const store = openSessionStore({ filename });
    try {
      store.claimPhysicalClient(binding, 1);
      const child = await createChildBridgeSlot({ physicalClientId: binding.physicalClientId, bridgeId: "bridge", executable: process.execPath,
        argv: [path.resolve("test/fixtures/custody-child.mjs")], staticConfigPath: configPath, cooperativeGraceMs: 1000 }).launch(binding);
      const result = await child.shutdown();
      assert.equal(result.reaped, true);
      const positive = ["failed-outcome", "confirmed-exit2"].includes(mode);
      if (positive) assert.equal(result.failure, null);
      else if (mode !== "unconfirmed-exit2") assert.notEqual(result.failure, null);
      assert.equal(result.exitDiagnostic, mode === "signal-outcome" ? null : "nonzero_exit");
      store.recordPhysicalOutcome(binding, result, 2); store.close();
      const reopened = openSessionStore({ filename });
      try {
        const row = reopened.listPhysicalCustody()[0]!;
        assert.equal(row.state, positive ? "cleared" : "quarantined");
        assert.equal(row.exitDiagnostic, result.exitDiagnostic);
        assert.equal(row.outcomeFailure, result.failure);
      } finally { reopened.close(); }
      const pid = Number(readFileSync(path.join(dir, "child.pid"), "utf8"));
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});
test("actual hung/flooding child is bounded and owned process is reaped", async () => {
  for (const mode of ["hung", "flood", "early-outcome"]) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "custody-hung-"));
    const configPath = path.join(dir, "static.json");
    const fields = { ...fixture }; delete fields.custody;
    writeFileSync(configPath, JSON.stringify({ ...fields, schema: "feishu-bridge-config/v1", bundleVersion: mode, evidenceRoot: dir }));
    try {
      const child = await createChildBridgeSlot({ physicalClientId: binding.physicalClientId, bridgeId: "bridge", executable: process.execPath,
        argv: [path.resolve("test/fixtures/custody-child.mjs")], staticConfigPath: configPath, cooperativeGraceMs: 1000 }).launch(binding);
      const start = performance.now(); const result = await child.shutdown();
      assert.equal(result.reaped, true); assert.notEqual(result.failure, null);
      assert.ok(performance.now() - start < 4500);
      const pid = Number(readFileSync(path.join(dir, "child.pid"), "utf8"));
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      const generated = readFileSync(path.join(dir, "child.config-path"), "utf8");
      assert.equal(existsSync(generated), false); assert.equal(existsSync(path.dirname(generated)), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("private launch rejects unsafe static input and malformed binding without changing operator config", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "custody-admission-"));
  const configPath = path.join(dir, "config.json"), linked = path.join(dir, "linked.json");
  const fields = { ...fixture }; delete fields.custody; fields.schema = "feishu-bridge-config/v1";
  writeFileSync(configPath, JSON.stringify(fields)); symlinkSync(configPath, linked);
  const options = { physicalClientId: binding.physicalClientId, bridgeId: "bridge", executable: process.execPath,
    argv: [path.resolve("test/fixtures/custody-child.mjs")], staticConfigPath: configPath };
  try {
    const before = readFileSync(configPath, "utf8");
    await assert.rejects(createChildBridgeSlot({ ...options, staticConfigPath: linked }).launch(binding));
    await assert.rejects(createChildBridgeSlot({ ...options, staticConfigPath: dir }).launch(binding));
    await assert.rejects(createChildBridgeSlot(options).launch({ ...binding, physicalClientId: "foreign" }));
    assert.equal(readFileSync(configPath, "utf8"), before);
    writeFileSync(configPath, "x".repeat(65_537));
    await assert.rejects(createChildBridgeSlot(options).launch(binding));
    assert.throws(() => createChildBridgeSlot({ ...options, executable: "relative" }));
    assert.throws(() => createChildBridgeSlot({ ...options, cooperativeGraceMs: 0 }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
