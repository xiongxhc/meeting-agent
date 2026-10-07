import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
// @ts-expect-error Private harness JavaScript has no declaration.
const peer = await import("./feishu-peer.mjs");

type Observation = { kind: "ack"; messageId: string; payload: { code: number; data?: string } }
  | { kind: "ping" } | { kind: "invalid"; reason: string };
type Receiver = { receive: (bytes: unknown) => void; acknowledgements: unknown[];
  observations: (Exclude<Observation, { kind: "ping" }> & { ordinal: number })[];
  invalid: boolean; overflow: boolean };
function observer(): (bytes: unknown) => Observation {
  const fn: unknown = Reflect.get(peer, "observeFeishuFrame");
  assert.equal(typeof fn, "function", "Export the bounded parser used by the real receive callback");
  return fn as (bytes: unknown) => Observation;
}
function receiver(): Receiver {
  const fn: unknown = Reflect.get(peer, "createFeishuFrameReceiver");
  assert.equal(typeof fn, "function", "Export the same receive handler registered on the WebSocket");
  return (fn as () => Receiver)();
}
// Explicitly synthetic published protobuf bytes; no SDK/server/listener starts.
function vint(value: number): Buffer {
  const bytes = [];
  do { const byte = value % 128; value = Math.floor(value / 128); bytes.push(byte + (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
function integer(index: number, value: number) { return Buffer.concat([vint(index * 8), vint(value)]); }
function bytes(index: number, value: Buffer | string) {
  const body = typeof value === "string" ? Buffer.from(value) : value;
  return Buffer.concat([vint(index * 8 + 2), vint(body.length), body]);
}
function header(key: Buffer | string, value: Buffer | string) { return bytes(5, Buffer.concat([bytes(1, key), bytes(2, value)])); }
function reply({ id = "wire-one", code = 200, headers, payload }: {
  id?: string; code?: number; headers?: Buffer[]; payload?: string } = {}) {
  return Buffer.concat([integer(1, 1), integer(2, 1), integer(3, 1), integer(4, 1),
    ...(headers ?? [header("message_id", id), header("sum", "1"), header("seq", "0"), header("type", "event"), header("trace_id", "synthetic"), header("biz_rt", "-2")]),
    bytes(8, payload ?? JSON.stringify({ code }))]);
}
function ping() { return Buffer.concat([integer(1, 0), integer(2, 0), integer(3, 1), integer(4, 0), header("type", "ping")]); }
function invalid(frame: unknown) {
  const observed = observer()(frame);
  assert.equal(observed.kind, "invalid");
  assert.deepEqual(Object.keys(observed).sort(), ["kind", "reason"]);
  if (observed.kind === "invalid") assert.match(observed.reason, /^e2e_frame_[a-z_]+$/);
}

test("source-shaped SDK success and failure replies retain exact wire identity and actual payload", () => {
  assert.deepEqual(observer()(reply({ payload: '{"code":200,"data":"YWJj"}' })),
    { kind: "ack", messageId: "wire-one", payload: { code: 200, data: "YWJj" } });
  assert.deepEqual(observer()(reply({ id: "wire-two", code: 500 })),
    { kind: "ack", messageId: "wire-two", payload: { code: 500 } });
});

test("header ordering and payload placement do not replace message_id with trace or biz_rt", () => {
  const frame = Buffer.concat([bytes(8, '{"code":200}'), header("biz_rt", "nonauthoritative"),
    header("type", "event"), integer(4, 1), header("message_id", "exact-id"), header("trace_id", "wrong-id")]);
  assert.deepEqual(observer()(frame), { kind: "ack", messageId: "exact-id", payload: { code: 200 } });
});

test("normal pinned-SDK pings do not poison or exhaust ACK history", () => {
  const r = receiver();
  for (let n = 0; n < 100; n++) r.receive(ping());
  assert.deepEqual(observer()(ping()), { kind: "ping" });
  assert.deepEqual(observer()(Buffer.concat([ping(), bytes(8, "")])), { kind: "ping" });
  assert.deepEqual(r.observations as Receiver["observations"], []); assert.deepEqual(r.acknowledgements, []);
  assert.equal(r.invalid, false); assert.equal(r.overflow, false);
  r.receive(reply()); assert.equal(r.observations[0]?.ordinal, 101);
  invalid(Buffer.concat([ping(), bytes(8, '{"code":200}')]));
});

test("missing empty duplicate IDs and wrong method or type cannot become ACKs", () => {
  for (const headers of [[header("type", "event")], [header("type", "event"), header("message_id", "")],
    [header("type", "event"), header("message_id", "one"), header("message_id", "two")],
    [header("type", "event"), header("type", "event"), header("message_id", "one")],
    [header("type", "pong"), header("message_id", "one")],
    [header("type", "event"), header("message_id", "one"), header("sum", "1"), header("sum", "1")]]) invalid(reply({ headers }));
  invalid(Buffer.concat([integer(4, 0), header("type", "event"), header("message_id", "one"), bytes(8, '{"code":200}')]));
  invalid(Buffer.concat([integer(4, 2), header("type", "event"), header("message_id", "one"), bytes(8, '{"code":200}')]));
});

test("duplicate protobuf singular fields and nested header fields are refused", () => {
  for (const extra of [integer(4, 1), bytes(8, '{"code":500}'), integer(1, 2)]) invalid(Buffer.concat([reply(), extra]));
  for (const nested of [Buffer.concat([bytes(1, "type"), bytes(1, "type"), bytes(2, "event")]),
    Buffer.concat([bytes(1, "type"), bytes(2, "event"), bytes(2, "event")]), bytes(1, "type"), bytes(2, "event")]) {
    invalid(reply({ headers: [bytes(5, nested), header("message_id", "one")] }));
  }
});

test("UTF-8 limits count bytes and reject invalid encoding without retaining content", () => {
  const id = "é".repeat(128);
  assert.equal((observer()(reply({ id })) as Extract<Observation, { kind: "ack" }>).messageId, id);
  invalid(reply({ id: "é".repeat(129) }));
  const goodHeaders = [header("type", "event"), header("message_id", "one")];
  assert.equal(observer()(reply({ headers: [...goodHeaders, header("é".repeat(32), "x")] })).kind, "ack");
  invalid(reply({ headers: [...goodHeaders, header("é".repeat(33), "x")] }));
  assert.equal(observer()(reply({ headers: [...goodHeaders, header("extra", "é".repeat(128))] })).kind, "ack");
  invalid(reply({ headers: [...goodHeaders, header("extra", "é".repeat(129))] }));
  invalid(reply({ headers: [header("type", "event"), header("message_id", Buffer.from([0xc3, 0x28]))] }));
  invalid(reply({ headers: [...goodHeaders, header(Buffer.from([0xff]), "secret-token")] }));
  invalid(Buffer.concat([integer(4, 1), ...goodHeaders, bytes(8, Buffer.from([0xff]))]));
});

test("frame payload and header-count boundaries are checked before parse or allocation", () => {
  const payload = '{"code":200,"data":"' + "x".repeat(8170) + '"}';
  assert.equal(Buffer.byteLength(payload), 8192);
  assert.equal(observer()(reply({ payload })).kind, "ack");
  invalid(reply({ payload: payload + " " }));
  const headers = [header("message_id", "one"), header("type", "event"),
    ...Array.from({ length: 30 }, (_, n) => header(`extra-${n}`, "x"))];
  assert.equal(observer()(reply({ headers })).kind, "ack");
  invalid(reply({ headers: [...headers, header("extra-30", "x")] }));
  const base = reply();
  const sized = Buffer.concat([base, bytes(9, Buffer.alloc(65536 - base.length - 4))]);
  assert.equal(sized.length, 65536); assert.equal(observer()(sized).kind, "ack");
  invalid(Buffer.concat([sized, Buffer.from([0]) ]));
});

test("truncated unsafe noncanonical varints invalid tags and wire types fail finitely", () => {
  for (const frame of [Buffer.alloc(0), Buffer.from([0x80]), Buffer.from([32, 0x80]),
    Buffer.from([32, 0x81, 0]), Buffer.from([0]), Buffer.from([0x21]), Buffer.from([0x25]),
    Buffer.from([32, ...Array<number>(9).fill(0xff), 1]), Buffer.from([0xff, 0xff, 0xff, 0xff, 0x7f]),
    Buffer.concat([reply(), Buffer.from([74, 0x80])]), Buffer.concat([reply(), Buffer.from([74, 9, 1])])]) invalid(frame);
  invalid(Buffer.concat([bytes(4, "1"), header("type", "event"), header("message_id", "one"), bytes(8, '{"code":200}')]));
  invalid(Buffer.concat([integer(4, 1), integer(5, 1), bytes(8, '{"code":200}')]));
  invalid(Buffer.concat([reply(), integer(8, 1)]));
  assert.equal(observer()(Buffer.concat([reply(), integer(10, Number.MAX_SAFE_INTEGER)])).kind, "ack");
  invalid(Buffer.concat([reply(), integer(10, 2 ** 53)]));
  invalid(Buffer.concat([integer(4, 2 ** 32), header("type", "event"), header("message_id", "one"), bytes(8, '{"code":200}')]));
});

test("nested extents must stay inside their declared header and include both string fields", () => {
  for (const nested of [Buffer.from([10, 10, 97]), Buffer.from([10, 0x80]), Buffer.from([10, 0, 18, 0]),
    Buffer.concat([bytes(1, "type"), Buffer.from([18, 10, 97])]),
    Buffer.concat([bytes(1, "type"), integer(2, 1)]),
    Buffer.concat([bytes(1, "type"), bytes(2, "event"), bytes(3, "unknown")])]) invalid(reply({ headers: [bytes(5, nested), header("message_id", "one")] }));
});

test("published numeric and string frame fields keep their wire and UTF-8 shape", () => {
  const event = Buffer.concat([integer(4, 1), header("type", "event"), header("message_id", "one"), bytes(8, '{"code":200}')]);
  for (const index of [1, 2, 3]) invalid(Buffer.concat([event, bytes(index, "wrong-wire")]));
  for (const index of [6, 7, 9]) {
    invalid(Buffer.concat([event, integer(index, 1)]));
    invalid(Buffer.concat([event, bytes(index, Buffer.from([0xff]))]));
  }
  assert.equal(observer()(Buffer.concat([event, bytes(6, ""), bytes(7, "application/json"), bytes(9, "synthetic-log")])).kind, "ack");
});

test("only an object with integer success or failure code qualifies as event ACK", () => {
  for (const payload of ["{", "null", "[]", '"token"', "200", "{}", '{"code":"200"}', '{"code":200.1}', '{"code":201}']) invalid(reply({ payload }));
  invalid(Buffer.concat([integer(4, 1), header("type", "event"), header("message_id", "one")]));
});

test("receive callback records static invalid facts without throwing and remains sticky", () => {
  const r = receiver();
  for (const value of [null, "private-token", Buffer.from([0x80]), reply({ payload: "private-token" })]) assert.doesNotThrow(() => r.receive(value));
  r.receive(reply());
  assert.equal(r.invalid, true); assert.equal(r.overflow, false);
  assert.equal(r.observations.length, 5); assert.equal(r.observations[4]?.kind, "ack");
  for (const entry of r.observations.slice(0, 4)) assert.deepEqual(Object.keys(entry).sort(), ["kind", "ordinal", "reason"]);
  assert.equal(JSON.stringify(r.observations).includes("private-token"), false);
});

test("unknown mismatched and repeated valid IDs remain facts for downstream correlation", () => {
  const r = receiver();
  for (const id of ["unknown", "stale-phase", "wire-one", "wire-one"]) r.receive(reply({ id }));
  assert.deepEqual(r.observations.map((row) => row.kind === "ack" ? [row.ordinal, row.messageId] : null),
    [[1, "unknown"], [2, "stale-phase"], [3, "wire-one"], [4, "wire-one"]]);
  assert.equal(r.invalid, false); assert.equal(r.overflow, false);
});

test("64 retained observations never evict evidence and overflow cannot recover", () => {
  const r = receiver();
  for (let n = 0; n < 64; n++) r.receive(reply({ id: `wire-${n}` }));
  assert.equal(r.overflow, false); r.receive(reply({ id: "omitted-id" })); r.receive(ping()); r.receive(Buffer.from([0x80]));
  assert.equal(r.observations.length, 64); assert.equal(r.overflow, true); assert.equal(r.invalid, true);
  assert.deepEqual(r.observations[0], { ordinal: 1, kind: "ack", messageId: "wire-0", payload: { code: 200 } });
  assert.deepEqual(r.observations[63], { ordinal: 64, kind: "ack", messageId: "wire-63", payload: { code: 200 } });
  assert.equal(r.acknowledgements.length, 65);
});

test("valid legacy projection and framePayload remain unchanged alongside exact observation", () => {
  const payload = { code: 200, data: "synthetic-reply" };
  const frame = peer.eventFrame(payload, "legacy-wire");
  assert.deepEqual(peer.framePayload(frame), payload);
  const r = receiver(); r.receive(frame); r.receive(reply({ code: 500 })); r.receive(ping());
  assert.deepEqual(r.acknowledgements, [payload, { code: 500 }]);
  assert.deepEqual(r.observations[0], { ordinal: 1, kind: "ack", messageId: "legacy-wire", payload });
  // Code-only legacy framing remains observable as a projection, never exact ACK evidence.
  r.receive(Buffer.concat([integer(4, 1), bytes(8, '{"code":200}')]));
  assert.equal(r.invalid, true);
  assert.deepEqual(r.acknowledgements[2], { code: 200 });
  for (const value of [{ legacy: "projection" }, [1], 0, false, null]) {
    const legacy = peer.eventFrame(value, "legacy-wire");
    assert.deepEqual(peer.framePayload(legacy), value); r.receive(legacy);
  }
  assert.deepEqual(r.acknowledgements.slice(3), [{ legacy: "projection" }, [1]]);
});

test("receive histories and sticky refusals belong to one peer only", () => {
  const first = receiver(), second = receiver();
  first.receive(Buffer.from([0x80])); second.receive(reply({ id: "other-peer" }));
  assert.equal(first.invalid, true); assert.equal(second.invalid, false);
  assert.deepEqual(first.acknowledgements, []);
  assert.deepEqual(second.observations, [{ ordinal: 1, kind: "ack", messageId: "other-peer", payload: { code: 200 } }]);
});

 test("selected backlog receiver keeps257 facts and sticky258 overflow without changing default64", () => {
  const fn = peer.createFeishuFrameReceiver;
  assert.throws(() => fn("unsupported"), /e2e_receiver_profile/);
  const selected = fn("backlog-257");
  for (let n = 0; n < 257; n++) selected.receive(reply({ id: `backlog-${n}` }));
  assert.equal(selected.observations.length, 257); assert.equal(selected.overflow, false);
  selected.receive(reply({ id: "258" })); selected.receive(ping());
  assert.equal(selected.observations.length, 257); assert.equal(selected.overflow, true);
  assert.equal(selected.observations[256].messageId, "backlog-256");
  const fresh = fn("backlog-257"); assert.equal(fresh.overflow, false);
 });
