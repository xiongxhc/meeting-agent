import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer, IncomingMessage } from "node:http";
import type { Server } from "node:http";
import type { WebSocketServer } from "ws";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { once } from "node:events";
import { Duplex } from "node:stream";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import test from "node:test";
// Load the private JavaScript boundary by URL, without a compiler suppression.
const peer: unknown = await import(new URL("./feishu-peer.mjs", import.meta.url).href);
type UpgradeEvent = Readonly<{ ordinal: number; id: string | null;
  kind: "held" | "accepted" | "remote_closed" | "fixture_closed" | "refused" }>;
type UpgradeControls = Readonly<{
  handler: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  armNextUpgrade: () => string;
  readPendingUpgrade: (id: unknown) => Readonly<{ id: string; method: "GET"; route: "ws_upgrade"; arrival: number }> | null;
  readUpgradeObservation: () => Readonly<{ arrivals: number; accepted: number; pending: number;
    disposed: boolean; invalid: boolean; overflow: boolean; events: readonly UpgradeEvent[] }>;
  close: () => Promise<void>;
}>;
type UpgradePeer = Readonly<{ websocket: WebSocketServer; controls: UpgradeControls; close: () => Promise<void> }>;
function createFeishuUpgradeServer(server: Server): UpgradePeer {
  assert.ok(peer && typeof peer === "object");
  const factory: unknown = Reflect.get(peer, "createFeishuUpgradeServer");
  assert.equal(typeof factory, "function", "peer must own the real pending upgrade before 101");
  return (factory as (server: Server) => UpgradePeer)(server);
}

class Wire extends Duplex {
  chunks: Buffer[] = [];
  destroyRequested = false;
  completeDestroy: ((error?: Error | null) => void) | undefined;
  constructor() { super({ allowHalfOpen: true, autoDestroy: false }); }
  _read() {}
  _write(chunk: Buffer, _encoding: string, callback: () => void) { this.chunks.push(Buffer.from(chunk)); callback(); }
  _destroy(_error: Error | null, callback: (error?: Error | null) => void) {
    this.destroyRequested = true; this.completeDestroy = callback;
  }
  settleClose() { this.destroy(); this.completeDestroy!(); }
}
const headers = {
  upgrade: "websocket", connection: "keep-alive, Upgrade",
  "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
};
function fixture() {
  const server = createServer();
  const { websocket, controls, close } = createFeishuUpgradeServer(server);
  return { server, websocket, controls, close };
}
function request(wire: Wire, url = "/ws?private-query", method = "GET", values = headers) {
  const message = new IncomingMessage(wire as unknown as Socket);
  message.url = url; message.method = method; message.headers = { ...values };
  return message;
}
function arrive(p: ReturnType<typeof fixture>, wire = new Wire(), url?: string, method?: string,
  values?: typeof headers, head = Buffer.alloc(0)) {
  const message = request(wire, url, method, values);
  p.server.emit("upgrade", message, wire, head);
  return { wire, message };
}
async function cleanup(p: ReturnType<typeof fixture>, wires: Wire[]) {
  const closed = p.close();
  for (const wire of wires) wire.settleClose();
  await closed;
  await new Promise<void>((resolve) => p.websocket.close(() => resolve()));
}
// Catch returning an armed fact or accepting instead of holding the callback.
test("actual GET upgrade creates one immutable held fact without 101", async () => {
  const p = fixture(), id = p.controls.armNextUpgrade();
  assert.match(id, /^[\da-f-]{36}$/); assert.equal(Object.isFrozen(p.controls), true);
  assert.equal(p.controls.readPendingUpgrade(id), null);
  const pair = arrive(p);
  const fact = p.controls.readPendingUpgrade(id);
  assert.deepEqual(fact, { id, method: "GET", route: "ws_upgrade", arrival: 1 });
  assert.deepEqual(Reflect.ownKeys(fact!), ["id", "method", "route", "arrival"]);
  assert.equal(Object.isFrozen(fact), true); assert.equal(pair.wire.chunks.length, 0);
  for (let i = 0; i < 3; i++) assert.equal(p.controls.readPendingUpgrade(id), fact);
  assert.deepEqual(p.controls.readUpgradeObservation(), { arrivals: 1, accepted: 0, pending: 1,
    disposed: false, invalid: false, overflow: false, events: [{ ordinal: 1, id, kind: "held" }] });
  await cleanup(p, [pair.wire]);
});

