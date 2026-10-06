// Scripted raw observations only; production reconciliation owns identity.
import { setTimeout, clearTimeout } from "node:timers";
import process from "node:process";
import { Buffer } from "node:buffer";

const INVALID = "invalid_bridge_observation_plan", STATE = "bridge_observation_state", FAILED = "bridge_observation_failed";
const U64 = 18446744073709551615n, HORIZON = 60000000000n;
const fail = () => { throw new Error(INVALID); };
function exact(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail();
}
function uint(value) {
  if (typeof value !== "string" || value.length > 20 || !/^(0|[1-9][0-9]*)$/.test(value)) fail();
  const number = BigInt(value); if (number > U64) fail(); return number;
}
function copyJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || ancestors.has(value)) return fail();
  if (Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype)) fail();
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string" ||
    (!Array.isArray(value) || key !== "length") && !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
    !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))) fail();
  let copied;
  if (Array.isArray(value)) {
    if (keys.length !== value.length + 1 || keys.some(key => key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))) fail();
    copied = value.map(item => copyJson(item, ancestors));
  } else copied = Object.fromEntries(keys.map(key => [key, copyJson(value[key], ancestors)]));
  ancestors.delete(value); return Object.freeze(copied);
}
function copiedBinding(value) {
  const keys = ["physicalClientId", "physicalGenerationId", "occurrenceId", "bridgeSessionId"];
  exact(value, keys);
  if (keys.some(key => typeof value[key] !== "string" || value[key].length === 0)) fail();
  return Object.freeze(Object.fromEntries(keys.map(key => [key, value[key]])));
}

// Preserve the original serializer, property order and observedAt override.
export function createBridgeEventEmitter({ sessionId, write, now = () => new Date().toISOString() }) {
  let sequence = 0;
  return payload => {
    sequence += 1;
    write(`${JSON.stringify({ schema: "bridge-session/v2", sessionId, sequence, observedAt: now(), ...payload })}\n`);
  };
}

