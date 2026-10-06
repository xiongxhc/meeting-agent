import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { Writable, PassThrough, Duplex } from "node:stream";
import { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
// @ts-expect-error Private harness JavaScript has no declaration.
const module = await import("./feishu-peer-controls.mjs").catch(() => ({}));
const meeting = { providerMeetingId: "meeting-one", meetingNo: "100", startSeconds: 123, title: "Private title" };
const paths = {
  tenant_access_token: "/open-apis/auth/v3/tenant_access_token/internal",
  ws_endpoint: "/callback/ws/endpoint",
  reserve_active_meeting: "/open-apis/vc/v1/reserves/reserve-e2e-1/get_active_meeting",
  reserve_get: "/open-apis/vc/v1/reserves/reserve-e2e-1",
  contact_user_get: "/open-apis/contact/v3/users/ou_e2e_organizer?user_id_type=open_id",
};
function peer() {
  const create = Reflect.get(module, "createFeishuPeerControls");
  assert.equal(typeof create, "function", "Expose the same finite request handler used by the Feishu server");
  return create({ meeting, wsPath: () => "ws://peer.invalid/ws" });
}
class Response extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  chunks: Buffer[] = [];
  setHeader(name: string, value: string) { this.headers[name] = value; }
  _write(chunk: Buffer, _encoding: string, callback: () => void) { this.chunks.push(Buffer.from(chunk)); callback(); }
  get body() { return Buffer.concat(this.chunks).toString("utf8"); }
}
function begin(p: ReturnType<typeof peer>, path: string, headers = {}, method = "POST") {
  const request = Object.assign(new PassThrough(), { url: path, method, complete: false, aborted: false,
    headers: { authorization: "Bearer private-token", ...headers } });
  const response = new Response();
  p.handler(request, response);
  return { request, response };
}
async function exchange(p: ReturnType<typeof peer>, path: string, body = Buffer.alloc(0), headers = {}) {
  const pair = begin(p, path, headers);
  for (let at = 0; at < body.length; at += 113) pair.request.write(body.subarray(at, at + 113));
  pair.request.complete = true; pair.request.end();
  await setImmediate();
  return pair;
}
const failure = '{"code":99,"msg":"scripted failure"}';

