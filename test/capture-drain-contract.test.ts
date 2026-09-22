import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseEventShape } from "../src/contracts/bridge-session-v1.ts";
import { createBridgeSessionValidatorV2, parseCommandV2, parseEventV2 } from "../src/contracts/bridge-session-v2.ts";

/** D029 §1. The same three shapes the Swift encoder emits, byte for byte. */
const CONFIRMED = {
  drain: "confirmed",
  reason: null,
  boundary: { captureEpoch: "1", lastFrameSequence: "70", outputEndSample: "33600", finalClockPairSequence: "18446744073709551615" },
} as const;
const UNCONFIRMED = { drain: "unconfirmed", reason: "drain_not_attempted", boundary: null } as const;
const ZERO_FRAME = {
  drain: "confirmed",
  reason: null,
  boundary: { captureEpoch: "4", lastFrameSequence: "0", outputEndSample: "0", finalClockPairSequence: "9" },
} as const;

const v1 = (captureDrain?: unknown) => ({
  schema: "bridge-session/v1", sessionId: "bridge-independent", sequence: 7,
  observedAt: "2026-09-22T14:00:00.000Z", type: "media_disconnected", reason: "media_stopped",
  ...(captureDrain === undefined ? {} : { captureDrain }),
});
const v2 = (captureDrain?: unknown) => ({ ...v1(captureDrain), schema: "bridge-session/v2" });

/** Every shape the contract must refuse, in both grammars. */
const REFUSED: readonly unknown[] = [
  { drain: "confirmed", reason: null, boundary: null },
  { drain: "unconfirmed", reason: "why", boundary: CONFIRMED.boundary },
  { drain: "unconfirmed", reason: null, boundary: null },
  { drain: "confirmed", reason: "why", boundary: CONFIRMED.boundary },
  { drain: "maybe", reason: null, boundary: CONFIRMED.boundary },
  { drain: "confirmed", boundary: CONFIRMED.boundary },
  { drain: "confirmed", reason: null },
  { drain: "confirmed", reason: null, boundary: CONFIRMED.boundary, extra: 1 },
  { drain: "confirmed", reason: null, boundary: { ...CONFIRMED.boundary, extra: "1" } },
  { drain: "confirmed", reason: null, boundary: { ...CONFIRMED.boundary, captureEpoch: "0" } },
  { drain: "confirmed", reason: null, boundary: { ...CONFIRMED.boundary, finalClockPairSequence: "0" } },
  { drain: "confirmed", reason: null, boundary: { ...CONFIRMED.boundary, lastFrameSequence: "0" } },
  { drain: "confirmed", reason: null, boundary: { ...CONFIRMED.boundary, outputEndSample: "0" } },
  // Lossy and non-canonical integer spellings, exactly as the lease refuses them.
  { drain: "confirmed", reason: null, boundary: { ...CONFIRMED.boundary, captureEpoch: 1 } },
  { drain: "confirmed", reason: null, boundary: { ...CONFIRMED.boundary, captureEpoch: "01" } },
  { drain: "confirmed", reason: null, boundary: { ...CONFIRMED.boundary, captureEpoch: "18446744073709551616" } },
  { drain: "confirmed", reason: null, boundary: { ...CONFIRMED.boundary, captureEpoch: "-1" } },
  { drain: "unconfirmed", reason: "", boundary: null },
  { drain: "confirmed", reason: null, boundary: [] },
  "confirmed",
  null,
];

test("the v1 grammar admits captureDrain only on media_disconnected and only in D029's exact shape", () => {
  for (const drain of [undefined, CONFIRMED, UNCONFIRMED, ZERO_FRAME]) {
    const parsed = parseEventShape(v1(drain));
    assert.equal(parsed.ok, true, JSON.stringify(drain));
  }
  for (const drain of REFUSED) {
    const parsed = parseEventShape(v1(drain));
    assert.equal(parsed.ok, false, `accepted ${JSON.stringify(drain)}`);
  }
  // Only media_disconnected declares it; every other member set stays closed.
  assert.equal(parseEventShape({ schema: "bridge-session/v1", sessionId: "s", sequence: 1,
    observedAt: "2026-09-22T14:00:00.000Z", type: "media_connected", endpoint: "tcp://127.0.0.1:1",
    captureDrain: CONFIRMED }).ok, false);
  // An absent member is not a null one.
  assert.equal(parseEventShape(v1(null)).ok, false);
});

