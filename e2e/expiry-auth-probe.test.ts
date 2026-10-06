import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
// @ts-expect-error Test-only JS.
import * as probes from "./expiry-auth-probe.mjs";
// @ts-expect-error Pure private harness JavaScript.
import { validateExpiryEvidence } from "./expiry-evidence.mjs";

const lease = { mediaProtocolVersion: 3, endpoint: "tcp://127.0.0.1:1234", expiresAtMs: 1n,
  sessionId: 7n, bridgeSessionId: "bridge", credential: "private-synthetic-token" };
// Listener-free component socket. All addresses and wire bytes are synthetic.
class ComponentFakeSocket extends EventEmitter {
  localAddress: string | undefined = "127.0.0.1";
  localPort: number | undefined = 43210;
  remoteAddress: string | undefined = "127.0.0.1";
  remotePort: number | undefined = 1234;
  destroyed = false;
  wire: Buffer | null = null;
  writeCallback: ((error?: Error) => void) | null = null;
  deferWrite = false;
  writeError: Error | null = null;
  write(bytes: Buffer, callback: (error?: Error) => void) {
    this.wire = bytes; this.writeCallback = callback;
    if (this.writeError) throw this.writeError;
    if (!this.deferWrite) callback();
  }
  destroy() {
    this.destroyed = true;
    this.localAddress = this.remoteAddress = undefined;
    this.localPort = this.remotePort = undefined;
    this.emit("close");
  }
}
function peer(socket = new ComponentFakeSocket(), reconnectDeadline = performance.now() + 1000) {
  return { socket, reconnectDeadline,
    connect: () => { queueMicrotask(() => socket.emit("connect")); return socket; } };
}
const empty = { local: null, remote: null, connected: false, writeCompleted: false,
  receivedBytes: 0, orderlyEnd: false, error: null, timedOut: false };
const good = { ...empty, local: "127.0.0.1:43210", remote: "127.0.0.1:1234",
  connected: true, writeCompleted: true, orderlyEnd: true };
async function start(transport = peer()) {
  const result = probes.probeExpiredCredential(lease, transport);
  await Promise.resolve();
  return { result, socket: transport.socket };
}

test("fresh probe returns actual connect tuple retained after socket destruction", async () => {
  assert.equal(typeof probes.probeExpiredCredential, "function");
  const { result, socket } = await start();
  socket.emit("end");
  const observation = await result;
  assert.deepEqual(observation, good);
  assert.equal(Object.isFrozen(observation), true);
  assert.equal(socket.destroyed, true);
  assert.equal(socket.localAddress, undefined);
  assert.equal(socket.wire?.toString("hex"), "4d454433030100000027000000000000000717707269766174652d73796e7468657469632d746f6b656e06627269646765");
});

test("probe uses actual IPv6, bracketed and mapped endpoints rather than lease address", async () => {
  for (const [local, remote, wantLocal, wantRemote] of [
    ["2001:0DB8:0:0:0:0:0:1", "[::1]", "[2001:db8::1]:43210", "[::1]:1234"],
    ["::ffff:127.0.0.1", "[0:0:0:0:0:ffff:7f00:2]", "127.0.0.1:43210", "127.0.0.2:1234"],
    ["fe80::1%4", "[fe80::2%4]", "[fe80::1%4]:43210", "[fe80::2%4]:1234"],
  ]) {
    const socket = new ComponentFakeSocket(); socket.localAddress = local; socket.remoteAddress = remote;
    const { result } = await start(peer(socket)); socket.emit("end");
    assert.deepEqual(await result, { ...good, local: wantLocal, remote: wantRemote });
  }
});

test("invalid observed addresses or noninteger and out-of-range ports cannot supply a tuple", async () => {
  for (const fields of [
    { localAddress: "localhost" }, { remoteAddress: "[::1" }, { localAddress: "127.00.0.1" },
    { localAddress: "fe80::1%en0" }, { localPort: 0 }, { remotePort: 65536 }, { localPort: 1.5 },
    { localPort: "43210" }, { remotePort: undefined },
  ]) {
    const socket = Object.assign(new ComponentFakeSocket(), fields);
    const { result } = await start(peer(socket));
    const observation = await result;
    assert.deepEqual(observation, { ...empty, connected: true, error: "socket_address" });
    assert.equal(socket.wire, null);
  }
});

test("orderly EOF before complete write stays nonpassing even after a late successful callback", async () => {
  const socket = new ComponentFakeSocket(); socket.deferWrite = true;
  const { result } = await start(peer(socket)); socket.emit("end");
  const observation = await result;
  socket.writeCallback?.();
  assert.deepEqual(observation, { ...good, writeCompleted: false });
});