// Catch coercion/getter access, unknown-ID substitution and cross-owner state.
test("bounded primitive reads and one outstanding arm stay inert and private", async () => {
  const p = fixture(), other = fixture(), id = p.controls.armNextUpgrade();
  const foreign = other.controls.armNextUpgrade();
  let touched = 0;
  const privateValue = { get length() { touched++; throw new Error("private-getter"); },
    toString() { touched++; throw new Error("private-coercion"); } };
  for (const value of [null, undefined, 1, true, 1n, Symbol("private"), privateValue, new String(id), "x".repeat(65)])
    assert.throws(() => p.controls.readPendingUpgrade(value), { message: "e2e_peer_invalid_upgrade_id" });
  assert.equal(touched, 0);
  for (const value of ["", "x".repeat(64), "private-unknown", foreign, id]) assert.equal(p.controls.readPendingUpgrade(value), null);
  assert.throws(() => p.controls.armNextUpgrade(), { message: "e2e_peer_upgrade_busy" });
  const pair = arrive(p), otherPair = arrive(other);
  assert.equal(p.controls.readPendingUpgrade(foreign), null); assert.equal(other.controls.readPendingUpgrade(id), null);
  assert.throws(() => p.controls.armNextUpgrade(), { message: "e2e_peer_upgrade_busy" });
  assert.equal(JSON.stringify(p.controls.readUpgradeObservation()).includes("private"), false);
  await cleanup(p, [pair.wire]); await cleanup(other, [otherPair.wire]);
  assert.equal(p.controls.readPendingUpgrade(id), null);
  assert.throws(() => p.controls.armNextUpgrade(), { message: "e2e_peer_upgrade_closed" });
});

// Catch normalized aliases, relaxed headers/extents or invalid consumption of arm.
test("invalid handshake inputs refuse without consuming the valid selected arm", async () => {
  const badInputs = [
    { method: "POST" }, { url: "/WS" }, { url: "/a/../ws" }, { url: "/%77s" },
    { url: "/ws#private-fragment" }, { url: "http://private/ws" }, { url: "/ws/" },
    { url: "/ws?" + "x".repeat(2045) },
    { values: { ...headers, upgrade: "private" } },
    { values: { ...headers, connection: "private-upgrade" } },
    { values: { ...headers, "sec-websocket-version": "8" } },
    { values: { ...headers, "sec-websocket-version": "013" } },
    { values: { ...headers, "sec-websocket-key": "private-key" } },
    { values: { ...headers, "sec-websocket-key": "A".repeat(23) + "=" } },
    { values: { ...headers, "content-length": "1" } },
    { values: { ...headers, "content-length": "00" } },
    { values: { ...headers, "transfer-encoding": "chunked" } },
    { values: { ...headers, "x-private": "x".repeat(2049) } },
    { values: { ...headers, ...Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`x-${i}`, "private"])) } },
    { head: Buffer.from("private-head") },
  ];
  for (const input of badInputs) {
    const p = fixture(), id = p.controls.armNextUpgrade();
    const bad = arrive(p, new Wire(), input.url, input.method, input.values, input.head);
    assert.equal(p.controls.readPendingUpgrade(id), null);
    assert.equal(bad.wire.destroyRequested, true); assert.equal(bad.wire.chunks.length, 0);
    assert.equal(p.controls.readUpgradeObservation().invalid, true);
    const good = arrive(p);
    assert.deepEqual(p.controls.readPendingUpgrade(id), { id, method: "GET", route: "ws_upgrade", arrival: 2 });
    assert.equal(JSON.stringify(p.controls.readUpgradeObservation()).includes("private"), false);
    await cleanup(p, [bad.wire, good.wire]);
  }
});

// Catch body/header duplicates and bytes buffered before callback as valid holds.
test("preexisting bytes and nonlive sockets cannot create a held fact", async () => {
  for (const input of ["request-data", "socket-data", "end", "destroy", "headers-duplicate", "raw-overflow"]) {
    const p = fixture(), id = p.controls.armNextUpgrade(), wire = new Wire(), message = request(wire);
    if (input === "request-data") message.push(Buffer.from("private-body"));
    if (input === "socket-data") wire.push(Buffer.from("private-frame"));
    if (input === "end") { wire.push(null); wire.resume(); await setImmediate(); }
    if (input === "destroy") wire.destroy();
    if (input === "headers-duplicate") message.rawHeaders = ["Sec-WebSocket-Key", headers["sec-websocket-key"], "Sec-WebSocket-Key", headers["sec-websocket-key"]];
    if (input === "raw-overflow") message.rawHeaders = ["X-private", "x".repeat(8193)];
    p.server.emit("upgrade", message, wire, Buffer.alloc(0));
    assert.equal(p.controls.readPendingUpgrade(id), null);
    assert.equal(p.controls.readUpgradeObservation().invalid, true);
    assert.equal(wire.destroyRequested, true);
    await cleanup(p, [wire]);
  }
});

