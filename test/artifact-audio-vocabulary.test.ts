// D032 §§2-3: the consumer refuses a bundle whose `audio.format` is not a
// token and whose `audio.encryption` is not one of its two schemes. Both
// values are knowable from a pinned engine, so neither is a placeholder.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FINALIZED_RECORDING_PROTOCOL_VERSION } from "@conversation/runtime";

import { RECORDING_CONTAINER_ENCRYPTION } from "../src/application-composition.ts";
import { audioFormatToken } from "../src/contracts/teammem-meeting-v1.ts";

/** The consumer's grammar for `audio.format` and `audio.encryption`
 * (teammem/meeting_bundles.py `_TOKEN`, `AUDIO_ENCRYPTION_SCHEMES`). */
const TOKEN = /^[a-z][a-z0-9_-]*$/;
const ENCRYPTION_SCHEMES = ["age-x25519", "aes-256-gcm"];

test("the Runtime capture format becomes a token the consumer admits", () => {
  assert.equal(audioFormatToken("pcm_s16le/24000/1/20ms"), "pcm_s16le-24000-1-20ms");
  assert.match(audioFormatToken("pcm_s16le/24000/1/20ms"), TOKEN);
  assert.match(audioFormatToken("pcm_s16le/24000/1"), TOKEN);
  // Already a token: unchanged, so an existing artifact keeps its hash.
  assert.equal(audioFormatToken("opus"), "opus");
});

test("the consumer's own fixture spelling passes through unchanged", () => {
  // The frozen fixture both sides share. TeamMem's fixtures and schema doc
  // name no spelling for the Runtime capture format, so D032 §3's lossless
  // respelling decides it; a spelling the fixture DOES name must survive the
  // mapping untouched, or an existing artifact's hash would move.
  for (const name of ["teammem-meeting-v1.minimal", "teammem-meeting-v1.complete"]) {
    const fixture = JSON.parse(readFileSync(new URL(`../fixtures/contracts/${name}.json`, import.meta.url), "utf8")) as { audio: { format: string } };
    assert.match(fixture.audio.format, TOKEN);
    assert.equal(audioFormatToken(fixture.audio.format), fixture.audio.format);
  }
});

test("a format that cannot be spelled as a token is refused, not mangled", () => {
  assert.throws(() => audioFormatToken("PCM S16LE"), /not representable as a published audio format token/);
  assert.throws(() => audioFormatToken(""), /not representable as a published audio format token/);
});

test("the container cipher is the pinned fact of the protocol this client speaks", () => {
  assert.equal(FINALIZED_RECORDING_PROTOCOL_VERSION, 4);
  assert.equal(RECORDING_CONTAINER_ENCRYPTION, "aes-256-gcm");
  assert.ok(ENCRYPTION_SCHEMES.includes(RECORDING_CONTAINER_ENCRYPTION));
});