test("EOF before connect is not an authenticated refusal", async () => {
  const socket = new ComponentFakeSocket();
  const result = probes.probeExpiredCredential(lease, { reconnectDeadline: performance.now() + 1000, connect: () => socket });
  socket.emit("end");
  assert.deepEqual(await result, { ...empty, orderlyEnd: true });
});

test("write callback errors and synchronous write errors return safe closed facts", async () => {
  for (const throws of [false, true]) {
    const socket = new ComponentFakeSocket(); socket.deferWrite = true;
    if (throws) socket.writeError = new Error(lease.credential);
    const { result } = await start(peer(socket));
    if (!throws) socket.writeCallback?.(new Error(lease.credential));
    assert.deepEqual(await result, { ...good, writeCompleted: false, orderlyEnd: false, error: "write_error" });
  }
});

test("socket reset and early close return nonpassing facts without raw errors", async () => {
  for (const event of ["error", "close"] as const) {
    const { result, socket } = await start(); socket.emit(event, new Error(lease.credential));
    const observation = await result;
    assert.deepEqual(observation, { ...good, orderlyEnd: false, error: event === "error" ? "socket_error" : "socket_closed" });
    assert.equal(JSON.stringify(observation).includes(lease.credential), false);
  }
});

test("connect error and thrown connection failure never report an orderly authenticated EOF", async () => {
  const socket = new ComponentFakeSocket();
  const result = probes.probeExpiredCredential(lease, { reconnectDeadline: performance.now() + 1000, connect: () => socket });
  socket.emit("error", new Error(lease.credential));
  assert.deepEqual(await result, { ...empty, error: "socket_error" });
  assert.deepEqual(await probes.probeExpiredCredential(lease, { reconnectDeadline: performance.now() + 1000,
    connect: () => { throw new Error(lease.credential); } }), { ...empty, error: "connect_error" });
});

test("ACK and arbitrary received bytes refuse and retain only the byte count", async () => {
  for (const data of [Buffer.from("ACK"), Buffer.from(lease.credential), Buffer.alloc(0)]) {
    const { result, socket } = await start(); socket.emit("data", data);
    const observation = await result;
    assert.deepEqual(observation, { ...good, orderlyEnd: false, receivedBytes: data.length, error: "unexpected_data" });
    assert.equal(JSON.stringify(observation).includes(lease.credential), false);
  }
});

test("probe timer caps an otherwise longer reconnect budget at 1500ms", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { result, socket } = await start(peer(new ComponentFakeSocket(), performance.now() + 5000));
  context.mock.timers.tick(1499); assert.equal(socket.destroyed, false);
  context.mock.timers.tick(1);
  assert.deepEqual(await result, { ...good, orderlyEnd: false, timedOut: true });
});

test("probe timer consumes only remaining original reconnect budget", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { result } = await start(peer(new ComponentFakeSocket(), performance.now() + 40));
  context.mock.timers.tick(40);
  assert.deepEqual(await result, { ...good, orderlyEnd: false, timedOut: true });
});

test("a delayed connect after the original deadline cannot send authentication", async context => {
  let now = 10;
  context.mock.method(performance, "now", () => now);
  const socket = new ComponentFakeSocket();
  const result = probes.probeExpiredCredential(lease, { reconnectDeadline: 20, connect: () => {
    queueMicrotask(() => { now = 21; socket.emit("connect"); }); return socket;
  } });
  assert.deepEqual(await result, { ...good, writeCompleted: false, orderlyEnd: false, timedOut: true });
  assert.equal(socket.wire, null);
});

test("orderly EOF arriving after the unchanged deadline cannot become a refusal", async context => {
  let now = 10;
  context.mock.method(performance, "now", () => now);
  const { result, socket } = await start(peer(new ComponentFakeSocket(), 20));
  now = 21; socket.emit("end");
  assert.deepEqual(await result, { ...good, timedOut: true });
});

test("a delayed EOF after the 1500ms cap refuses even while reconnect time remains", async context => {
  let now = 10;
  context.mock.method(performance, "now", () => now);
  const { result, socket } = await start(peer(new ComponentFakeSocket(), 5010));
  now = 1511; socket.emit("end");
  assert.deepEqual(await result, { ...good, timedOut: true });
});

