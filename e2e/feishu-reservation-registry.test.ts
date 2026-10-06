import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { Writable, PassThrough, Duplex } from "node:stream";
import { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { URL } from "node:url";
// @ts-expect-error Private harness JavaScript has no declaration.
const controlsModule = await import("./feishu-peer-controls.mjs");
// @ts-expect-error Private harness JavaScript has no declaration.
const registryModule = await import("./feishu-reservation-registry.mjs").catch(() => ({}));

type Reservation = { reserveId: string; meeting: { providerMeetingId: string; meetingNo: string; startSeconds: number; title: string };
  organizer: { openId: string; displayName: string } };
type Trace = { method: string; route: string; status: number };
type Request = PassThrough & { url: string; method: string; complete: boolean; aborted: boolean; headers: Record<string, string> };
type Controls = { handler(request: Request | IncomingMessage, response: Response | ServerResponse): void; requests: Trace[];
  armNext(control: { route: string; outcome: string }): string | undefined; release(id: string | undefined): void; close(): void };
type Lookup = { route: string; status: number; body: unknown };
type Registry = { lookup(request: { method: string; url: URL }): Lookup | null };
function createControls(options: object): Controls {
  return (Reflect.get(controlsModule, "createFeishuPeerControls") as (options: object) => Controls)(options);
}
function registry(reservations: unknown): Registry {
  const create = Reflect.get(registryModule, "createFeishuReservationRegistry");
  assert.equal(typeof create, "function", "Expose the immutable external metadata registry");
  return (create as (options: { reservations: unknown }) => Registry)({ reservations });
}
function record(index = 1): Reservation {
  return { reserveId: `reserve-private-${index}`, meeting: { providerMeetingId: `meeting-private-${index}`,
    meetingNo: String(100000000 + index), startSeconds: 1791288000 + index, title: `Private title ${index}` },
  organizer: { openId: `ou_private_${index}`, displayName: `Private organizer ${index}` } };
}
function peer(t: TestContext, reservations: Reservation[] = [record(1), record(2)]): Controls {
  const p = createControls({ reservations, wsPath: () => "ws://peer.invalid/ws" });
  t.after(() => { try { p.close(); } catch (error) { assert.match(String(error), /e2e_peer_closed/); } });
  return p;
}
class Response extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  chunks: Buffer[] = [];
  setHeader(name: string, value: string) { this.headers[name] = value; }
  _write(chunk: Buffer, _encoding: string, callback: () => void) { this.chunks.push(Buffer.from(chunk)); callback(); }
  get body() { return Buffer.concat(this.chunks).toString("utf8"); }
}
function begin(p: Controls, path: string, method = "GET", headers: Record<string, string> = {}) {
  const request: Request = Object.assign(new PassThrough(), { url: path, method, complete: false, aborted: false,
    headers: { authorization: "Bearer private-token", ...headers } });
  const response = new Response(); p.handler(request, response);
  return { request, response };
}
async function exchange(p: Controls, path: string, method = "GET", body = Buffer.alloc(0), headers: Record<string, string> = {}) {
  const pair = begin(p, path, method, headers);
  pair.request.write(body); pair.request.complete = true; pair.request.end(); await setImmediate();
  return pair;
}
function paths(r: Reservation) {
  return [`/open-apis/vc/v1/reserves/${r.reserveId}/get_active_meeting?with_participants=false&user_id_type=open_id`,
    `/vc/v1/reserves/${r.reserveId}?user_id_type=open_id`, `/open-apis/contact/v3/users/${r.organizer.openId}?user_id_type=open_id`];
}
// Expectations use independent registration data, never a registry response builder.
function bodies(r: Reservation) {
  return [{ code: 0, msg: "ok", data: { meeting: { id: r.meeting.providerMeetingId, meeting_no: r.meeting.meetingNo,
    start_time: String(r.meeting.startSeconds), topic: r.meeting.title } } },
  { code: 0, msg: "ok", data: { reserve: { id: r.reserveId, meeting_no: r.meeting.meetingNo, reserve_user_id: r.organizer.openId } } },
  { code: 0, msg: "ok", data: { user: { open_id: r.organizer.openId, name: r.organizer.displayName } } }];
}
async function expectResponse(p: Controls, path: string, status: number, body: unknown, method = "GET") {
  const { response } = await exchange(p, path, method);
  assert.equal(response.statusCode, status, path); assert.deepEqual(JSON.parse(response.body), body, path);
  assert.equal(response.headers["content-type"], "application/json");
}
const unavailable = { code: 99, msg: "not scripted" }, invalid = { code: 99, msg: "invalid request" };