// Any change in default route response bytes, fallback or message extraction breaks this.
test("default actual handler preserves token, handshake, metadata, message and unmatched bytes", async () => {
  const p = peer();
  const expected = [
    '{"code":0,"msg":"ok","tenant_access_token":"e2e-scripted-token","app_access_token":"e2e-scripted-token","expire":7200}',
    '{"code":0,"data":{"URL":"ws://peer.invalid/ws?device_id=e2e&service_id=1","ClientConfig":{"PingInterval":120,"ReconnectCount":1,"ReconnectInterval":0,"ReconnectNonce":0}}}',
    '{"code":0,"msg":"ok","data":{"meeting":{"id":"meeting-one","meeting_no":"100","start_time":"123","topic":"Private title"}}}',
    '{"code":0,"msg":"ok","data":{"reserve":{"id":"reserve-e2e-1","meeting_no":"100","reserve_user_id":"ou_e2e_organizer"}}}',
    '{"code":0,"msg":"ok","data":{"user":{"open_id":"ou_e2e_organizer","name":"Scripted Organizer"}}}',
  ];
  for (const [index, path] of Object.values(paths).entries()) {
    const { response } = await exchange(p, path, Buffer.from('{"secret":"private-body"}'));
    assert.equal(response.body, expected[index]); assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "application/json");
  }
  assert.equal((await exchange(p, "/auth/v3/app_access_token/internal")).response.body, expected[0]);
  const { response } = await exchange(p, "/im/v1/messages", Buffer.from('{"receive_id":"recipient","uuid":"uuid1","content":"{\\"text\\":\\"private-message\\"}"}'));
  assert.equal(response.body, '{"code":0,"msg":"ok","data":{"message_id":"om_e2e_1"}}');
  assert.deepEqual(p.messages.map(({ at, ...message }: { at: number }) => { assert.equal(Number.isSafeInteger(at), true); return message; }),
    [{ receiveId: "recipient", uuid: "uuid1", text: "private-message", textBytes: 26 }]);
  const unmatched = await exchange(p, "/private-identifier");
  assert.equal(unmatched.response.statusCode, 404); assert.equal(unmatched.response.body, '{"code":99,"msg":"not scripted"}');
  assert.deepEqual(p.requests.at(-1), { method: "POST", route: "unmatched", status: 404 });
  p.close();
});
// Persistent/global controls or wrong route matching would poison the second/other request.
test("each closed route has one-shot finite failure isolated by route and peer instance", async () => {
  for (const [route, path] of Object.entries(paths)) {
    const p = peer(), other = peer(); p.armNext({ route, outcome: "failure" });
    assert.equal((await exchange(other, path)).response.statusCode, 200);
    assert.equal((await exchange(p, "/unmatched")).response.statusCode, 404);
    const failed = await exchange(p, path);
    assert.equal(failed.response.statusCode, 503); assert.equal(failed.response.body, failure);
    assert.equal((await exchange(p, path)).response.statusCode, 200);
    assert.deepEqual(p.requests.slice(-2).map(({ status }: { status: number }) => status), [503, 200]);
    p.close(); other.close();
  }
});
// A shared release gate or ID reuse would settle both concurrent requests.
test("opaque hold IDs release only their own matched request once", async () => {
  const p = peer(), other = peer();
  const id = p.armNext({ route: "reserve_get", outcome: "hold" });
  assert.equal(typeof id, "string"); assert.throws(() => p.release(id), /not pending/);
  const held = await exchange(p, paths.reserve_get);
  assert.equal(held.response.body, ""); assert.equal(held.response.writableFinished, false);
  // IncomingMessage close after complete body is not connection cancellation.
  held.request.emit("close");
  const id2 = p.armNext({ route: "reserve_get", outcome: "hold" });
  const second = await exchange(p, paths.reserve_get);
  assert.notEqual(id, id2); assert.throws(() => other.release(id), /not pending/);
  p.release(id2); await setImmediate();
  assert.equal(second.response.statusCode, 200); assert.equal(second.response.writableFinished, true);
  assert.equal(held.response.body, "");
  p.release(id); await setImmediate();
  assert.equal(held.response.writableFinished, true); assert.throws(() => p.release(id), /not pending/);
  p.close(); other.close();
});
// Consuming at end rather than arrival would let a later body steal the one-shot.
test("one-shot binds first matching arrival even while its body is incomplete", async () => {
  const p = peer(); const id = p.armNext({ route: "tenant_access_token", outcome: "hold" });
  const first = begin(p, paths.tenant_access_token);
  assert.equal((await exchange(p, paths.tenant_access_token)).response.statusCode, 200);
  assert.throws(() => p.release(id), /not pending/);
  first.request.complete = true; first.request.end(); await setImmediate();
  assert.equal(first.response.body, ""); p.release(id); await setImmediate();
  assert.equal(first.response.statusCode, 200); p.close();
});
// Losing abort/response-close cleanup would leave releasable abandoned holds.
test("request abort, incomplete close and response close cancel matched holds", async () => {
  for (const event of ["aborted", "close", "error", "response-close", "response-error"]) {
    const p = peer(); const id = p.armNext({ route: "ws_endpoint", outcome: "hold" });
    const pair = event === "close" ? begin(p, paths.ws_endpoint) : await exchange(p, paths.ws_endpoint);
    if (event === "response-close") pair.response.destroy();
    else if (event === "response-error") pair.response.emit("error", new Error("private-error"));
    else pair.request.emit(event, new Error("private-error"));
    await setImmediate();
    assert.equal(pair.response.body, ""); assert.equal(pair.response.destroyed, true);
    assert.throws(() => p.release(id), /not pending/);
    assert.deepEqual(p.requests.at(-1), { method: "POST", route: "ws_endpoint", status: 499 });
    p.close();
  }
});
// Disposal must reach body readers and holds, clear future arms, and reject all later operations.
test("close disposes held and incomplete requests and refuses new work", async () => {
  const p = peer(); const id = p.armNext({ route: "ws_endpoint", outcome: "hold" });
  const held = await exchange(p, paths.ws_endpoint);
  const readingId = p.armNext({ route: "reserve_get", outcome: "hold" });
  const reading = begin(p, paths.reserve_get);
  const armedId = p.armNext({ route: "contact_user_get", outcome: "hold" });
  assert.deepEqual(p.readPendingHold(id), { id, method: "POST", route: "ws_endpoint" });
  assert.equal(p.readPendingHold(readingId), null); assert.equal(p.readPendingHold(armedId), null);
  p.close();
  for (const oldId of [id, readingId, armedId]) assert.equal(p.readPendingHold(oldId), null);
  assert.equal(held.response.destroyed, true); assert.equal(reading.request.destroyed, true);
  assert.equal(reading.response.destroyed, true); assert.equal(held.response.body, "");
  assert.throws(() => p.release(id), /closed/); assert.throws(() => p.armNext({ route: "reserve_get", outcome: "hold" }), /closed/);
  const late = await exchange(p, paths.reserve_get);
  assert.equal(late.response.statusCode, 503); assert.equal(late.response.body, '{"code":99,"msg":"peer closed"}');
  assert.throws(() => p.close(), /closed/);
});
test("unknown, contradictory and nonfinite controls refuse without changing a valid arm", async () => {
  const p = peer(); p.armNext({ route: "reserve_get", outcome: "failure" });
  for (const control of [null, {}, { route: "im_message", outcome: "hold" }, { route: "reserve_get", outcome: "success" },
    { route: "reserve_get", outcome: "hold", extra: "private-value" }]) assert.throws(() => p.armNext(control), /invalid control/);
  assert.throws(() => p.armNext({ route: "reserve_get", outcome: "hold" }), /already armed/);
  assert.throws(() => p.release("private-id"), /not pending/);
  assert.equal((await exchange(p, paths.reserve_get)).response.statusCode, 503); p.close();
});
// Oversized readers/held bodies or malformed message JSON must never accept a message or consume unlimited memory.
test("64KiB extent, declared length and malformed message bodies refuse safely", async () => {
  const p = peer();
  assert.equal((await exchange(p, paths.tenant_access_token, Buffer.alloc(65536))).response.statusCode, 200);
  for (const [body, headers, status] of [
    [Buffer.alloc(65537), {}, 413], [Buffer.alloc(1), { "content-length": "65537" }, 413],
    [Buffer.alloc(1), { "content-length": "2" }, 400], [Buffer.alloc(1), { "content-length": "invalid-private" }, 400],
  ] as const) assert.equal((await exchange(p, paths.reserve_get, body, headers)).response.statusCode, status);
  for (const body of ['{"private-body"', 'null', '[]', '{"content":"private-invalid-json"}'])
    assert.equal((await exchange(p, "/im/v1/messages", Buffer.from(body))).response.statusCode, 400);
  assert.equal(p.messages.length, 0); p.close();
});
// Refused extent must drop an assigned hold so later release cannot resurrect it.
test("overflow cancels assigned hold and leaves next matching request usable", async () => {
  const p = peer(); const id = p.armNext({ route: "reserve_get", outcome: "hold" });
  assert.equal((await exchange(p, paths.reserve_get, Buffer.alloc(65537))).response.statusCode, 413);
  assert.throws(() => p.release(id), /not pending/);
  assert.equal((await exchange(p, paths.reserve_get)).response.statusCode, 200); p.close();
});
// Refuse excessive active streams while allowing progress after one owned stream settles.
test("32 pending request bound frees capacity after cancellation", async () => {
  const p = peer(); const streams = Array.from({ length: 32 }, () => begin(p, paths.reserve_get));
  assert.equal((await exchange(p, paths.reserve_get)).response.statusCode, 503);
  streams[0]!.request.emit("aborted");
  assert.equal((await exchange(p, paths.reserve_get)).response.statusCode, 200); p.close();
  assert.equal(streams.every(({ response }) => response.destroyed), true);
});
// Request history rotates; message acceptance has a finite bound without reusing IDs.
test("trace history and accepted messages remain bounded", async () => {
  const p = peer();
  for (let i = 0; i < 260; i++) await exchange(p, paths.reserve_get);
  assert.equal(p.requests.length, 256);
  const body = Buffer.from('{"content":"{}"}');
  for (let i = 0; i < 256; i++) {
    const accepted = await exchange(p, "/im/v1/messages", body);
    assert.equal(accepted.response.statusCode, 200);
    assert.equal(JSON.parse(accepted.response.body).data.message_id, `om_e2e_${i + 1}`);
  }
  const overflow = await exchange(p, "/im/v1/messages", body);
  assert.equal(overflow.response.statusCode, 503); assert.equal(p.messages.length, 256);
  assert.equal(p.requests.length, 256); p.close();
});
// Only method/matched route/status may enter the trace; raw JSON/URL/header/error text must never leak.
test("invalid URL, body and stream errors retain only redacted trace fields", async () => {
  const p = peer();
  await exchange(p, "http://[private-identifier", Buffer.from("private-body"));
  await exchange(p, "/im/v1/messages?private-query", Buffer.from("private-body"));
  const bad = begin(p, paths.reserve_get); bad.request.emit("error", new Error("private-error"));
  const method = begin(p, "/private-identifier", {}, "private-method");
  method.request.complete = true; method.request.end(); await setImmediate();
  assert.deepEqual(p.requests.at(-1), { method: "OTHER", route: "unmatched", status: 404 });
  for (const row of p.requests) assert.deepEqual(Object.keys(row), ["method", "route", "status"]);
  assert.equal(JSON.stringify(p.requests).includes("private"), false);
  assert.equal(JSON.stringify(p.messages).includes("private"), false); p.close();
});