// Catch request-message close or remote end being mislabeled transport settlement.
test("request close and remote FIN alone retain ownership until actual socket close", async () => {
  const p = fixture(), id = p.controls.armNextUpgrade(), pair = arrive(p);
  pair.message.emit("close"); pair.wire.push(null); await setImmediate();
  assert.equal(pair.wire.readableEnded, true); assert.equal(pair.wire.destroyRequested, false);
  assert.equal(p.controls.readPendingUpgrade(id)?.id, id);
  assert.equal(p.controls.readUpgradeObservation().pending, 1);
  assert.deepEqual(p.controls.readUpgradeObservation().events.map((event) => event.kind), ["held"]);
  pair.wire.settleClose(); await setImmediate();
  assert.equal(p.controls.readPendingUpgrade(id), null);
  assert.deepEqual(p.controls.readUpgradeObservation(), { arrivals: 1, accepted: 0, pending: 0,
    disposed: false, invalid: false, overflow: false,
    events: [{ ordinal: 1, id, kind: "held" }, { ordinal: 2, id, kind: "remote_closed" }] });
  await cleanup(p, []);
});

// Catch requested destroy counting as close or close clearing a never-closing socket.
test("memoized fixture cleanup waits for actual close and cannot fake pending zero", async () => {
  const p = fixture(), id = p.controls.armNextUpgrade(), pair = arrive(p);
  pair.wire.destroy();
  assert.equal(p.controls.readUpgradeObservation().pending, 1);
  assert.equal(p.controls.readPendingUpgrade(id)?.id, id);
  const closed = p.controls.close(), again = p.controls.close();
  assert.equal(closed, again);
  let settled = false; void closed.then(() => { settled = true; });
  await setImmediate();
  const unconfirmed = p.controls.readUpgradeObservation();
  assert.equal(settled, false); assert.equal(unconfirmed.pending, 1); assert.equal(unconfirmed.disposed, true);
  assert.equal(p.controls.readPendingUpgrade(id)?.id, id);
  pair.wire.push(null); await setImmediate();
  assert.equal(settled, false);
  pair.wire.settleClose(); await closed;
  assert.equal(p.controls.close(), closed); assert.equal(p.controls.readPendingUpgrade(id), null);
  assert.deepEqual(p.controls.readUpgradeObservation().events.map((event) => event.kind), ["held", "fixture_closed"]);
  assert.equal(unconfirmed.pending, 1);
  pair.wire.emit("close"); pair.wire.emit("end"); pair.wire.emit("data", Buffer.from("private-late"));
  pair.wire.emit("error", new Error("private-late"));
  assert.deepEqual(p.controls.readUpgradeObservation().events.map((event) => event.kind), ["held", "fixture_closed"]);
  await new Promise<void>((resolve) => p.websocket.close(() => resolve()));
});

// Catch missing resumed data/error observers or locally refused close as remote.
test("held pre101 data or error is adverse and retained until its real close", async () => {
  for (const event of ["data", "error"]) {
    const p = fixture(), id = p.controls.armNextUpgrade(), pair = arrive(p);
    if (event === "data") { pair.wire.push(Buffer.from("private-frame")); await setImmediate(); }
    else pair.wire.emit("error", new Error("private-error"));
    assert.equal(p.controls.readUpgradeObservation().invalid, true);
    assert.equal(pair.wire.destroyRequested, true); assert.equal(pair.wire.chunks.length, 0);
    assert.equal(p.controls.readUpgradeObservation().pending, 1);
    assert.equal(p.controls.readPendingUpgrade(id)?.id, id);
    pair.wire.settleClose(); await setImmediate();
    assert.equal(p.controls.readPendingUpgrade(id), null);
    assert.deepEqual(p.controls.readUpgradeObservation().events.map((entry) => entry.kind), ["held", "refused"]);
    assert.equal(JSON.stringify(p.controls.readUpgradeObservation()).includes("private"), false);
    pair.wire.emit("error", new Error("private-late"));
    await cleanup(p, []);
  }
});