// A global/current registration or organizer fallback would cross-wire this interleaving.
test("actual handler interleaves all three metadata routes without crossing identities", async (t) => {
  const a = record(1), b = record(2), p = peer(t, [a, b]);
  for (const [r, index] of [[a, 0], [b, 1], [a, 2], [b, 0], [a, 1], [b, 2]] as const) {
    await expectResponse(p, paths(r)[index]!, 200, bodies(r)[index]);
  }
  await expectResponse(p, `/vc/v1/reserves/${a.reserveId}/get_active_meeting?user_id_type=open_id&with_participants=false`, 200, bodies(a)[0]);
  await expectResponse(p, `/contact/v3/users/${b.organizer.openId}?user_id_type=open_id`, 200, bodies(b)[2]);
});

// These registrations supply external identities; they do not prove K1/K2 admission.
for (const size of [1, 2, 4, 8, 10, 16]) test(`all ${size} immutable registrations remain independently retrievable`, async (t) => {
  const registrations = Array.from({ length: size }, (_, index) => record(index + 1));
  const p = peer(t, registrations);
  for (const r of registrations) for (const [index, path] of paths(r).entries()) await expectResponse(p, path, 200, bodies(r)[index]);
});

test("constructor refuses empty, non-array, oversized and mutually exclusive inputs before returning controls", () => {
  for (const input of [[], null, undefined, {}, "private", Array.from({ length: 17 }, (_, i) => record(i + 1))]) {
    assert.throws(() => registry(input), { message: "e2e_peer_invalid_registry" });
    assert.throws(() => createControls({ reservations: input, wsPath: () => "private" }), { message: "e2e_peer_invalid_registry" });
  }
  for (const options of [{}, { meeting: record().meeting, reservations: [record()] }, { meeting: undefined, reservations: [record()] }])
    assert.throws(() => createControls(options), { message: "e2e_peer_invalid_registry" });
  let reads = 0;
  const oversized = Array.from({ length: 17 }, (_, i) => record(i + 1));
  Object.defineProperty(oversized, "0", { enumerable: true, get() { reads++; return record(); } });
  assert.throws(() => registry(oversized), { message: "e2e_peer_invalid_registry" }); assert.equal(reads, 0);
});

test("conflicting identities refuse while agreeing shared organizers and equal display names stay independent", async (t) => {
  const a = record(1);
  for (const b of [record(1), { ...record(2), reserveId: a.reserveId },
    { ...record(2), meeting: { ...record(2).meeting, meetingNo: a.meeting.meetingNo } },
    { ...record(2), meeting: { ...record(2).meeting, providerMeetingId: a.meeting.providerMeetingId } },
    { ...record(2), organizer: { openId: a.organizer.openId, displayName: "Different private name" } }]) {
    assert.throws(() => registry([a, b]), { message: "e2e_peer_invalid_registry" });
    assert.throws(() => createControls({ reservations: [a, b] }), { message: "e2e_peer_invalid_registry" });
  }
  const b = { ...record(2), organizer: { ...a.organizer } };
  const c = { ...record(3), organizer: { ...record(3).organizer, displayName: a.organizer.displayName } };
  const p = peer(t, [a, b, c]);
  for (const r of [a, b, c]) for (const [index, path] of paths(r).entries()) await expectResponse(p, path, 200, bodies(r)[index]);
});

test("closed JSON record shapes reject missing, extra, accessor, hidden, symbol and nonplain fields without invoking accessors", () => {
  let reads = 0;
  for (const level of ["record", "meeting", "organizer"] as const) {
    for (const mutation of ["missing", "extra", "getter", "hidden", "symbol", "prototype", "array", "null"]) {
      const r = record();
      const target = (level === "record" ? r : r[level]) as unknown as Record<PropertyKey, unknown>;
      const key = Object.keys(target)[0]!;
      if (mutation === "missing") delete target[key];
      if (mutation === "extra") target.privateExtra = "private-leak";
      if (mutation === "getter") Object.defineProperty(target, key, { enumerable: true, get() { reads++; return "private-leak"; } });
      if (mutation === "hidden") Object.defineProperty(target, key, { enumerable: false });
      if (mutation === "symbol") target[Symbol("private")] = "private-leak";
      if (mutation === "prototype") Object.setPrototypeOf(target, { privateExtra: "private-leak" });
      const replacement = mutation === "array" ? [] : mutation === "null" ? null : target;
      const input = level === "record" ? replacement : { ...r, [level]: replacement };
      assert.throws(() => registry([input]), { message: "e2e_peer_invalid_registry" });
    }
  }
  assert.equal(reads, 0);
});