class Wire extends Duplex {
  chunks: Buffer[] = [];
  _read() {}
  _write(chunk: Buffer, _encoding: string, callback: () => void) { this.chunks.push(Buffer.from(chunk)); callback(); }
}
function beginHttp(p: ReturnType<typeof peer>, path: string, method = "POST", headers = {}) {
  const wire = new Wire();
  const request = new IncomingMessage(wire as unknown as Socket);
  request.url = path; request.method = method; request.headers = headers;
  const response = new ServerResponse(request);
  response.assignSocket(wire as unknown as Socket);
  p.handler(request, response);
  return { wire, request, response };
}
async function endHttp(pair: ReturnType<typeof beginHttp>, body = Buffer.alloc(0)) {
  if (body.length) pair.request.push(body);
  pair.request.complete = true; pair.request.push(null); await setImmediate();
}

// An armed ID or body reader is not an arrival fact, and reads cannot settle it.
test("pending fact appears only at actual complete body and is exact immutable data", async () => {
  const p = peer(); const id = p.armNext({ route: "ws_endpoint", outcome: "hold" });
  assert.equal(p.readPendingHold(id), null);
  const pair = beginHttp(p, `${paths.ws_endpoint}?private-query`, "POST",
    { "content-length": "12", authorization: "Bearer private-token" });
  assert.equal(p.readPendingHold(id), null);
  pair.request.push(Buffer.from("private-")); await setImmediate();
  assert.equal(p.readPendingHold(id), null);
  await endHttp(pair, Buffer.from("body"));
  const fact = p.readPendingHold(id);
  assert.deepEqual(fact, { id, method: "POST", route: "ws_endpoint" });
  assert.deepEqual(Reflect.ownKeys(fact), ["id", "method", "route"]);
  assert.equal(Object.isFrozen(fact), true);
  for (const value of Object.values(fact)) assert.equal(typeof value, "string");
  assert.throws(() => { fact.route = "private-route"; }, TypeError);
  assert.throws(() => { (fact as unknown as Record<string, unknown>).extra = "private-extra"; }, TypeError);
  assert.deepEqual(p.readPendingHold(id), { id, method: "POST", route: "ws_endpoint" });
  assert.equal(pair.response.writableFinished, false); assert.equal(pair.wire.chunks.length, 0);
  assert.deepEqual(p.requests, []); assert.deepEqual(p.messages, []);
  p.release(id); await setImmediate();
  assert.equal(pair.response.writableFinished, true); assert.equal(p.readPendingHold(id), null);
  assert.throws(() => p.release(id), /not pending/);
  pair.wire.destroy(); p.close();
});

