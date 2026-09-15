import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseCommandV2, parseEventV2 } from "../src/contracts/bridge-session-v2.ts";
import { parseCommandShape, parseEventShape } from "../src/contracts/bridge-session-v1.ts";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/contracts/bridge-session-v2.json", import.meta.url), "utf8"));
test("v2 normative schema accepts the same fixture and rejects timing/state shape drift", () => {
  const schema = JSON.parse(readFileSync(new URL("../protocols/bridge-session-v2.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: true });
  ajv.addFormat("uint64-decimal", (value: string) => /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 18446744073709551615n);
  ajv.addFormat("capture-identifier", (value: string) => Buffer.byteLength(value) <= 64 && !/[\p{Cc}\p{Cf}]/u.test(value));
  const validate = ajv.compile(schema);
  assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...fixture, events: [{ ...fixture.events[1], state: "unknown" }] }), false);
  assert.equal(validate({ ...fixture, commands: [{ ...fixture.commands[1], sessionToken: "unexpected" }] }), false);
});
test("separate v2 contract admits shared Swift fixture without widening v1", () => {
  for (const command of fixture.commands) { assert.deepEqual(parseCommandV2(command), command); assert.equal(parseCommandShape(command).ok, false); }
  for (const event of fixture.events) { assert.deepEqual(parseEventV2(event), event); assert.equal(parseEventShape(event).ok, false); }
});
test("v2 rejects lossy integers, identity substitution, unknown fields and fabricated exact speaker", () => {
  const media = fixture.commands[1];
  for (const patch of [{ sessionId: 41 }, { sessionId: "041" }, { sessionId: "18446744073709551616" }, { bridgeSessionId: "other" }, { credential: "" }, { mediaProtocolVersion: 1 }, { captureFormat: "pcm_f32le/24000/1/20ms" }, { extra: true }]) {
    assert.throws(() => parseCommandV2({ ...media, mediaLease: { ...media.mediaLease, ...patch } }));
  }
  for (const patch of [{ feishuUserId: null }, { reason: "no_highlight" }, { observationTiming: null }, { sequence: Number.MAX_SAFE_INTEGER + 1 }, { extra: true }]) {
    assert.throws(() => parseEventV2({ ...fixture.events[1], ...patch }));
  }
  assert.throws(() => parseEventV2({ ...fixture.events[2], observationTiming: undefined }));
  assert.throws(() => parseEventV2({ ...fixture.events[0], observationTiming: null }));
});
test("both languages consume the immutable Runtime fixture bytes", () => {
  const hashes = {
    "frame.json": "a9512e71021033885c8ba37496e7a75351768187e9c84cf2c58c3916a5f9898e",
    "recording.json": "23ae7ed7b4b1310bb9062f45aa1cfd07ba9a270bf39544d8237777095ef3e055",
    "control.json": "d42a2ba732ff889cdfeabea0963d39155975ca8f26da370a91bb4834944da327",
    "metadata.json": "41d4eb58072ceaf0a6e890d322f1136b41c5a96d4b03491f1335b82bc491747b",
    "output.json": "cba9c1028e7d909918c9e19b9b047cd1308adea312abba9faa91ced4eaaff187",
    "README.md": "3f15c3a008cc0d13745a7543266a46da3755d0362c39e48e7d1df656b7e44ab0",
  };
  for (const [file, hash] of Object.entries(hashes)) {
    const bytes = readFileSync(new URL(`../fixtures/runtime-4c97c47/timed-capture-v1/${file}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
  }
  const output = JSON.parse(readFileSync(new URL("../fixtures/runtime-4c97c47/timed-capture-v1/output.json", import.meta.url), "utf8"));
  assert.equal(fixture.commands[1].mediaLease.sessionId, output.started.media_lease.session_id);
  assert.equal(fixture.commands[1].mediaLease.captureFormat, output.started.media_lease.capture_format);
});