test("primitive validation closes identity, text, number and UTF-8 bounds with static errors", () => {
  const changes: Array<(r: Reservation) => void> = [];
  for (const value of ["", "private/slash", "private%2D", "private.dot", "é", "a".repeat(129), 1, null]) {
    for (const key of ["reserveId", "providerMeetingId", "openId"] as const) changes.push((r) => {
      const target = key === "reserveId" ? r : key === "providerMeetingId" ? r.meeting : r.organizer;
      Reflect.set(target, key, value);
    });
  }
  for (const value of ["", "  ", "private\n", "private\u007f", "private\u0000", "é".repeat(2049), 1, null])
    for (const key of ["title", "displayName"] as const) changes.push((r) => { Reflect.set(key === "title" ? r.meeting : r.organizer, key, value); });
  for (const value of ["123", "1234567890", "１２３４５６７８９", 100000001, null]) changes.push((r) => { Reflect.set(r.meeting, "meetingNo", value); });
  for (const value of [-1, 1.5, 253402300800, Infinity, NaN, "123", null]) changes.push((r) => { Reflect.set(r.meeting, "startSeconds", value); });
  for (const change of changes) {
    const r = record(); change(r);
    assert.throws(() => registry([r]), { message: "e2e_peer_invalid_registry" });
  }
});

test("exact valid bounds and accepted whitespace are preserved in complete response bodies", async (t) => {
  const r = { reserveId: "r".repeat(128), meeting: { providerMeetingId: "m".repeat(128), meetingNo: "000000000",
    startSeconds: 253402300799, title: " é".repeat(1365) + " " }, organizer: { openId: "o".repeat(128), displayName: "é".repeat(2048) } };
  assert.equal(Buffer.byteLength(r.meeting.title), 4096);
  const zero = { ...record(2), meeting: { ...record(2).meeting, startSeconds: 0 } };
  const p = peer(t, [r, zero]);
  for (const input of [r, zero]) for (const [index, path] of paths(input).entries()) await expectResponse(p, path, 200, bodies(input)[index]);
});

test("unknown and malformed paths never fall through to legacy metadata or another organizer", async (t) => {
  const r = record(), p = peer(t, [r]);
  for (const path of ["/vc/v1/reserves/unknown", "/vc/v1/reserves/reserve-e2e-1", "/contact/v3/users/unknown",
    "/contact/v3/users/ou_e2e_organizer", `/vc/v1/reserves/${r.reserveId}/`, `/vc/v1/reserves/${r.reserveId}/extra`,
    `/vc/v1/reserves/${r.reserveId}/get_active_meeting/extra`, `/contact/v3/users/${r.organizer.openId}/`,
    `/extra/vc/v1/reserves/${r.reserveId}`, `/unrelated/contact/v3/users/${r.organizer.openId}`,
    "/vc/v1/reserves/", "/contact/v3/users/", `/vc/v1/reserves/${r.reserveId.replace("-", "%2D")}`,
    `/contact/v3/users/${r.organizer.openId.replace("_", "%5F")}`, `/vc/v1/reserves/extra/../${r.reserveId}`,
    `/vc/v1/reserves/extra/%2E%2E/${r.reserveId}`, `/vc/v1/reserves\\${r.reserveId}`])
    await expectResponse(p, path + "?user_id_type=open_id", 404, unavailable);
  for (const [index, path] of paths(r).entries()) await expectResponse(p, path, 200, bodies(r)[index]);
});