test("the v2 exact-key validator admits the same member and refuses the same shapes", () => {
  for (const drain of [undefined, CONFIRMED, UNCONFIRMED, ZERO_FRAME]) {
    assert.deepEqual(parseEventV2(v2(drain)), v2(drain));
  }
  for (const drain of REFUSED) assert.throws(() => parseEventV2(v2(drain)), `accepted ${JSON.stringify(drain)}`);
  const validator = createBridgeSessionValidatorV2("bridge-independent");
  assert.equal(validator.acceptEvent(v2(CONFIRMED)).ok, true);
  assert.equal(validator.acceptEvent({ ...v2(UNCONFIRMED), sequence: 8 }).ok, true);
  const refused = validator.acceptEvent({ ...v2({ drain: "confirmed", reason: null, boundary: null }), sequence: 9 });
  assert.equal(refused.ok, false);
});

test("the v2 lease admits mediaProtocolVersion 3 with every other binding check kept", () => {
  const lease = {
    sessionId: "41", bridgeSessionId: "bridge-independent", connectEndpoint: "tcp://127.0.0.1:9001",
    credential: "a".repeat(64), expiresAtMs: "1790000000000", reconnectWindowMs: "10000",
    mediaProtocolVersion: 3, captureFormat: "pcm_s16le/24000/1/20ms", timingContract: "capture-clock/v1",
  };
  const command = { schema: "bridge-session/v2", sessionId: "bridge-independent", commandId: "c1", type: "connect_media", mediaLease: lease };
  assert.deepEqual(parseCommandV2(command), command);
  assert.deepEqual(parseCommandV2({ ...command, mediaLease: { ...lease, mediaProtocolVersion: 2 } }),
    { ...command, mediaLease: { ...lease, mediaProtocolVersion: 2 } });
  for (const patch of [{ mediaProtocolVersion: 1 }, { mediaProtocolVersion: 4 }, { mediaProtocolVersion: "3" },
    { mediaProtocolVersion: 3.0000001 }, { sessionId: "041" }, { bridgeSessionId: "other" }, { credential: "" },
    { captureFormat: "pcm_f32le/24000/1/20ms" }, { timingContract: "capture-clock/v2" }, { extra: true }]) {
    assert.throws(() => parseCommandV2({ ...command, mediaLease: { ...lease, ...patch } }), JSON.stringify(patch));
  }
});

test("both normative schemas carry the same optional member", () => {
  for (const [file, message] of [["bridge-session-v1", v1], ["bridge-session-v2", v2]] as const) {
    const ajv = new Ajv2020({ strict: true });
    ajv.addFormat("uint64-decimal", (value: string) => /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 18446744073709551615n);
    ajv.addFormat("capture-identifier", (value: string) => Buffer.byteLength(value) <= 64 && !/[\p{Cc}\p{Cf}]/u.test(value));
    const schema = JSON.parse(readFileSync(new URL(`../protocols/${file}.schema.json`, import.meta.url), "utf8"));
    const events = ajv.compile({ $schema: schema.$schema, $defs: schema.$defs, $ref: "#/$defs/event" });
    for (const drain of [undefined, CONFIRMED, UNCONFIRMED, ZERO_FRAME]) {
      assert.equal(events(message(drain)), true, `${file}: ${JSON.stringify(events.errors)}`);
    }
    for (const drain of REFUSED) assert.equal(events(message(drain)), false, `${file} accepted ${JSON.stringify(drain)}`);
  }
});