// Primitive validation must not touch getters/coercions or echo private input.
test("pending reads validate a bounded primitive ID without changing an arm", async () => {
  const p = peer(); const id = p.armNext({ route: "ws_endpoint", outcome: "hold" });
  let touched = 0;
  const object = { get length() { touched++; throw new Error("private-getter"); },
    toString() { touched++; throw new Error("private-coercion"); } };
  for (const invalid of [null, undefined, 1, true, Symbol("private-id"), object, new String(id), "x".repeat(65)]) {
    assert.throws(() => p.readPendingHold(invalid), { message: "e2e_peer_invalid_hold_id" });
  }
  assert.equal(touched, 0);
  for (const absent of ["", "x".repeat(64), "private-unknown", id]) assert.equal(p.readPendingHold(absent), null);
  const pair = beginHttp(p, paths.ws_endpoint); await endHttp(pair);
  assert.deepEqual(p.readPendingHold(id), { id, method: "POST", route: "ws_endpoint" });
  p.close(); await setImmediate();
  assert.equal(p.readPendingHold(id), null); assert.equal(p.readPendingHold(""), null);
  assert.throws(() => p.readPendingHold(object), { message: "e2e_peer_invalid_hold_id" });
  assert.equal(touched, 0); pair.wire.destroy();
});