test("registered routes accept only real GET query names, exact values and unique complete fields", async (t) => {
  const r = record(), p = peer(t, [r]);
  for (const [index, good] of paths(r).entries()) {
    const path = good.split("?")[0]!;
    const required = index === 0 ? "&with_participants=false" : "";
    for (const query of ["", "id_type=open_id", "userIdType=open_id", "user_id_type=user_id", "user_id_type=private-secret",
      "user_id_type=open_id&user_id_type=open_id", "user_id_type=open_id&user_id_type=user_id", "user_id_type=open_id&private=private-secret"]) {
      await expectResponse(p, path + "?" + query + required, 400, invalid);
    }
    await expectResponse(p, good, 400, invalid, "POST");
    await expectResponse(p, good, 200, bodies(r)[index]);
  }
  for (const query of ["user_id_type=open_id", "user_id_type=open_id&with_participants=true",
    "user_id_type=open_id&with_participants=false&with_participants=false"]) await expectResponse(p, paths(r)[0]!.split("?")[0] + "?" + query, 400, invalid);
  await expectResponse(p, paths(r)[1] + "&with_participants=false", 400, invalid);
  await expectResponse(p, "/vc/v1/reserves/unknown?private=private-secret", 404, unavailable, "POST");
  assert.equal(JSON.stringify(p.requests).includes("private"), false);
});

test("registry exposes only frozen lookup responses and ignores all subsequent caller changes", async (t) => {
  const a = record(), b = record(2), inputs = [a, b], original = structuredClone(a);
  const lookup = registry(inputs), p = peer(t, inputs);
  assert.equal(Object.isFrozen(lookup), true); assert.deepEqual(Object.keys(lookup), ["lookup"]);
  const result = lookup.lookup({ method: "GET", url: new URL(paths(a)[0]!, "http://peer.invalid") });
  assert.ok(result); assert.equal(Object.isFrozen(result), true);
  const frozen = result.body as { data: { meeting: { topic: string } } };
  assert.equal(Object.isFrozen(frozen), true); assert.equal(Object.isFrozen(frozen.data), true); assert.equal(Object.isFrozen(frozen.data.meeting), true);
  assert.throws(() => { frozen.data.meeting.topic = "changed"; }, TypeError);
  const id = p.armNext({ route: "reserve_get", outcome: "hold" }), held = await exchange(p, paths(a)[1]!);
  a.reserveId = "changed"; a.meeting.title = "changed"; a.meeting.meetingNo = "999999999";
  a.meeting.providerMeetingId = "changed"; a.meeting.startSeconds = 0;
  a.organizer.openId = "changed"; a.organizer.displayName = "changed";
  inputs.splice(0, 2, record(3)); inputs.push(record(4));
  await expectResponse(p, paths(b)[1]!, 200, bodies(b)[1]); assert.equal(held.response.body, "");
  p.release(id); assert.deepEqual(JSON.parse(held.response.body), bodies(original)[1]);
  for (const [index, path] of paths(original).entries()) await expectResponse(p, path, 200, bodies(original)[index]);
  await expectResponse(p, paths(record(3))[1]!, 404, unavailable);
  assert.deepEqual(result.body, bodies(original)[0]);
  assert.equal(lookup.lookup({ method: "GET", url: new URL("/im/v1/messages", "http://peer.invalid") }), null);
});

test("P1 arms bind the next valid route request without consuming on unknown or invalid metadata", async (t) => {
  const a = record(), b = record(2), p = peer(t), other = peer(t, [record(3)]);
  p.armNext({ route: "reserve_get", outcome: "failure" });
  await expectResponse(p, "/vc/v1/reserves/unknown?user_id_type=open_id", 404, unavailable);
  await expectResponse(p, paths(a)[1] + "&extra=private", 400, invalid);
  await expectResponse(p, paths(a)[0]!, 200, bodies(a)[0]);
  await expectResponse(other, paths(a)[1]!, 404, unavailable);
  await expectResponse(other, paths(record(3))[1]!, 200, bodies(record(3))[1]);
  await expectResponse(p, paths(b)[1]!, 503, { code: 99, msg: "scripted failure" });
  await expectResponse(p, paths(a)[1]!, 200, bodies(a)[1]);
  const id = p.armNext({ route: "reserve_get", outcome: "hold" });
  assert.throws(() => p.release(id), /not pending/);
  await expectResponse(p, paths(a)[1] + "&extra=private", 400, invalid);
  const held = await exchange(p, paths(a)[1]!);
  await expectResponse(p, paths(b)[1]!, 200, bodies(b)[1]); assert.equal(held.response.body, "");
  p.release(id); assert.deepEqual(JSON.parse(held.response.body), bodies(a)[1]); assert.throws(() => p.release(id), /not pending/);
  assert.throws(() => p.release("unknown"), /not pending/);
});

