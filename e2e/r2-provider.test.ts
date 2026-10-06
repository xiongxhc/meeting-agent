import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { Writable, PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";

// @ts-expect-error Test-only JS module has no public declaration.
const module = await import("./r2-provider.mjs").catch(() => ({}));
const options = { segmentText: "Scripted fixture output; no model transcribed this PCM.", segmentStartMs: 0, segmentEndMs: 20 };
function provider(overrides = {}) {
  const create = Reflect.get(module, "createR2ProviderHandler");
  assert.equal(typeof create, "function", "R2 must expose the same bounded HTTP handler used by its server wrapper");
  return create({ ...options, ...overrides });
}
class Response extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  chunks: Buffer[] = [];
  setHeader(name: string, value: string) { this.headers[name] = value; }
  _write(chunk: Buffer, _encoding: string, callback: () => void) { this.chunks.push(Buffer.from(chunk)); callback(); }
  get body() { return Buffer.concat(this.chunks).toString("utf8"); }
}
async function exchange(p: ReturnType<typeof provider>, path: string, body: Buffer = Buffer.alloc(0), headers: Record<string, string> = {}, method = "POST") {
  const request = Object.assign(new PassThrough(), { url: path, method, complete: false, headers: { authorization: "Bearer private-credential-do-not-log", ...headers } });
  const response = new Response();
  p.handler(request, response);
  for (let start = 0; start < body.length; start += 113) request.write(body.subarray(start, start + 113));
  request.complete = true; request.end();
  await setImmediate();
  return { request, response };
}
function wav(samples = 480) {
  const header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(samples * 2 + 36, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(samples * 2, 40);
  return Buffer.concat([header, Buffer.alloc(samples * 2, 0x12)]);
}
function upload(audio = wav(), extra = "", fields = "model=scripted-model;response_format=diarized_json;chunking_strategy=auto") {
  const boundary = "r2-private-boundary";
  const chunks: Buffer[] = [];
  for (const entry of fields.split(";")) {
    const [name, value] = entry.split("=");
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="window.wav"\r\nContent-Type: audio/wav\r\n\r\n`), audio, Buffer.from(`\r\n--${boundary}--\r\n${extra}`));
  return { body: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
const synthesis = Buffer.from(JSON.stringify({ model: "scripted-model", stream: true, messages: [{ role: "user", content: "meeting synthesis private-prompt-do-not-log" }] }));
const json = { "content-type": "application/json" };
const summary = "Scripted fixture provider output; no model read this meeting.";
const answer = JSON.stringify({ summary, projects: [], decisions: [], action_items: [], discussion_points: [], person_summaries: [] });

// Removing SSE termination/schema or returning interactive prose must break this test.
test("fragmented synthesis returns exact accepted SSE six-field artifact bytes", async () => {
  const p = provider();
  const { response } = await exchange(p, "/v1/chat/completions", synthesis, json);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "text/event-stream");
  assert.equal(response.body, `data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`);
  assert.equal(response.writableFinished, true);
});
// Empty answers, fixed one-second timings, or invented identities must fail.
test("multipart WAV produces nonempty anonymous synthetic segments inside actual PCM extent", async () => {
  const p = provider();
  for (const samples of [480, 24000, 524288]) {
    const input = upload(wav(samples));
    const { response } = await exchange(p, "/v1/audio/transcriptions", input.body, input.headers);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "application/json");
    assert.equal(response.body, JSON.stringify({ task: "transcribe", duration: samples / 24000, text: options.segmentText,
      segments: [{ type: "transcript.text.segment", id: "scripted-segment-1", start: 0, end: 0.02, text: options.segmentText, speaker: "anonymous-scripted-cluster-1" }] }));
    assert.equal(response.writableFinished, true);
  }
});
test("explicit segment options refuse empty, unmarked, oversized or invalid synthetic intervals", () => {
  for (const bad of [{ segmentText: "" }, { segmentText: "actual meeting claim" }, { segmentText: "Scripted fixture " + "x".repeat(4096) },
    { segmentStartMs: -1 }, { segmentStartMs: 20 }, { segmentEndMs: 0 }, { segmentEndMs: NaN }, { segmentEndMs: Infinity }, { segmentEndMs: 1.5 },
    { segmentText: "Scripted fixture " + "\x00".repeat(4000) }])
    assert.throws(() => provider(bad), /Invalid scripted segment configuration/);
  const create = Reflect.get(module, "createR2ProviderHandler");
  assert.throws(() => create(), /Invalid scripted segment configuration/);
});
test("unavailable final processing and next synthesis503 are independent finite instance-local faults", async () => {
  const p = provider(), other = provider(), input = upload();
  p.setFinalAvailable(false); p.armNextSynthesisFailure();
  assert.equal((await exchange(p, "/health", Buffer.alloc(0), {}, "GET")).response.statusCode, 200);
  assert.equal((await exchange(p, "/v1/audio/transcriptions", input.body, input.headers)).response.statusCode, 503);
  assert.equal((await exchange(other, "/v1/audio/transcriptions", input.body, input.headers)).response.statusCode, 200);
  assert.equal((await exchange(p, "/v1/chat/completions", synthesis, json)).response.statusCode, 503);
  assert.equal((await exchange(p, "/v1/chat/completions", synthesis, json)).response.statusCode, 200);
  p.setFinalAvailable(true);
  assert.equal((await exchange(p, "/v1/audio/transcriptions", input.body, input.headers)).response.statusCode, 200);
});
test("held final ownership releases once and cancellation or connection close never emits a success", async () => {
  const p = provider(), input = upload();
  const hold = p.holdNextFinal();
  assert.throws(() => p.holdNextFinal(), /already owned/);
  const pending = await exchange(p, "/v1/audio/transcriptions", input.body, input.headers);
  assert.equal(pending.response.writableFinished, false); assert.equal(pending.response.body, "");
  assert.equal(hold.pending, true); assert.equal(hold.release(), true); await setImmediate();
  assert.equal(pending.response.statusCode, 200); assert.equal(pending.response.writableFinished, true);
  assert.equal(hold.release(), false); assert.equal(hold.cancel(), false);
  for (const action of ["cancel", "request", "request-close", "request-error", "response", "close"]) {
    const owner = p.holdNextFinal();
    const held = await exchange(p, "/v1/audio/transcriptions", input.body, input.headers);
    if (action === "cancel") assert.equal(owner.cancel(), true);
    if (action === "request") held.request.emit("aborted");
    if (action === "request-close") { held.request.complete = false; held.request.emit("close"); }
    if (action === "request-error") held.request.emit("error", new Error("private-stream-error-do-not-log"));
    if (action === "response") held.response.destroy();
    if (action === "close") p.close();
    await setImmediate();
    assert.equal(owner.pending, false); assert.equal(owner.release(), false);
    assert.equal(held.response.body, ""); assert.equal(held.response.destroyed, true);
  }
  assert.throws(() => p.holdNextFinal(), /closed/);
});
test("a request already aborted before handler registration cannot remain live or consume a held response", () => {
  const p = provider(), hold = p.holdNextFinal();
  const request = Object.assign(new PassThrough(), { url: "/v1/audio/transcriptions", method: "POST", aborted: true, complete: false,
    headers: { authorization: "Bearer private-credential", "content-type": "multipart/form-data; boundary=previously-aborted" } });
  const response = new Response();
  p.handler(request, response);
  assert.equal(response.destroyed, true); assert.equal(response.body, ""); assert.equal(hold.pending, false);
  assert.equal(hold.cancel(), true);
  assert.deepEqual(p.calls, [{ ordinal: 1, route: "final", outcome: "cancelled", requestBytes: 0, responseBytes: 0 }]);
});
test("handler refuses method, route, auth, content-type and malformed synthesis without consuming faults", async () => {
  const p = provider(); p.armNextSynthesisFailure();
  for (const [path, body, headers, method, status] of [
    ["/v1/chat/completions", synthesis, json, "GET", 405], ["/api/chat", synthesis, json, "POST", 404],
    ["/v1/chat/completions", synthesis, { ...json, authorization: "" }, "POST", 401],
    ["/v1/chat/completions", synthesis, {}, "POST", 415],
    ...["{", "null", '{"messages":[null],"stream":true}', '{"messages":[],"stream":false}', '{"messages":[{"content":42}],"stream":true}'].map(body => ["/v1/chat/completions", Buffer.from(body), json, "POST", 400]),
  ] as [string, Buffer, Record<string, string>, string, number][]) {
    const { response } = await exchange(p, path, body, headers, method);
    assert.equal(response.statusCode, status); assert.equal(response.writableFinished, true);
    assert.ok(response.body.length < 256);
  }
  assert.equal((await exchange(p, "/v1/chat/completions", synthesis, json)).response.statusCode, 503);
});
test("invalid multipart fields and unsupported zero, short or malformed WAV cannot become complete", async () => {
  const p = provider();
  const badRate = wav(); badRate.writeUInt32LE(16000, 24);
  const badLength = wav(); badLength.writeUInt32LE(959, 40);
  const badChannels = wav(); badChannels.writeUInt16LE(2, 22);
  const missing = upload(wav(), "", "model=scripted-model;response_format=diarized_json");
  const duplicate = upload(wav(), "", "model=x;model=y;response_format=diarized_json;chunking_strategy=auto");
  const wrong = upload(wav(), "", "model=x;response_format=json;chunking_strategy=auto");
  for (const input of [upload(wav(0)), upload(wav(479)), upload(wav(524289)), upload(badRate), upload(badLength), upload(badChannels),
    missing, duplicate, wrong, upload(wav(), "private-trailing-do-not-log"), { body: Buffer.from("private-malformed-do-not-log"), headers: { "content-type": "multipart/form-data; boundary=broken" } }]) {
    const { response } = await exchange(p, "/v1/audio/transcriptions", input.body, input.headers);
    assert.equal(response.statusCode, 400); assert.equal(response.writableFinished, true);
    assert.ok(response.body.length < 256);
  }
  const custom = provider({ segmentStartMs: 20, segmentEndMs: 40 });
  const input = upload(wav());
  assert.equal((await exchange(custom, "/v1/audio/transcriptions", input.body, input.headers)).response.statusCode, 400);
});
// EOF after an ordinary part delimiter must not substitute for the closing marker.
test("multipart requires an observed complete terminal marker and refuses nearby truncations", async () => {
  const p = provider(), input = upload();
  const marker = Buffer.from("\r\n--r2-private-boundary--\r\n");
  const prefix = input.body.subarray(0, input.body.length - marker.length);
  const malformed = [Buffer.concat([prefix, Buffer.from("\r\n--r2-private-boundary\r\n")]),
    ...[1, 2, 3, 4, 5, marker.length].map(cut => input.body.subarray(0, input.body.length - cut))];
  for (const body of malformed) {
    const { response } = await exchange(p, "/v1/audio/transcriptions", body, input.headers);
    assert.equal(response.statusCode, 400); assert.equal(response.writableFinished, true);
    assert.equal(response.body, '{"error":"Scripted R2 provider request refused."}');
  }
  assert.equal((await exchange(p, "/v1/audio/transcriptions", input.body, input.headers)).response.statusCode, 200);
});
// Close owns every admitted unfinished body reader, not only parsed held finals.
test("provider close cancels all partial body readers once and late bytes cannot produce success or orphan holds", async () => {
  for (const armed of [false, true]) {
    const p = provider(), owner = armed ? p.holdNextFinal() : null, input = upload();
    const readers = [
      { path: "/v1/audio/transcriptions", body: input.body, headers: input.headers, route: "final" },
      { path: "/v1/chat/completions", body: synthesis, headers: json, route: "synthesis" },
    ].map(item => {
      const request = Object.assign(new PassThrough(), { url: item.path, method: "POST", complete: false,
        headers: { authorization: "Bearer private-credential-do-not-log", ...item.headers } });
      const response = new Response(); p.handler(request, response); request.write(item.body.subarray(0, 113));
      return { ...item, request, response };
    });
    p.close(); p.close();
    for (const reader of readers) { assert.equal(reader.response.destroyed, true); assert.equal(reader.response.body, ""); }
    assert.equal(owner?.pending ?? false, false); assert.equal(owner?.release() ?? false, false); assert.equal(owner?.cancel() ?? false, false);
    const expected = [{ ordinal: 1, route: "final", outcome: "cancelled", requestBytes: 113, responseBytes: 0 },
      { ordinal: 2, route: "synthesis", outcome: "cancelled", requestBytes: 113, responseBytes: 0 }];
    assert.deepEqual(p.calls, expected);
    for (const reader of readers) { reader.request.write(reader.body.subarray(113)); reader.request.complete = true; reader.request.end(); }
    await setImmediate();
    assert.deepEqual(p.calls, expected);
    for (const reader of readers) assert.equal(reader.response.body, "");
    assert.throws(() => p.holdNextFinal(), /closed/);
  }
});
test("body and retained telemetry stay bounded and never retain prompt, credential, filename or PCM bytes", async () => {
  const p = provider(); p.armNextSynthesisFailure();
  const oversized = await exchange(p, "/v1/chat/completions", Buffer.alloc(2 * 1024 * 1024 + 1, 0x78), json);
  assert.equal(oversized.response.statusCode, 413); assert.ok(oversized.response.body.length < 256);
  assert.equal((await exchange(p, "/v1/chat/completions", synthesis, json)).response.statusCode, 503);
  const input = upload();
  const final = await exchange(p, "/v1/audio/transcriptions", input.body, input.headers);
  assert.equal(final.response.statusCode, 200);
  assert.deepEqual(p.calls.at(-1), { ordinal: 3, route: "final", outcome: "ok", requestBytes: input.body.length, responseBytes: Buffer.byteLength(final.response.body) });
  assert.equal(JSON.stringify(p.calls).includes("r2-private-boundary"), false);
  assert.equal(JSON.stringify(p.calls).includes("window.wav"), false);
  for (let i = 0; i < 80; i++) await exchange(p, "/v1/chat/completions", synthesis, json);
  assert.equal(p.calls.length, 64);
  for (const call of p.calls) {
    assert.deepEqual(Object.keys(call).sort(), ["ordinal", "outcome", "requestBytes", "responseBytes", "route"]);
    assert.equal(call.requestBytes, synthesis.length); assert.ok(call.responseBytes < 16384);
  }
  const encoded = JSON.stringify(p.calls);
  for (const privateValue of ["private-prompt", "private-credential", "window.wav", "r2-private-boundary", "12121212"]) assert.equal(encoded.includes(privateValue), false);
});