export function createBridgeObservationOwner({ plan, binding, participants, parseEvent, emit,
  nowHostNs = () => process.hrtime.bigint(), timers = { setTimeout, clearTimeout }, onState = () => {} }) {
  const expected = copiedBinding(binding), enabled = plan !== undefined;
  let copied, startup;
  try {
    if (enabled && typeof parseEvent !== "function") fail();
    startup = nowHostNs(); if (typeof startup !== "bigint" || startup < 0n || startup > U64) fail();
    if (enabled && participants !== undefined && (!Array.isArray(participants) || participants.length !== 0)) fail();
    copied = copyJson(enabled ? plan : { schema: "e2e-bridge-observations/v1", disclosure: "failed", events: [] });
    exact(copied, ["schema", "disclosure", "events"]);
    if (copied.schema !== "e2e-bridge-observations/v1" || !["sent", "unavailable", "failed"].includes(copied.disclosure) ||
      !Array.isArray(copied.events) || copied.events.length > 64 || Buffer.byteLength(JSON.stringify(copied)) > 48 * 1024) fail();
    let lastDue = startup, lastBefore = null, lastAfter = null, wall = -Infinity, snapshot = 0;
    const people = new Set();
    for (const row of copied.events) {
      exact(row, ["emitAtHostNs", "event"]);
      const due = uint(row.emitAtHostNs), payload = row.event;
      if (due <= lastDue || due > startup + HORIZON || payload === null || typeof payload !== "object" ||
        !["participant_joined", "participant_left", "ui_snapshot"].includes(payload.type) ||
        ["schema", "sessionId", "sequence", "binding", "custody"].some(key => Object.hasOwn(payload, key))) fail();
      // Shared ordinary/results can widen the real sequence after admission.
      // Reserve its maximum supported width through the production codec.
      parseEvent({ schema: "bridge-session/v2", sessionId: expected.bridgeSessionId, sequence: Number.MAX_SAFE_INTEGER, ...payload });
      const parsedWall = Date.parse(payload.observedAt);
      if (!Number.isFinite(parsedWall) || parsedWall < wall || new Date(parsedWall).toISOString().slice(0, 19) !== payload.observedAt.slice(0, 19)) fail();
      wall = parsedWall; lastDue = due;
      const timing = payload.observationTiming;
      if (timing === null) {
        if (payload.type !== "ui_snapshot" || payload.state !== "unreadable" || payload.reason !== "timing_unavailable") fail();
      } else {
        const before = uint(timing.hostBeforeNs), after = uint(timing.hostAfterNs);
        if (timing.clockDomainId !== "e2e-clock" || after !== due || lastBefore !== null && (before < lastBefore || after < lastAfter)) fail();
        lastBefore = before; lastAfter = after;
      }
      if (payload.type === "ui_snapshot") {
        const next = payload.snapshotSequence;
        if (snapshot === 0 ? next !== 1 : next <= snapshot || next !== snapshot + 1 && payload.barrierBefore !== "observation_drop") fail();
        snapshot = next;
      } else people.add(payload.feishuUserId);
      if (people.size > 16) fail();
    }
  } catch { fail(); }
  const horizon = startup + HORIZON;
  let phase = "prepared", preparedJoin = false, started = false, cursor = 0, lastClock = startup;
  let pending = null, ticket = 0, completion = null, resolveCompletion, rejectCompletion;
  let disclosing = false;
  const summary = () => ({ mode: enabled ? "scripted" : "baseline", phase, planned: copied.events.length, emitted: cursor,
    ...(phase === "failed" ? { cause: FAILED } : {}) });
  const status = () => ({ phase, planned: copied.events.length, emitted: cursor });
  const cancel = () => {
    ticket++;
    const handle = pending; pending = null;
    if (handle !== null) timers.clearTimeout(handle);
  };
  const notify = () => onState(Object.freeze(summary()));
  const failed = () => {
    if (phase === "disposed" || phase === "failed") return;
    phase = "failed";
    try { cancel(); } catch { /* Local ownership is released even if the timer dependency fails. */ }
    rejectCompletion?.(new Error(FAILED));
    try { notify(); } catch { /* Static terminal failure remains authoritative. */ }
  };
  const clock = () => {
    const value = nowHostNs();
    if (typeof value !== "bigint" || value < lastClock || value > U64) throw new Error(STATE);
    lastClock = value; return value;
  };
  const finish = () => {
    phase = "completed"; cancel(); notify();
    if (phase === "completed") resolveCompletion(status());
  };
  const schedule = () => {
    if (phase !== "running") return;
    const now = clock(); if (now > horizon) throw new Error(STATE);
    if (cursor === copied.events.length) { finish(); return; }
    const remaining = BigInt(copied.events[cursor].emitAtHostNs) - now;
    const delay = remaining <= 0n ? 0 : Number((remaining + 999999n) / 1000000n);
    const scheduled = ++ticket;
    pending = timers.setTimeout(() => {
      if (phase !== "running" || scheduled !== ticket) return;
      try {
        cancel();
        const actual = clock(); if (actual > horizon) throw new Error(STATE);
        const row = copied.events[cursor];
        if (actual < BigInt(row.emitAtHostNs)) { schedule(); return; }
        cursor++; // Own this row before any externally supplied callback.
        emit(row.event);
        if (phase !== "running") return;
        notify(); schedule();
      } catch { failed(); }
    }, delay);
  };
  const owner = {
    prepareJoin(joinTiming) {
      if (phase !== "prepared" || preparedJoin) throw new Error(STATE);
      preparedJoin = true;
      try {
        const now = clock(), before = uint(joinTiming.hostBeforeNs), after = uint(joinTiming.hostAfterNs);
        if (joinTiming.clockDomainId !== "e2e-clock" || before > after || after > now || now > horizon ||
          copied.events.some(row => BigInt(row.emitAtHostNs) <= now || row.event.observationTiming !== null && BigInt(row.event.observationTiming.hostBeforeNs) < after)) throw new Error(STATE);
      } catch { phase = "failed"; throw new Error(STATE); }
    },
    start() {
      if (phase !== "prepared" || !preparedJoin || started) throw new Error(STATE);
      started = true;
      completion = new Promise((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
      phase = "running";
      try { notify(); schedule(); } catch { failed(); }
      return completion;
    },
    postDisclosure(commandId) {
      if (!preparedJoin || phase === "disposed" || phase === "failed" || disclosing || typeof commandId !== "string" || commandId.length === 0 || Buffer.byteLength(commandId) > 1024) throw new Error(STATE);
      disclosing = true;
      try {
        emit({ type: "chat_disclosure", outcome: copied.disclosure });
        if (phase === "disposed" || phase === "failed") throw new Error(STATE);
        emit({ type: "command_result", commandId, outcome: copied.disclosure === "sent" ? "ok" : "failed",
          detail: copied.disclosure === "sent" ? null : copied.disclosure === "unavailable" ? "synthetic disclosure unavailable" : "synthetic disclosure failure" });
        return copied.disclosure;
      } catch { failed(); throw new Error(FAILED); }
      finally { disclosing = false; }
    },
    dispose() {
      if (phase === "disposed" || phase === "failed") return;
      phase = "disposed";
      try { cancel(); } catch { pending = null; }
      resolveCompletion?.(status());
      try { notify(); } catch { /* Diagnostics cannot prevent capture/outcome cleanup. */ }
    },
  };
  return Object.freeze(owner);
}