test("the accepted pure validator matches the probe's actual reversed IPv6 and mapped tuple", async () => {
  const socket = new ComponentFakeSocket();
  socket.localAddress = "2001:0db8:0:0:0:0:0:1"; socket.remoteAddress = "::ffff:127.0.0.1";
  const { result } = await start(peer(socket)); socket.emit("end");
  const probe = await result;
  // All journal, native, process and provenance fields remain SYNTHETIC.
  // Literal journal endpoints are independent of the probe's normalized output.
  const schema = "runtime-media-admission-evidence/v1", instance = "0123456789abcdef0123456789abcdef";
  const predicates = { session_present: true, credential_matches: true, media_version_matches: true,
    bridge_binding_matches: true, credential_expired: false, reconnect_expired: false, active: false, capture_finished: false };
  const rows = [
    { schema, instance, sequence: 0, type: "header" },
    { schema, instance, sequence: 1, type: "admission", session_id: "7", reservation_epoch: "2", connection_id: "1", accepted: true,
      context: { attempt_id: 1, transport: { kind: "tcp", peer: "[2001:db8::1]:43209", local: "127.0.0.1:1234" } }, predicates },
    { schema, instance, sequence: 2, type: "fence_release", session_id: "7", reservation_epoch: "2", connection_id: "1" },
    { schema, instance, sequence: 3, type: "admission", session_id: "7", reservation_epoch: "2", connection_id: null, accepted: false,
      context: { attempt_id: 2, transport: { kind: "tcp", peer: "[2001:db8:0:0:0:0:0:1]:43210", local: "[::ffff:127.0.0.1]:1234" } },
      predicates: { ...predicates, credential_expired: true } },
    { schema, instance, sequence: 4, type: "completion", record_count: 5, loss: false, writer_error: false },
  ];
  const journal = Buffer.from(rows.map(row => JSON.stringify(row) + "\n").join("")), digest = "a".repeat(64);
  const identity = { dev: "1", ino: "2", uid: 501, mode: 384, nlink: 1, parentDev: "1", parentIno: "3", parentUid: 501, parentMode: 448 };
  const provenance = { profile: "runtime-media-evidence-test-20261005", artifactManifestSha256: digest, sourceManifestSha256: digest,
    patchSha256: digest, buildMetadataSha256: digest, erratumSha256: digest, reconciledAuditSha256: digest,
    base: "c".repeat(40), candidateTree: "b".repeat(40), gatewaySha256: digest, sdkSha256: digest };
  const input = { journal, sessionId: "7", expectedProvenance: provenance,
    receipt: { schema: "meeting-expiry-ownership/v1", provenance, gatewayPid: 123, spawnObserved: true, exitCode: 0, signal: null,
      pipesClosed: true, observerFailure: null, binaryBeforeSha256: digest, binaryAfterSha256: digest,
      journalOpenedIdentity: identity, journalFinalIdentity: identity, journalOpenedSize: 0, journalFinalSize: journal.length,
      journalSha256: createHash("sha256").update(journal).digest("hex"), instance,
      completion: { recordCount: 5, loss: false, writerError: false } }, journalIdentity: identity, probe,
    ordering: { releaseObserved: 1, probeStarted: 2, probeSettled: 3, firstTeardown: 4, releaseInstance: instance, releaseSequence: 2 },
    nativeLifecycle: { sessionId: "7", connected: 1, faultDisconnected: 1, terminalDisconnected: 1, reconnecting: 0, reconnected: 0 },
    nativeProof: { recordedSamples: "86400", recordedFrames: 180, emittedSamples: 86537, prefixComplete: false, pages: 3,
      drain: "unconfirmed", nativeCleanup: "confirmed", custody: "departure_confirmed", timingCoverage: "available",
      timingWarnings: [], scope: "component_only_failure_oracle" },
    cleanup: { sdkTransportClosed: true, runtimeClosed: true, providerClosed: true, nativeChildReaped: true, nativeChildFailure: null } };
  assert.equal(validateExpiryEvidence(input).ok, true);
  assert.equal(validateExpiryEvidence({ ...input, probe: { ...probe, local: "[2001:db8::1]:43211" } }).ok, false);
});

test("Boolean compatibility wrapper retains true or static refusal behavior", async () => {
  const transport = peer(); const result = probes.expiredCredentialRefused(lease, transport);
  await Promise.resolve(); transport.socket.emit("end");
  assert.equal(await result, true);
  for (const event of ["data", "error", "close", "end"] as const) {
    const socket = new ComponentFakeSocket(); socket.deferWrite = event === "end";
    const attempt = probes.expiredCredentialRefused(lease, peer(socket));
    await Promise.resolve(); socket.emit(event, event === "data" ? Buffer.from("ACK") : new Error(lease.credential));
    await assert.rejects(attempt, error => error instanceof Error && error.message === "expired_credential_refusal_unproven");
  }
});

test("pre-expiry timestamp and elapsed reconnect deadline cannot create a probe", async () => {
  for (const helper of [probes.expiredCredentialRefused, probes.probeExpiredCredential]) {
    let calls = 0;
    const connect = () => { calls += 1; return new ComponentFakeSocket(); };
    await assert.rejects(helper({ ...lease, expiresAtMs: BigInt(Date.now() + 60_000) },
      { connect, reconnectDeadline: performance.now() + 1000 }), /has not expired/);
    await assert.rejects(helper(lease, { connect, reconnectDeadline: 0 }), /would mask credential expiry/);
    assert.equal(calls, 0);
  }
});
