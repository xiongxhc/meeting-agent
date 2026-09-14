import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateCustodyBinding, parseBridgeProcessOutcome, decodeBridgeProcessOutcome } from "../src/contracts/bridge-process-outcome-v1.ts";

const fixture = JSON.parse(readFileSync(new URL("../spikes/feishu/fixtures/process/outcome-v1.json", import.meta.url), "utf8"));
test("private outcome accepts canonical bytes and rejects wrong combinations, identities and timestamps", () => {
  assert.equal(parseBridgeProcessOutcome(fixture).outcome, "departure_confirmed");
  for (const patch of [{ token: "secret" }, { reason: "join_not_issued" }, { outcome: "departure_unconfirmed", reason: ["cleanup_failed"] }, { physicalGenerationId: "A".repeat(32) }, { physicalGenerationId: "a".repeat(32) + "\n" }, { physicalClientId: "slot\n" }, { physicalClientId: ".." }, { observedAt: "2026-02-31T14:01:00.000Z" }, { bridgeSessionId: "" }]) {
    assert.throws(() => parseBridgeProcessOutcome({ ...fixture, ...patch }), /invalid_bridge_process/);
  }
  for (const [outcome, reason] of [["no_join_action", "join_not_issued"], ["departure_unconfirmed", "evidence_unavailable"], ["departure_unconfirmed", "input_reap_failed"], ["departure_unconfirmed", "cleanup_failed"], ["departure_unconfirmed", "departure_not_observed"]]) {
    assert.equal(parseBridgeProcessOutcome({ ...fixture, outcome, reason }).reason, reason);
  }
});
test("flat wire decoder rejects duplicate members without misreading escaped string colons", () => {
  const value = { ...fixture, bridgeSessionId: 'quoted":\\session' };
  assert.deepEqual(decodeBridgeProcessOutcome(JSON.stringify(value)), value);
  assert.throws(() => decodeBridgeProcessOutcome(JSON.stringify(value).replace('"outcome":', '"outcome":"departure_confirmed","outcome":')));
});
test("binding admission bounds escaped envelope before durable claim", () => {
  const config = JSON.parse(readFileSync(new URL("../spikes/feishu/fixtures/process/config-v2.json", import.meta.url), "utf8"));
  assert.deepEqual(validateCustodyBinding(config.custody), config.custody);
  const longer = { ...config.custody, occurrenceId: "会".repeat(400) + "@2026-09-02T14:00:00Z", bridgeSessionId: "话".repeat(200) };
  assert.deepEqual(validateCustodyBinding(longer), longer);
  const largest = { schema: "bridge-process-outcome/v1", ...config.custody, outcome: "departure_unconfirmed", reason: "departure_not_observed", observedAt: "9999-12-31T23:59:59.999Z" };
  const available = 4096 - Buffer.byteLength(JSON.stringify({ ...largest, bridgeSessionId: "" })) - 1;
  assert.equal(validateCustodyBinding({ ...config.custody, bridgeSessionId: "x".repeat(available) }).bridgeSessionId.length, available);
  for (const patch of [{ bridgeSessionId: "x".repeat(available + 1) }, { bridgeSessionId: '"'.repeat(available) }, { occurrenceId: "x".repeat(4096) + "@2026-09-02T14:00:00Z" }, { extra: 1 }]) {
    assert.throws(() => validateCustodyBinding({ ...config.custody, ...patch }));
  }
});