// Catch ordinary path not using real public handleUpgrade, automatic acceptance,
// duplicate callback acceptance or upgrade owner retaining accepted lifetime.
test("shared peer wiring forwards ordinary handshake once and transfers accepted lifetime", async () => {
  const p = fixture();
  assert.equal(p.websocket.options.noServer, true); assert.equal(p.websocket.options.server, null);
  assert.deepEqual(p.server.listeners("upgrade"), [p.controls.handler]);
  let connections = 0;
  let acceptedRequest: IncomingMessage | undefined;
  p.websocket.on("connection", (socket, incoming) => { connections++; acceptedRequest = incoming; socket.on("error", () => {}); });
  const pair = arrive(p);
  assert.equal(connections, 1); assert.equal(acceptedRequest, pair.message); assert.equal(p.websocket.clients.size, 1);
  assert.match(Buffer.concat(pair.wire.chunks).toString(), /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.deepEqual(p.controls.readUpgradeObservation(), { arrivals: 1, accepted: 1, pending: 0,
    disposed: false, invalid: false, overflow: false, events: [{ ordinal: 1, id: null, kind: "accepted" }] });
  await p.close();
  assert.equal(pair.wire.destroyRequested, false); assert.equal(p.websocket.clients.size, 1);
  assert.equal(p.server.listeners("upgrade").length, 0);
  p.controls.handler(pair.message, pair.wire, Buffer.alloc(0));
  assert.equal(connections, 1); assert.equal(p.controls.readUpgradeObservation().accepted, 1);
  assert.equal(p.controls.readUpgradeObservation().invalid, true);
  for (const socket of p.websocket.clients) socket.terminate();
  pair.wire.settleClose(); await setImmediate();
  await new Promise<void>((resolve) => p.websocket.close(() => resolve()));
});

// Catch duplicate callback replacing an owned hold or passing same socket to ws.
test("duplicate held socket callback refuses once without a second owner or acceptance", async () => {
  const p = fixture(), id = p.controls.armNextUpgrade(), pair = arrive(p);
  p.server.emit("upgrade", pair.message, pair.wire, Buffer.alloc(0));
  assert.equal(p.controls.readUpgradeObservation().pending, 1);
  assert.equal(p.controls.readUpgradeObservation().accepted, 0);
  assert.equal(p.controls.readPendingUpgrade(id)?.id, id);
  assert.deepEqual(p.controls.readUpgradeObservation().events.map((event) => event.kind), ["held", "refused"]);
  await cleanup(p, [pair.wire]);
  assert.equal(p.controls.readUpgradeObservation().events.some((event) => event.kind === "remote_closed"), false);
});

// Catch cap growth, silent eviction, resettable flags and refused sockets relabeled remote.
test("four retained unaccepted sockets and sixteen events have sticky saturation", async () => {
  const p = fixture(), wires: Wire[] = [];
  for (let i = 0; i < 4; i++) wires.push(arrive(p, new Wire(), "/private-invalid").wire);
  assert.equal(p.controls.readUpgradeObservation().pending, 4);
  const overflow = arrive(p, new Wire(), "/private-invalid").wire; wires.push(overflow);
  assert.equal(overflow.destroyRequested, true);
  assert.equal(p.controls.readUpgradeObservation().pending, 4);
  assert.equal(p.controls.readUpgradeObservation().overflow, true);
  for (const wire of wires) wire.settleClose(); await setImmediate();
  assert.equal(p.controls.readUpgradeObservation().pending, 1);
  for (let i = 0; i < 20; i++) {
    const wire = arrive(p, new Wire(), "/private-invalid").wire;
    wire.settleClose(); await setImmediate();
  }
  const observation = p.controls.readUpgradeObservation();
  assert.equal(observation.events.length, 16); assert.equal(observation.invalid, true); assert.equal(observation.overflow, true);
  assert.equal(observation.events[0]?.ordinal, 1);
  assert.equal(observation.events.some((event) => event.kind === "remote_closed"), false);
  assert.equal(Object.isFrozen(observation), true); assert.equal(Object.isFrozen(observation.events), true);
  assert.equal(observation.events.every(Object.isFrozen), true);
  assert.deepEqual(Reflect.ownKeys(observation), ["arrivals", "accepted", "pending", "disposed", "invalid", "overflow", "events"]);
  for (const event of observation.events) assert.deepEqual(Reflect.ownKeys(event), ["ordinal", "id", "kind"]);
  assert.throws(() => (observation.events as unknown as unknown[]).push("private"), TypeError);
  const closed = p.close(); let settled = false;
  void closed.then(() => { settled = true; }); await setImmediate();
  assert.equal(settled, false); // Saturation permanently leaves cleanup unconfirmed.
  await new Promise<void>((resolve) => p.websocket.close(() => resolve()));
});

// Catch broad listener removal or direct late callbacks escaping disposal ownership.
test("disposal detaches only own handler and retained late arrival awaits real close", async () => {
  const p = fixture(); let foreign = 0;
  const listener = () => { foreign++; };
  p.server.on("upgrade", listener);
  const closed = p.close();
  assert.deepEqual(p.server.listeners("upgrade"), [listener]);
  const wire = new Wire(), pair = { wire, message: request(wire) };
  p.controls.handler(pair.message, pair.wire, Buffer.alloc(0));
  assert.equal(pair.wire.destroyRequested, true);
  assert.equal(p.controls.readUpgradeObservation().pending, 1);
  assert.equal(p.controls.readUpgradeObservation().invalid, true);
  assert.equal(p.close(), closed);
  let settled = false; void closed.then(() => { settled = true; });
  await setImmediate(); assert.equal(settled, false);
  pair.wire.settleClose(); await closed;
  assert.equal(p.controls.readUpgradeObservation().pending, 0);
  assert.equal(p.controls.readUpgradeObservation().events.some((event) => event.kind === "remote_closed"), false);
  assert.equal(foreign, 0);
  await new Promise<void>((resolve) => p.websocket.close(() => resolve()));
});

// Catch unbounded sink registration on repeated request callbacks and late state resurrection.
test("repeated callbacks retain one static request error sink and no late history", async () => {
  const p = fixture(), id = p.controls.armNextUpgrade(), pair = arrive(p);
  for (let i = 0; i < 5; i++) p.controls.handler(pair.message, pair.wire, Buffer.alloc(0));
  assert.equal(pair.message.listenerCount("error"), 1);
  assert.equal(pair.wire.listenerCount("close"), 1);
  assert.equal(p.controls.readUpgradeObservation().pending, 1);
  assert.equal(p.controls.readPendingUpgrade(id)?.id, id);
  pair.wire.settleClose(); await setImmediate();
  const terminal = p.controls.readUpgradeObservation();
  for (let i = 0; i < 5; i++) {
    pair.message.emit("error", new Error("private-late-request"));
    pair.wire.emit("error", new Error("private-late-socket"));
    pair.wire.emit("close"); pair.wire.emit("data", Buffer.from("private-late-data"));
  }
  assert.deepEqual(p.controls.readUpgradeObservation(), terminal);
  await cleanup(p, []);
});

// Catch public handleUpgrade refusing without marking the still-owned transport adverse.
test("public handshake refusal retains its real socket and sticky invalid observation", async () => {
  const p = fixture(), wire = new Wire(), message = request(wire);
  message.headers["sec-websocket-protocol"] = "private invalid protocol";
  p.server.emit("upgrade", message, wire, Buffer.alloc(0));
  assert.equal(p.controls.readUpgradeObservation().accepted, 0);
  assert.equal(p.controls.readUpgradeObservation().pending, 1);
  assert.equal(p.controls.readUpgradeObservation().invalid, true);
  assert.equal(wire.destroyRequested, true);
  assert.equal(Buffer.concat(wire.chunks).toString().includes("101"), false);
  assert.equal(JSON.stringify(p.controls.readUpgradeObservation()).includes("private"), false);
  await cleanup(p, [wire]);
});

// Catch an application-requested destroy being counted before close, or marked fixture cleanup.
test("external destroy remains pending until actual prefixture close records remote cancellation", async () => {
  const p = fixture(), id = p.controls.armNextUpgrade(), pair = arrive(p);
  pair.wire.destroy(); await setImmediate();
  assert.equal(p.controls.readPendingUpgrade(id)?.id, id);
  assert.equal(p.controls.readUpgradeObservation().pending, 1);
  assert.deepEqual(p.controls.readUpgradeObservation().events.map((event) => event.kind), ["held"]);
  pair.wire.settleClose(); await setImmediate();
  assert.equal(p.controls.readPendingUpgrade(id), null);
  assert.deepEqual(p.controls.readUpgradeObservation().events.map((event) => event.kind), ["held", "remote_closed"]);
  const settled = p.controls.readUpgradeObservation();
  await cleanup(p, []);
  assert.deepEqual(p.controls.readUpgradeObservation(), { ...settled, disposed: true });
});


// Catch normal cleanup fulfilling after only four tracked closes while a fifth
// untracked refused transport has never produced an actual socket close.
test("never-closing fifth refusal leaves cleanup sticky unconfirmed without more owner references", async () => {
  const p = fixture(), tracked: Wire[] = [];
  for (let i = 0; i < 4; i++) tracked.push(arrive(p, new Wire(), "/private-invalid").wire);
  const fifth = arrive(p, new Wire(), "/private-invalid").wire;
  const closed = p.close(); assert.equal(p.close(), closed);
  let settled = false; void closed.then(() => { settled = true; });
  for (const wire of tracked) wire.settleClose();
  await setImmediate();
  assert.equal(fifth.destroyRequested, true); assert.equal(fifth.closed, false);
  assert.equal(settled, false, "unknown excess transport close must not fulfill cleanup");
  const unconfirmed = p.controls.readUpgradeObservation();
  assert.equal(unconfirmed.pending, 1); assert.equal(unconfirmed.disposed, true);
  assert.equal(unconfirmed.invalid, true); assert.equal(unconfirmed.overflow, true);
  assert.deepEqual(unconfirmed.events.map((event) => event.kind), ["refused", "refused", "refused", "refused", "refused"]);
  fifth.emit("end"); fifth.emit("error", new Error("private-excess-error"));
  assert.equal(settled, false); assert.deepEqual(p.controls.readUpgradeObservation(), unconfirmed);
  fifth.settleClose(); await setImmediate();
  assert.equal(fifth.closed, true); assert.equal(settled, false);
  assert.deepEqual(p.controls.readUpgradeObservation(), unconfirmed);
  assert.equal(p.close(), closed);
  await new Promise<void>((resolve) => p.websocket.close(() => resolve()));
});

// Real loopback TCP: the application owner destroys its socket (FIN, not RST).
// The server-side upgrade socket is allowHalfOpen, so only a peer reply to FIN
// lets the actual close arrive before fixture cleanup.
async function tcpHeld() {
  const server = createServer(), upgrade = createFeishuUpgradeServer(server);
  let client: Socket | undefined, closing: Promise<void> | undefined;
  // Cleanup exists before any assertion, so a failed hold cannot leak the transport.
  const done = () => closing ??= (async () => {
    client?.destroy(); await upgrade.close();
    await new Promise<void>((resolve) => upgrade.websocket.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  })();
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const id = upgrade.controls.armNextUpgrade(), address = server.address();
    assert.ok(address && typeof address === "object");
    client = connect(address.port, "127.0.0.1"); await once(client, "connect");
    client.write("GET /ws?private-query HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n"
      + "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
    for (let i = 0; i < 200 && upgrade.controls.readPendingUpgrade(id) === null; i++) await delay(5);
    assert.equal(upgrade.controls.readPendingUpgrade(id)?.id, id);
    return { id, client, controls: upgrade.controls, done };
  } catch (error) { await done(); throw error; }
}
const kinds = (controls: UpgradeControls) => controls.readUpgradeObservation().events.map((event) => event.kind);

// Catch a peer that leaves an actual client FIN half-open until fixture cleanup.
test("real TCP client destroy of a held upgrade settles remote_closed before fixture cleanup", { timeout: 5000 }, async () => {
  const t = await tcpHeld();
  try {
    t.client.destroy();
    for (let i = 0; i < 200 && t.controls.readUpgradeObservation().pending !== 0; i++) await delay(5);
    assert.equal(t.controls.readPendingUpgrade(t.id), null);
    assert.deepEqual(t.controls.readUpgradeObservation(), { arrivals: 1, accepted: 0, pending: 0,
      disposed: false, invalid: false, overflow: false,
      events: [{ ordinal: 1, id: t.id, kind: "held" }, { ordinal: 2, id: t.id, kind: "remote_closed" }] });
  } finally { await t.done(); }
  assert.deepEqual(kinds(t.controls), ["held", "remote_closed"]);
});

// Catch a peer that closes a live held upgrade without any client FIN.
test("real TCP held upgrade without client FIN stays pending until fixture cleanup", { timeout: 5000 }, async () => {
  const t = await tcpHeld();
  try {
    await delay(200);
    assert.equal(t.controls.readPendingUpgrade(t.id)?.id, t.id);
    assert.equal(t.controls.readUpgradeObservation().pending, 1);
    assert.deepEqual(kinds(t.controls), ["held"]);
    assert.equal(t.client.readableEnded, false);
  } finally { await t.done(); }
  assert.deepEqual(kinds(t.controls), ["held", "fixture_closed"]);
});
