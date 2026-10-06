import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { Duplex } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
// @ts-expect-error Test-only lifecycle leaf has no public declaration.
import * as lifecycle from "./fixtures/scripted-capture-lifecycle.mjs";
// @ts-expect-error Test-only connected media core has no public declaration.
import { createConnectedMediaClient } from "./media-client.mjs";

class Peer extends Duplex {
  finish: Buffer | null = null;
  _read() {}
  _write(bytes: Buffer, _encoding: string, done: () => void) { if (bytes[5] === 10) this.finish = Buffer.from(bytes); done(); }
  acknowledge() { const ack = Buffer.from(this.finish!); ack[5] = 11; this.push(ack); }
}
async function fixture(mediaTiming?: string) {
  const socket = new Peer(), bridge = Buffer.from("synthetic-bridge");
  const media = createConnectedMediaClient({ socket, credential: "synthetic", bridgeSessionId: bridge.toString(), sessionId: 41n, authTimeoutMs: 100, mediaTiming });
  const auth = Buffer.alloc(19 + bridge.length); auth.write("MED3"); auth[4] = 3; auth[5] = 9;
  auth.writeUInt32BE(9 + bridge.length, 6); auth.writeBigUInt64BE(41n, 10); auth[18] = bridge.length; bridge.copy(auth, 19);
  socket.push(auth); await media.ready; await media.sendEpoch(); await media.sendClockPair();
  for (let i = 0; i < (mediaTiming === "omit-final-pair" ? 49 : 1); i++) await media.sendSilentFrame();
  const events: Array<Record<string, unknown>> = [], outcomes: unknown[] = []; let fences = 0;
  assert.equal(typeof lifecycle.createCaptureLifecycle, "function", "same child stop owner must publish typed drain before saved end");
  const owner = lifecycle.createCaptureLifecycle({ getMedia: () => media, fenceCapture: () => { fences++; },
    getCaptureWork: () => Promise.resolve(), emit: (event: Record<string, unknown>) => events.push(event),
    participants: [{ feishuUserId: "synthetic-user" }], onOutcome: (outcome: unknown) => outcomes.push(outcome), timeoutMs: 100 });
  return { socket, media, owner, events, outcomes, fences: () => fences };
}
const observation = { reason: "ended", observedAt: "2026-10-05T10:00:00.123Z",
  observationTiming: { clockDomainId: "e2e-clock", hostBeforeNs: "100", hostAfterNs: "200" }, observationTimingReason: null };

test("saved end observation survives held synthetic ACK; typed drain precedes departures and left exactly once", async () => {
  const f = await fixture(); const stop = f.owner.observeEnd(observation);
  assert.equal(f.owner.stop(), stop); await setImmediate(); assert.equal(f.events.length, 0); assert.equal(f.fences(), 1);
  f.socket.acknowledge(); await stop;
  assert.deepEqual(f.events.map(row => row.type), ["media_disconnected", "participant_left", "left"]);
  assert.deepEqual(f.events.at(-1), { type: "left", ...observation });
  assert.equal((f.events[0]!.captureDrain as { drain: string }).drain, "confirmed");
  assert.equal(f.outcomes.length, 1); assert.equal(f.owner.observeEnd(observation), stop);
});

test("EOF alone performs bounded finish without fabricating left or participant departure", async () => {
  const f = await fixture(); const stop = f.owner.stop(); await setImmediate(); f.socket.acknowledge(); await stop;
  assert.deepEqual(f.events.map(row => row.type), ["media_disconnected"]); assert.equal(f.owner.observation, null);
});

test("removed and bridge_failure retain the original reason and time even with recorder confirmation", async () => {
  for (const reason of ["removed", "bridge_failure"]) {
    const f = await fixture(); const stop = f.owner.observeEnd({ ...observation, reason }); await setImmediate();
    f.socket.acknowledge(); await stop;
    assert.equal(f.events.at(-1)!.reason, reason); assert.equal(f.events.at(-1)!.observedAt, observation.observedAt);
  }
});

test("concurrent EOF and end use one owned stop; no ACK yields typed unconfirmed before preserved left", async () => {
  const f = await fixture(); const stop = f.owner.stop(); assert.equal(f.owner.observeEnd(observation), stop);
  await stop; assert.equal(f.fences(), 1);
  assert.deepEqual(f.events.map(row => row.type), ["media_disconnected", "participant_left", "left"]);
  assert.deepEqual(f.events[0]!.captureDrain, { drain: "unconfirmed", reason: "capture_finish_timeout", boundary: null });
  assert.equal(f.events.at(-1)!.observedAt, observation.observedAt);
});

test("end/EOF abort and settle owned pending authentication before terminal publication", async () => {
  for (const end of [true, false]) {
    const abort = new AbortController(), socket = new Peer();
    const media = createConnectedMediaClient({ socket, credential: "synthetic", bridgeSessionId: "synthetic-bridge", sessionId: 41n,
      authTimeoutMs: 100, signal: abort.signal });
    let settled = false, lateConnected = false;
    const setup = media.ready.then(() => { lateConnected = true; }, () => { settled = true; });
    const events: Array<Record<string, unknown>> = [];
    const owner = lifecycle.createCaptureLifecycle({ getMedia: () => null, getCaptureWork: () => Promise.resolve(),
      getConnectionWork: () => setup, abortConnection: () => abort.abort(), fenceCapture: () => {},
      emit: (value: Record<string, unknown>) => { assert.equal(settled, true); events.push(value); } });
    await (end ? owner.observeEnd(observation) : owner.stop());
    assert.equal(socket.destroyed, true); assert.equal(lateConnected, false);
    assert.equal((events[0]!.captureDrain as { drain: string }).drain, "unconfirmed");
    assert.deepEqual(events.map(row => row.type), end ? ["media_disconnected", "left"] : ["media_disconnected"]);
  }
});

// Composes the child's real lifecycle and connected byte core, without ACK injection.
test("selected omission publishes unconfirmed once before preserved left and EOF alone never invents left", async () => {
  for (const end of [true, false]) {
    const f = await fixture("omit-final-pair"), stop = f.owner.stop();
    if (end) assert.equal(f.owner.observeEnd(observation), stop);
    assert.equal(f.owner.stop(), stop); await stop;
    assert.equal(f.fences(), 1); assert.equal(f.outcomes.length, 1); assert.equal(f.socket.finish, null);
    assert.deepEqual(f.events.map(row => row.type), end ? ["media_disconnected", "participant_left", "left"] : ["media_disconnected"]);
    assert.deepEqual(f.events[0]!.captureDrain, { drain: "unconfirmed", reason: "final_clock_pair_omitted", boundary: null });
    if (end) assert.deepEqual(f.events.at(-1), { type: "left", ...observation });
    else assert.equal(f.owner.observation, null);
  }
});
