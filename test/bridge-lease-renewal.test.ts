import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createChildBridgeSlot } from "../src/adapters/child-bridge-process.ts";
import { validateCustodyBinding } from "../src/contracts/bridge-process-outcome-v1.ts";
import { createBridgeSessionValidatorV2, parseCommandV2 } from "../src/contracts/bridge-session-v2.ts";
import { parseCommandShape } from "../src/contracts/bridge-session-v1.ts";
import { createBridgeMediaLeaseRenewer, type BridgeCommandV2, type BridgeLeaseRenewalCommandV2 } from "../src/ports/bridge-v2.ts";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/contracts/bridge-session-v2.json", import.meta.url), "utf8"));
const renewal = fixture.commands.find((command: { type: string }) => command.type === "renew_media_lease");

test("renew_media_lease carries only the Runtime session and a later expiry", () => {
  assert.deepEqual(parseCommandV2(renewal), renewal);
  assert.equal(parseCommandShape(renewal).ok, false, "v1 stays frozen");
  for (const patch of [{ sessionId: 41 }, { sessionId: "041" }, { sessionId: "0" }, { expiresAtMs: "0" },
    { expiresAtMs: "18446744073709551616" }, { expiresAtMs: 1_120_000 }, { credential: "x" }]) {
    assert.throws(() => parseCommandV2({ ...renewal, leaseRenewal: { ...renewal.leaseRenewal, ...patch } }), JSON.stringify(patch));
  }
  assert.throws(() => parseCommandV2({ ...renewal, leaseRenewal: { sessionId: "41" } }));
  assert.throws(() => parseCommandV2({ ...renewal, mediaLease: {} }));
  const validator = createBridgeSessionValidatorV2("bridge-independent");
  const missing: Record<string, unknown> = { ...renewal }; delete missing.leaseRenewal;
  const absent = validator.acceptCommand(missing);
  assert.equal(absent.ok, false); if (!absent.ok) assert.deepEqual([absent.rejection.code, absent.rejection.path], ["missing_field", "/leaseRenewal"]);
  const malformed = validator.acceptCommand({ ...renewal, leaseRenewal: { sessionId: "41", expiresAtMs: "01" } });
  assert.equal(malformed.ok, false); if (!malformed.ok) assert.deepEqual([malformed.rejection.code, malformed.rejection.path], ["media_lease", "/leaseRenewal"]);
  assert.equal(validator.acceptCommand(renewal).ok, true);
  const other = createBridgeSessionValidatorV2("other-bridge").acceptCommand(renewal);
  assert.equal(other.ok, false); if (!other.ok) assert.equal(other.rejection.code, "session_mismatch");
});

test("the renewer forwards only a strictly later expiry, bound to one Runtime session", async () => {
  const sent: BridgeLeaseRenewalCommandV2[] = [];
  const renewer = createBridgeMediaLeaseRenewer(41n, 1_060_000n, async (command) => { sent.push(command); });
  assert.equal(await renewer.forward(1_120_000n), true);
  assert.equal(await renewer.forward(1_120_000n), false, "the same expiry is not resent");
  assert.equal(await renewer.forward(1_090_000n), false, "an earlier expiry never reaches the bridge");
  assert.equal(await renewer.forward(1_180_000n), true);
  assert.deepEqual(sent, [
    { type: "renew_media_lease", leaseRenewal: { sessionId: "41", expiresAtMs: "1120000" } },
    { type: "renew_media_lease", leaseRenewal: { sessionId: "41", expiresAtMs: "1180000" } },
  ]);
  assert.equal(renewer.expiresAtMs(), 1_180_000n);
  const failing = createBridgeMediaLeaseRenewer(41n, 1_060_000n, async () => { throw new Error("bridge_closed"); });
  await assert.rejects(failing.forward(1_120_000n), /bridge_closed/);
  assert.equal(failing.expiresAtMs(), 1_060_000n, "a failed send does not advance the forwarded expiry");
});