// A later complete matching body cannot steal the first incomplete request's arm.
test("pending fact belongs to first arrival and not a later complete request", async () => {
  const p = peer(); const id = p.armNext({ route: "ws_endpoint", outcome: "hold" });
  const first = beginHttp(p, paths.ws_endpoint), second = beginHttp(p, paths.ws_endpoint);
  await endHttp(second);
  assert.equal(second.response.writableFinished, true); assert.equal(p.readPendingHold(id), null);
  assert.throws(() => p.release(id), /not pending/);
  await endHttp(first);
  assert.deepEqual(p.readPendingHold(id), { id, method: "POST", route: "ws_endpoint" });
  assert.equal(first.response.writableFinished, false);
  p.release(id); await setImmediate();
  assert.equal(p.readPendingHold(id), null);
  first.wire.destroy(); second.wire.destroy(); p.close();
});

// Invalid extent/overflow cannot install a held fact or restore it on late end.
test("actual HTTP extent refusal never exposes a pending fact", async () => {
  for (const [headers, size, status] of [
    [{ "content-length": "2" }, 1, 400], [{ "content-length": "private-length" }, 0, 400],
    [{ "content-length": "65537" }, 0, 413], [{}, 65537, 413],
  ] as const) {
    const p = peer(); const id = p.armNext({ route: "ws_endpoint", outcome: "hold" });
    const pair = beginHttp(p, paths.ws_endpoint, "POST", headers);
    assert.equal(p.readPendingHold(id), null);
    await endHttp(pair, Buffer.alloc(size));
    assert.equal(pair.response.statusCode, status); assert.equal(p.readPendingHold(id), null);
    pair.request.emit("end"); pair.request.emit("error", new Error("private-error"));
    assert.equal(p.readPendingHold(id), null); assert.throws(() => p.release(id), /not pending/);
    assert.deepEqual(p.requests, [{ method: "POST", route: "ws_endpoint", status }]);
    pair.wire.destroy(); p.close();
  }
  const p = peer(); p.armNext({ route: "ws_endpoint", outcome: "failure" });
  const pair = beginHttp(p, paths.ws_endpoint); await endHttp(pair);
  assert.equal(pair.response.statusCode, 503); assert.equal(p.readPendingHold("private-unknown"), null);
  pair.wire.destroy(); p.close();
});