test("metadata binds on arrival before a held request body completes", async (t) => {
  const a = record(), b = record(2), p = peer(t);
  const id = p.armNext({ route: "reserve_active_meeting", outcome: "hold" });
  const first = begin(p, paths(a)[0]!);
  await expectResponse(p, paths(b)[0]!, 200, bodies(b)[0]); assert.throws(() => p.release(id), /not pending/);
  first.request.complete = true; first.request.end(); await setImmediate(); assert.equal(first.response.body, "");
  p.release(id); assert.deepEqual(JSON.parse(first.response.body), bodies(a)[0]);
});

test("fragment suffixes cannot alias registered HTTP metadata identities", async (t) => {
  const r = record(), p = peer(t, [r]);
  for (const path of paths(r)) for (const fragment of ["#private-fragment", "#"])
    await expectResponse(p, path + fragment, 404, unavailable);
  assert.equal(JSON.stringify(p.requests).includes("private"), false);
});

test("registry requests preserve cancellation, finite body readers, close and bounded redacted history", async (t) => {
  const p = peer(t), path = paths(record())[1]!;
  for (const event of ["aborted", "close", "error", "response-close", "response-error"]) {
    const id = p.armNext({ route: "reserve_get", outcome: "hold" });
    const pair = event === "close" ? begin(p, path) : await exchange(p, path);
    if (event === "response-close") pair.response.destroy();
    else if (event === "response-error") pair.response.emit("error", new Error("private-error"));
    else pair.request.emit(event, new Error("private-error"));
    await setImmediate(); assert.equal(pair.response.destroyed, true); assert.equal(pair.response.body, "");
    assert.throws(() => p.release(id), /not pending/);
  }
  const readers = Array.from({ length: 32 }, () => begin(p, path));
  assert.equal((await exchange(p, path)).response.statusCode, 503);
  readers[0]!.request.emit("aborted"); await expectResponse(p, path, 200, bodies(record())[1]);
  for (const pair of readers) pair.request.emit("aborted");
  assert.equal((await exchange(p, path, "GET", Buffer.alloc(65536))).response.statusCode, 200);
  assert.equal((await exchange(p, path, "GET", Buffer.alloc(65537))).response.statusCode, 413);
  for (let index = 0; index < 260; index++) await exchange(p, [path, "/contact/v3/users/private-unknown?private-secret",
    "/contact/v3/users/private%2Fmalformed?private-secret", "http://[private-invalid-url"][index % 4]!);
  assert.equal(p.requests.length, 256);
  for (const row of p.requests) assert.deepEqual(Object.keys(row), ["method", "route", "status"]);
  assert.equal(JSON.stringify(p.requests).includes("private"), false);
  const id = p.armNext({ route: "reserve_get", outcome: "hold" }), held = await exchange(p, path), unfinished = begin(p, path);
  p.close(); assert.equal(held.response.destroyed, true); assert.equal(unfinished.response.destroyed, true);
  assert.throws(() => p.release(id), /closed/); assert.throws(() => p.armNext({ route: "reserve_get", outcome: "hold" }), /closed/);
  await expectResponse(p, path, 503, { code: 99, msg: "peer closed" }); assert.throws(() => p.close(), /closed/);
});

test("actual IncomingMessage completion preserves held identity while socket loss cancels it", async (t) => {
  class Wire extends Duplex {
    chunks: Buffer[] = [];
    _read() {}
    _write(chunk: Buffer, _encoding: string, callback: () => void) { this.chunks.push(Buffer.from(chunk)); callback(); }
  }
  const r = record(), p = peer(t, [r]);
  for (const lost of [false, true]) {
    const wire = new Wire(); t.after(() => wire.destroy());
    const request = new IncomingMessage(wire as unknown as Socket); request.url = paths(r)[1]!; request.method = "GET";
    const response = new ServerResponse(request); response.assignSocket(wire as unknown as Socket);
    const id = p.armNext({ route: "reserve_get", outcome: "hold" }); p.handler(request, response);
    request.complete = true; request.push(null); await setImmediate();
    assert.equal(request.destroyed, true); assert.equal(wire.chunks.length, 0);
    if (lost) {
      wire.destroy(); await setImmediate(); assert.throws(() => p.release(id), /not pending/); assert.equal(response.destroyed, true);
    } else {
      p.release(id); await setImmediate(); assert.equal(response.writableFinished, true);
      assert.deepEqual(JSON.parse(Buffer.concat(wire.chunks).toString().split("\r\n\r\n")[1]!), bodies(r)[1]); wire.destroy();
    }
  }
});