test("the child bridge adapter sends a renewal over bridge-session/v2 and correlates its answer", { timeout: 30_000 }, async () => {
  const process_ = JSON.parse(readFileSync(new URL("../spikes/feishu/fixtures/process/config-v2.json", import.meta.url), "utf8"));
  const binding = validateCustodyBinding(process_.custody);
  const dir = mkdtempSync(path.join(os.tmpdir(), "lease-renewal-child-"));
  const configPath = path.join(dir, "static.json");
  const fields = { ...process_ }; delete fields.custody;
  writeFileSync(configPath, JSON.stringify({ ...fields, schema: "feishu-bridge-config/v1", bundleVersion: "media", evidenceRoot: dir,
    audio: { captureDisplayId: 1, outputDeviceUid: "synthetic-output-device" } }), { mode: 0o600 });
  const child = await createChildBridgeSlot({ physicalClientId: binding.physicalClientId, bridgeId: "bridge", executable: process.execPath,
    argv: [path.resolve("test/fixtures/bridge-v2-child.mjs")], staticConfigPath: configPath, cooperativeGraceMs: 1000, protocol: "bridge-session/v2" }).launch(binding);
  try {
    const answers = new Map<string, { outcome: string; detail: string | null }>();
    child.bridge.subscribe((raw) => {
      const event = raw as { type: string; commandId?: string; outcome?: string; detail?: string | null };
      if (event.type === "command_result") answers.set(event.commandId!, { outcome: event.outcome!, detail: event.detail ?? null });
    });
    const session = binding.bridgeSessionId;
    const send = (command: BridgeCommandV2 | BridgeLeaseRenewalCommandV2, commandId: string) =>
      (child.bridge as unknown as { send(message: unknown): Promise<void> }).send({ schema: "bridge-session/v2", sessionId: session, commandId, ...command });
    const answer = async (commandId: string) => {
      const deadline = Date.now() + 10_000;
      while (!answers.has(commandId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      return answers.get(commandId);
    };
    await send({ type: "join", meetingOccurrenceId: binding.occurrenceId, meetingNo: "123456789", leaseId: "lease" }, "join");
    assert.equal((await answer("join"))?.outcome, "ok");
    const renew = createBridgeMediaLeaseRenewer(41n, 1_060_000n, (command) => send(command, `renew-${String(answers.size)}`));
    assert.equal(await renew.forward(1_120_000n), true);
    assert.deepEqual(await answer("renew-1"), { outcome: "rejected", detail: "media_not_connected" });
    // As Swift: an unchanged expiry that has already passed is expired, never ok.
    const brief = BigInt(Date.now() + 100);
    await send({ type: "connect_media", mediaLease: { ...fixture.commands[1].mediaLease, bridgeSessionId: session, expiresAtMs: brief.toString() } }, "media-brief");
    assert.equal((await answer("media-brief"))?.outcome, "ok");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await send({ type: "renew_media_lease", leaseRenewal: { sessionId: "41", expiresAtMs: brief.toString() } }, "renew-past");
    assert.deepEqual(await answer("renew-past"), { outcome: "rejected", detail: "lease_expired" });
    const start = BigInt(Date.now() + 60_000);
    await send({ type: "connect_media", mediaLease: { ...fixture.commands[1].mediaLease, bridgeSessionId: session, expiresAtMs: start.toString() } }, "media");
    assert.deepEqual(await answer("media"), { outcome: "ok", detail: "media_lease_renewal" }, "the connected answer advertises renewal, as the Swift bridge does");
    const later = createBridgeMediaLeaseRenewer(41n, start, (command) => send(command, "renew-ok"));
    assert.equal(await later.forward(start + 60_000n), true);
    assert.deepEqual(await answer("renew-ok"), { outcome: "ok", detail: null });
    await send({ type: "renew_media_lease", leaseRenewal: { sessionId: "41", expiresAtMs: (start + 30_000n).toString() } }, "renew-back");
    assert.deepEqual(await answer("renew-back"), { outcome: "rejected", detail: "lease_expiry_regressed" });
    await send({ type: "renew_media_lease", leaseRenewal: { sessionId: "42", expiresAtMs: (start + 90_000n).toString() } }, "renew-other");
    assert.deepEqual(await answer("renew-other"), { outcome: "rejected", detail: "media_session_mismatch" });
    await assert.rejects(send({ type: "renew_media_lease", leaseRenewal: { sessionId: "41", expiresAtMs: "01" } }, "renew-bad"), /bridge_control_rejected/);
  } finally {
    await child.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