// Interleaved owners and later arms cannot expose stale or cross-instance facts.
test("pending facts isolate interleaved holds, instances and released IDs", async () => {
  const p = peer(), other = peer();
  const id = p.armNext({ route: "ws_endpoint", outcome: "hold" });
  const first = beginHttp(p, paths.ws_endpoint); await endHttp(first);
  const id2 = p.armNext({ route: "reserve_get", outcome: "hold" });
  const second = beginHttp(p, paths.reserve_get, "GET"); await endHttp(second);
  const foreignId = other.armNext({ route: "ws_endpoint", outcome: "hold" });
  const foreign = beginHttp(other, paths.ws_endpoint); await endHttp(foreign);
  assert.equal(p.readPendingHold(foreignId), null); assert.equal(other.readPendingHold(id), null);
  assert.equal(other.readPendingHold(id2), null); assert.equal(p.readPendingHold("private-wrong"), null);
  p.release(id2); await setImmediate();
  assert.equal(p.readPendingHold(id2), null);
  assert.deepEqual(p.readPendingHold(id), { id, method: "POST", route: "ws_endpoint" });
  assert.deepEqual(other.readPendingHold(foreignId), { id: foreignId, method: "POST", route: "ws_endpoint" });
  const id3 = p.armNext({ route: "reserve_get", outcome: "hold" });
  assert.notEqual(id3, id2); assert.equal(p.readPendingHold(id2), null); assert.equal(p.readPendingHold(id3), null);
  const third = beginHttp(p, paths.reserve_get, "GET"); await endHttp(third);
  assert.equal(p.readPendingHold(id2), null);
  assert.deepEqual(p.readPendingHold(id3), { id: id3, method: "GET", route: "reserve_get" });
  p.close(); other.close(); await setImmediate();
  for (const oldId of [id, id2, id3, foreignId]) assert.equal(p.readPendingHold(oldId), null);
  for (const pair of [first, second, third, foreign]) pair.wire.destroy();
});

// Complete IncomingMessage close preserves ownership; loss/error/disposal clears it once.
test("actual HTTP held facts clear exactly once on cancellation and cannot resurrect", async () => {
  for (const event of ["socket-loss", "response-close", "response-error", "aborted", "error", "incomplete-close", "disposal"]) {
    const p = peer(); const id = p.armNext({ route: "ws_endpoint", outcome: "hold" });
    const pair = beginHttp(p, paths.ws_endpoint);
    if (event !== "incomplete-close") {
      await endHttp(pair);
      assert.equal(pair.request.destroyed, true);
      pair.request.emit("close");
      assert.deepEqual(p.readPendingHold(id), { id, method: "POST", route: "ws_endpoint" });
      assert.deepEqual(p.requests, []);
    } else assert.equal(p.readPendingHold(id), null);
    if (event === "socket-loss") pair.wire.destroy();
    else if (event === "response-close") pair.response.destroy();
    else if (event === "response-error") pair.response.emit("error", new Error("private-error"));
    else if (event === "incomplete-close") pair.request.emit("close");
    else if (event === "disposal") p.close();
    else pair.request.emit(event, new Error("private-error"));
    await setImmediate();
    assert.equal(p.readPendingHold(id), null); assert.equal(pair.response.destroyed, true);
    assert.equal(pair.wire.chunks.length, 0);
    assert.throws(() => p.release(id), event === "disposal" ? /closed/ : /not pending/);
    pair.request.complete = true; pair.request.emit("end"); pair.request.emit("aborted");
    pair.request.emit("error", new Error("private-late-error")); pair.response.emit("error", new Error("private-late-error"));
    assert.equal(p.readPendingHold(id), null);
    assert.deepEqual(p.requests, [{ method: "POST", route: "ws_endpoint", status: 499 }]);
    if (event !== "disposal") p.close();
    assert.equal(p.readPendingHold(id), null); assert.throws(() => p.close(), /closed/);
    pair.wire.destroy();
  }
});

// Pending fact storage shares the existing 32-owner cap; rejected arrival keeps its arm.
test("held facts share the pending bound without consuming a refused arrival arm", async () => {
  const p = peer(); const held = [];
  for (let i = 0; i < 32; i++) {
    const id = p.armNext({ route: "ws_endpoint", outcome: "hold" });
    const pair = beginHttp(p, paths.ws_endpoint); await endHttp(pair, Buffer.alloc(i === 0 ? 65536 : 0));
    assert.deepEqual(p.readPendingHold(id), { id, method: "POST", route: "ws_endpoint" });
    held.push({ id, pair });
  }
  const nextId = p.armNext({ route: "ws_endpoint", outcome: "hold" });
  const refused = beginHttp(p, paths.ws_endpoint); await endHttp(refused);
  assert.equal(refused.response.statusCode, 503); assert.equal(p.readPendingHold(nextId), null);
  p.release(held[0]!.id); await setImmediate();
  assert.equal(p.readPendingHold(held[0]!.id), null);
  const admitted = beginHttp(p, paths.ws_endpoint); await endHttp(admitted);
  assert.deepEqual(p.readPendingHold(nextId), { id: nextId, method: "POST", route: "ws_endpoint" });
  p.close(); await setImmediate();
  for (const { id, pair } of held) { assert.equal(p.readPendingHold(id), null); pair.wire.destroy(); }
  assert.equal(p.readPendingHold(nextId), null);
  assert.equal(p.requests.filter(({ status }: { status: number }) => status === 499).length, 32);
  refused.wire.destroy(); admitted.wire.destroy();
});

// Unknown methods must be normalized before handler entry; no private input enters a fact.
test("held fact method normalization and all five routes preserve finite privacy", async () => {
  for (const [route, path] of Object.entries(paths)) {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT", "TRACE", "private-method"]) {
      const p = peer(); const id = p.armNext({ route, outcome: "hold" });
      const pair = beginHttp(p, `${path}${path.includes("?") ? "&" : "?"}private-query`, method,
        { authorization: "Bearer private-token", "x-private": "private-header" });
      await endHttp(pair, Buffer.from("private-body"));
      const fact = p.readPendingHold(id);
      assert.deepEqual(fact, { id, method: method === "private-method" ? "OTHER" : method, route });
      assert.deepEqual(Reflect.ownKeys(fact), ["id", "method", "route"]);
      assert.equal(Object.isFrozen(fact), true); assert.equal(JSON.stringify(fact).includes("private"), false);
      p.close(); await setImmediate();
      assert.equal(p.readPendingHold(id), null);
      assert.equal(JSON.stringify(p.requests).includes("private"), false);
      pair.wire.destroy();
    }
  }
});

// Source contract is intentionally narrow: do not start the peer's real listener.
test("real peer forwards the exact controls pending-read method", () => {
  const source = readFileSync(new URL("./feishu-peer.mjs", import.meta.url), "utf8");
  assert.match(source, /readPendingHold:\s*controls\.readPendingHold\s*,/);
});

// Exercise actual HTTP lifecycle classes on an in-memory Duplex, with no
// createServer/listen/connect: complete request close differs from socket loss.
test("Node HTTP completion keeps a hold releasable while socket loss cancels it", async () => {
  const p = peer();
  for (const lost of [false, true]) {
    const wire = new Wire();
    const request = new IncomingMessage(wire as unknown as Socket);
    request.url = paths.reserve_get; request.method = "GET";
    const response = new ServerResponse(request);
    response.assignSocket(wire as unknown as Socket);
    const id = p.armNext({ route: "reserve_get", outcome: "hold" });
    p.handler(request, response);
    request.complete = true; request.push(null); await setImmediate();
    assert.equal(request.destroyed, true); assert.equal(wire.chunks.length, 0);
    if (lost) {
      wire.destroy(); await setImmediate();
      assert.throws(() => p.release(id), /not pending/);
      assert.equal(response.destroyed, true);
      assert.equal(wire.chunks.length, 0);
    } else {
      p.release(id); await setImmediate();
      assert.equal(response.writableFinished, true);
      assert.equal(Buffer.concat(wire.chunks).toString().split("\r\n\r\n")[1],
        '{"code":0,"msg":"ok","data":{"reserve":{"id":"reserve-e2e-1","meeting_no":"100","reserve_user_id":"ou_e2e_organizer"}}}');
      wire.destroy();
    }
  }
  p.close();
});
