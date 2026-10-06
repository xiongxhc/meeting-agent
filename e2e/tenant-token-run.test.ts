import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { Agent as HttpAgent, IncomingMessage, ServerResponse } from "node:http";
import type { ClientRequestArgs } from "node:http";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { createFeishuSdkHttp as HttpFactory } from "../src/adapters/feishu-sdk-http.ts";
import type { createFeishuSocketOwner as SocketFactory } from "../src/adapters/feishu-sdk-connection.ts";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { normalizeInvite } from "../src/ports/feishu-ingress.ts";
import { createInviteDiscovery } from "../src/sessions/invite-discovery.ts";

const loaded: unknown = await import(new URL("./tenant-token-run.mjs", import.meta.url).href).catch(() => ({}));
const entry: unknown = await import(new URL("./tenant-token-entry.mjs", import.meta.url).href).catch(() => ({}));
const ingress: unknown = await import(new URL("./ingress-run.mjs", import.meta.url).href);
function fn<T>(name: string): T { assert.ok(loaded && typeof loaded === "object"); const value: unknown = Reflect.get(loaded, name); assert.equal(typeof value, "function", name); return value as T; }
function entryFn<T>(name: string): T { assert.ok(entry && typeof entry === "object"); const value: unknown = Reflect.get(entry, name); assert.equal(typeof value, "function", name); return value as T; }
const shutdown = ["shutdown_fenced", "maintenance_fenced", "maintenance_closed", "shutdown_owned_work_settled", "shutdown_application_closed", "shutdown_runtime_owners_closed", "shutdown_transports_closed", "shutdown_store_closed"];
function snapshot() {
  return { marks: { admitted: 1, handle: 2, started: 5, initialDiscovery: 6, commit: 7, ack: 9, tokenStart: 8, tokenSettlement: 0, closeRequested: 0, closeSettled: 0, lifecycleSettled: 0, fixtureStarted: 0, peerClosed: 0, admittedReturned: 0, ownerCloseBegin: 0, ownerCloseEnd: 0 },
    times: { commitAt: 10 as number | null, tokenStartAt: 11 as number | null }, emptyState: false,
    operations: [{ kind: "ws_endpoint", method: "POST", startOrdinal: 3, settleOrdinal: 4, outcome: "fulfilled", timeoutMs: 5000 }, { kind: "tenant_token_internal", method: "POST", startOrdinal: 8, settleOrdinal: 0, outcome: "pending", timeoutMs: 5000 }],
    requests: [{ method: "POST", route: "ws_endpoint", status: 200 }], hold: { id: "held-token", method: "POST", route: "tenant_access_token" } as { id: string; method: string; route: string } | null,
    owners: { admitted: 1, handles: 1, http: 1, httpSockets: 1, httpPending: 0, wsSockets: 1, wsPending: 0, connections: 1 },
    receiver: { ackCount: 1, legacyAckCount: 1, messageCount: 0, matchingAck: true, invalid: false, overflow: false },
    lifecycle: [{ ordinal: 5, code: "composition_started" }, { ordinal: 6, code: "discovery_tick" }, { ordinal: 7, code: "invite_committed" }],
    durable: { occurrences: 1, events: 1, sessions: 0, custody: 0, generations: 0, counts: { custody: 0, recording: 0, seed: 0, delivery: 0, notification: 0 }, state: "pending_metadata", reason: null as string | null, acceptedAtMs: 1000, claimed: 1, claimExpiresAtMs: 32000 as number | null,
      totalAttempts: 1, generationAttempts: 1, generationStartedAtMs: 2000, firstAttemptAtMs: 2000, lastAttemptAtMs: 2000, retryGeneration: 0, operatorRetryCount: 0, lastBlockedAtMs: null as number | null, lastObservedAtMs: 1000, nextAttemptAtMs: 1000,
      metadataNull: true, operatorNull: true, auditEqual: true, identityEqual: true },
    files: { recordings: 0, outbox: 0, receipts: 0, runtimePids: false, launcherLog: false, key: false, bridgeState: false }, liveCount: 0, outcomeCount: 0, fixtureCleanupStarted: false, invalid: false, overflow: false };
}
type Snapshot = ReturnType<typeof snapshot>;
type Result = { success: boolean; failures: string[]; provenance: string; cleanupConfirmed: boolean; held: Snapshot | null; settlement: Settlement | null; final: Final | null; qualification: unknown; schema: string; family: string; elapsedMs: number; polls: number };
type Settlement = { snapshot: Snapshot; repeated: Snapshot; close: { firstFulfilled: boolean; secondFulfilled: boolean; promiseSame: boolean; thirdFulfilled: boolean; thirdPromiseSame: boolean }; composition: { status: string; clean: boolean } };
type Final = { snapshot: Snapshot; composition: { status: string; clean: boolean }; standaloneExit: number; cleanupFailures: string[] };
type Effects = ReturnType<typeof component>["effects"];
type Options = { now?: () => number; sleep?: (ms: number) => Promise<void>; pollAllowance?: { remaining: number }; overallMs?: number; admissionMs?: number; cleanupMs?: number; startedAt?: number };
function qualification() { const roles = fn<() => string[]>("tenantTokenSourceRoles")(); return { schema: "meeting-tenant-token-sources/v1", baselineSha256: "ae4316ed2bc7a5c652ea44f32c16b3fdc260a5bb93f933bf45e63b49a5c0ad01", sources: roles.map(role => ({ role, sha256: "a".repeat(64) })) }; }
function run(effects: Effects, options: Options = {}) { return fn<(e: Effects, q: unknown, o: Options) => Promise<Result>>("runTenantTokenPhase")(effects, qualification(), options); }
function component() {
  let current = snapshot(), closePromise: Promise<void> | undefined;
  const calls = { close: 0, selected: 0, finish: 0, cancel: 0, begin: 0, send: 0 };
  const app = { close() { calls.close++; return closePromise ??= Promise.resolve().then(() => {
    current.marks.tokenSettlement = 11; current.operations[1]!.outcome = "rejected"; current.operations[1]!.settleOrdinal = 11;
    current.requests.push({ method: "POST", route: "tenant_access_token", status: 499 }); current.hold = null;
    Object.assign(current.owners, { http: 0, httpSockets: 0, wsSockets: 0, connections: 0 });
    Object.assign(current.durable, { reason: "timeout", claimed: 0, claimExpiresAtMs: null, lastBlockedAtMs: 6000, nextAttemptAtMs: 7000 });
    shutdown.forEach((code, i) => current.lifecycle.push({ ordinal: 12 + i, code })); current.marks.closeSettled = 20; current.marks.lifecycleSettled = 21;
  }); } };
  const effects = {
    async begin() { calls.begin++; const ready = structuredClone(current); ready.emptyState = true; Reflect.set(ready, "durable", null); ready.hold = null; ready.operations.length = 1; Object.assign(ready.owners, { http: 0, httpSockets: 0 }); Object.assign(ready.receiver, { ackCount: 0, legacyAckCount: 0, matchingAck: false }); Object.assign(ready.marks, { commit: 0, ack: 0, tokenStart: 0 }); ready.lifecycle.length = 2; ready.times.commitAt = null; ready.times.tokenStartAt = null; return ready; }, async send() { calls.send++; }, read() { return structuredClone(current); },
    closeHeld(expected: Snapshot) { const result = fn<(expected: unknown, read: () => Snapshot, app: { close(): Promise<void> }, mark: () => void) => { first: Promise<void>; second: Promise<void> }>("closeHeldTenantToken")(expected, effects.read, app, () => { current.marks.closeRequested = 10; }); calls.selected++; return result; },
    async settle(close: { first: Promise<void>; second: Promise<void> }, phase?: { poll: (deadline: number) => Promise<void> }, deadline?: number): Promise<Settlement> {
      void phase; void deadline;
      const [a, b] = await Promise.allSettled([close.first, close.second]), before = effects.read(), third = app.close(); const c = await Promise.allSettled([third]);
      return { snapshot: before, repeated: effects.read(), close: { firstFulfilled: a.status === "fulfilled", secondFulfilled: b.status === "fulfilled", promiseSame: close.first === close.second, thirdFulfilled: c[0]!.status === "fulfilled", thirdPromiseSame: third === close.first }, composition: { status: "composition_closed", clean: true } };
    },
    async finish(): Promise<Final> { calls.finish++; current.fixtureCleanupStarted = true; Object.assign(current.marks, { fixtureStarted: 22, peerClosed: 23, admittedReturned: 24, ownerCloseBegin: 25, ownerCloseEnd: 26 }); return { snapshot: effects.read(), composition: { status: "composition_closed", clean: true }, standaloneExit: 0, cleanupFailures: [] }; },
    cancel() { calls.cancel++; app.close().catch(() => {}); },
  };
  return { effects, calls, current: () => current, change(value: Snapshot) { current = value; } };
}
test("shared component controller retains a complete held claim through natural timeout and owner-last cleanup", async () => {
  const c = component(), result = await run(c.effects, { now: () => 12 }); assert.equal(result.success, true); assert.equal(result.provenance, "component"); assert.equal(result.cleanupConfirmed, true); assert.deepEqual(result.failures, []); assert.equal(c.calls.selected, 1); assert.equal(c.calls.close, 3); assert.equal(c.calls.cancel, 0); assert.equal(c.calls.finish, 1);
});
test("same-stack recheck rejects an already settled token before invoking public close", () => {
  const expected = snapshot(), actual = snapshot(); actual.operations[1]!.outcome = "rejected"; let calls = 0;
  const close = fn<(e: unknown, r: () => unknown, a: unknown, m: () => void) => unknown>("closeHeldTenantToken"); assert.throws(() => close(expected, () => actual, { close() { calls++; } }, () => {})); assert.equal(calls, 0);
});
test("same-stack recheck rejects a different otherwise-valid held identity before close", () => { const close = fn<(v: unknown, read: () => unknown, app: unknown, mark: () => void) => unknown>("closeHeldTenantToken"), actual = snapshot(); actual.hold!.id = "other-valid-hold"; let calls = 0; assert.throws(() => close(snapshot(), () => actual, { close() { calls++; return Promise.resolve(); } }, () => {}), /history_changed/); assert.equal(calls, 0); });
test("two actual public close calls must return the same memoized promise", () => { const close = fn<(v: unknown, read: () => unknown, app: unknown, mark: () => void) => unknown>("closeHeldTenantToken"); let calls = 0; assert.throws(() => close(snapshot(), snapshot, { close() { calls++; return Promise.resolve(); } }, () => {}), /close_identity/); assert.equal(calls, 2); });
test("real discovery and store persist first retryable timeout without admission or second attempt", async () => {
  const root = mkdtempSync("/private/tmp/tenant-discovery-"), store = openSessionStore({ filename: path.join(root, "db") }); let now = 1000, finish!: () => void, signal: AbortSignal | undefined;
  const scope = { region: "feishu" as const, tenantKey: "tenant", appId: "cli_0123456789abcdef" }, invite = normalizeInvite({ schema: "2.0", header: { event_id: "event", event_type: "vc.bot.meeting_invited_v1", app_id: scope.appId, tenant_key: scope.tenantKey, create_time: "1788357600000" }, event: { meeting: { id: "PRIVATE_COMPONENT_MEETING_ID", meeting_no: "900000001", topic: "component", start_time: "1788357600" }, invite_time: "1788357601", call_id: "call" } }, scope);
  chmodSync(root, 0o700); chmodSync(path.join(root, "db"), 0o600); store.acceptInvite(invite, now);
  assert.ok(ingress && typeof ingress === "object"); const reader: unknown = Reflect.get(ingress, "readIngressState"); assert.equal(typeof reader, "function");
  const read = () => (reader as (v: { databasePath: string; occurrenceId: string }) => unknown)({ databasePath: path.join(root, "db"), occurrenceId: invite.occurrenceId });
  const original = read(), project = entryFn<(v: unknown, original: unknown) => Snapshot["durable"]>("projectTenantTokenDurable"); now = 2000;
  const discovery = createInviteDiscovery({ store, now: () => now, jitter: () => 0, metadata: { resolve(_claim, ownSignal) { signal = ownSignal; return new Promise(resolve => { finish = () => resolve({ status: "blocked", reason: "timeout", retryable: true }); }); } } });
  try { const pending = discovery.runOnce(); await Promise.resolve(); const held = store.getInviteOccurrence(invite.occurrenceId)!; assert.ok(held.claimToken); assert.equal(held.totalAttempts, 1);
    const full = snapshot(); full.durable = project(read(), original); fn<(v: unknown) => unknown>("assertTenantTokenHeld")(full); assert.equal(full.durable.lastObservedAtMs, 1000); assert.equal(full.durable.lastAttemptAtMs, 2000);
    now = 6000; finish(); assert.equal(await pending, true);
    const after = store.getInviteOccurrence(invite.occurrenceId)!; assert.equal(signal?.aborted, false); assert.equal(after.claimToken, null); assert.equal(after.claimExpiresAtMs, null); assert.equal(after.state, "pending_metadata"); assert.equal(after.lastBlockedReason, "timeout"); assert.equal(after.totalAttempts, 1); assert.equal(after.generationAttempts, 1); assert.equal(after.nextAttemptAtMs, after.lastBlockedAtMs! + 1000); assert.equal(store.getSession(invite.occurrenceId), null); assert.equal(await discovery.close(), true);
    const c = component(), settle = c.effects.settle; c.change(full); c.effects.settle = async close => { const v = await settle(close); v.snapshot.durable = project(read(), original); v.repeated.durable = project(read(), original); return v; };
    const result = await run(c.effects, { now: () => 12 }); assert.equal(result.success, true); assert.equal(result.settlement!.snapshot.durable.lastObservedAtMs, 1000); assert.equal(JSON.stringify(result).includes(invite.providerMeetingId), false); assert.equal(JSON.stringify(result).includes("claimToken"), false);
  } finally { await discovery.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
test("output rejects nonprimitive failure before invoking privacy-sensitive methods", () => {
  const out = mkdtempSync("/private/tmp/tenant-writer-"); chmodSync(out, 0o700); let calls = 0;
  const write = fn<(out: string, value: unknown) => void>("writeTenantTokenEvidence");
  try { assert.throws(() => write(out, { failures: [{ toJSON() { calls++; return "SECRET"; }, startsWith() { calls++; return true; } }] })); assert.equal(calls, 0); assert.deepEqual(readdirSync(out), []); } finally { rmSync(out, { recursive: true, force: true }); }
});

const heldChanges: [string, (v: Snapshot) => void][] = [
  ["app-token alias classification", v => { v.operations[1]!.kind = "invalid"; v.invalid = true; }], ["endpoint499", v => { v.requests[0]!.status = 499; }], ["token settled", v => { v.operations[1]!.outcome = "rejected"; v.operations[1]!.settleOrdinal = 9; v.marks.tokenSettlement = 9; }],
  ["wrong method", v => { v.operations[1]!.method = "GET"; v.hold!.method = "GET"; }], ["incomplete body", v => { v.hold = null; }], ["missing reference and token", v => { v.operations.length = 1; v.marks.tokenStart = 0; v.times.tokenStartAt = null; v.hold = null; v.durable.reason = "reference_missing"; }],
  ["ACK before commit", v => { v.marks.ack = 5; }], ["missing ACK", v => { v.receiver.ackCount = 0; v.receiver.matchingAck = false; v.marks.ack = 0; }], ["missing commit", v => { v.marks.commit = 0; }], ["claim absent", v => { v.durable.claimed = 0; v.durable.claimExpiresAtMs = null; }],
  ["second attempt", v => { v.durable.totalAttempts = 2; v.durable.generationAttempts = 2; }], ["extra operation", v => { v.operations.push({ ...v.operations[1]! }); }], ["protected metadata trace", v => { v.requests.push({ method: "POST", route: "reserve_get", status: 200 }); }], ["fixture cleanup", v => { v.fixtureCleanupStarted = true; v.marks.fixtureStarted = 9; }],
  ["destroy without socket close", v => { v.owners.httpSockets = 2; }], ["pending socket owner", v => { v.owners.httpPending = 1; }], ["unconfirmed WS", v => { v.owners.wsPending = 1; }], ["receiver overflow", v => { v.receiver.overflow = true; }], ["history overflow", v => { v.overflow = true; }],
  ["unsolicited message", v => { v.receiver.messageCount = 1; }], ["extra ACK", v => { v.receiver.ackCount = 2; }], ["audit changed", v => { v.durable.auditEqual = false; }], ["DB identity changed", v => { v.durable.identityEqual = false; }], ["metadata admitted", v => { v.durable.metadataNull = false; }],
  ["session admitted", v => { v.durable.sessions = 1; }], ["publication", v => { v.durable.counts.delivery = 1; }], ["key created", v => { v.files.key = true; }], ["launch", v => { v.lifecycle.push({ ordinal: 9, code: "occurrence_launched" }); v.liveCount = 1; }], ["HTTP shorter timeout", v => { v.operations[1]!.timeoutMs = 1000; }],
];
for (const [name, change] of heldChanges) test(`coherent component held ${name} cannot be promoted by normal cleanup`, async () => {
  const c = component(), read = c.effects.read; c.effects.read = () => { const v = read(); if (v.marks.closeRequested === 0) change(v); return v; };
  const result = await run(c.effects, { now: () => 12, sleep: async () => {} }); assert.equal(result.success, false); assert.equal(result.cleanupConfirmed, false); assert.equal(c.calls.selected, 0); assert.equal(c.calls.cancel, 1); assert.equal(c.calls.finish, 1);
});
const drainChanges: [string, (v: Snapshot) => void][] = [
  ["coherent endpoint499", v => { v.requests[0]!.status = 499; }], ["fixture-produced499", v => { v.fixtureCleanupStarted = true; v.marks.fixtureStarted = 9; }], ["hold not removed", v => { v.hold = { id: "held-token", method: "POST", route: "tenant_access_token" }; }], ["socket still active", v => { v.owners.httpSockets = 1; }], ["pending creation", v => { v.owners.wsPending = 1; }],
  ["cancelled retry", v => { v.durable.reason = "cancelled"; }], ["wrong jitter", v => { v.durable.nextAttemptAtMs = v.durable.lastBlockedAtMs! + 2000; }], ["claim still held", v => { v.durable.claimed = 1; v.durable.claimExpiresAtMs = 31000; }], ["retry happened", v => { v.durable.totalAttempts = 2; v.durable.generationAttempts = 2; }], ["extra response", v => { v.requests.push({ method: "POST", route: "reserve_get", status: 200 }); }],
  ["nonrejected transport", v => { v.operations[1]!.outcome = "fulfilled"; }], ["historical close with current invalid", v => { v.invalid = true; }], ["retry clock lost", v => { v.durable.nextAttemptAtMs = 0; }], ["store not closed", v => { v.lifecycle.pop(); }], ["ordered shutdown reversed", v => { v.lifecycle[3]!.code = "shutdown_store_closed"; }],
];
for (const [name, change] of drainChanges) test(`coherent component drain ${name} rejects before fixture gate`, async () => {
  const c = component(), read = c.effects.read; c.effects.read = () => { const v = read(); if (v.marks.closeSettled) change(v); return v; };
  const result = await run(c.effects, { now: () => 12 }); assert.equal(result.success, false); assert.equal(result.cleanupConfirmed, false); assert.equal(c.calls.selected, 1); assert.equal(c.calls.finish, 1);
});
for (const key of ["firstFulfilled", "secondFulfilled", "promiseSame", "thirdFulfilled", "thirdPromiseSame"] as const) test(`component ${key} is required despite matching settled facts`, async () => {
  const c = component(), settle = c.effects.settle; c.effects.settle = async close => { const result = await settle(close); result.close[key] = false; return result; }; assert.equal((await run(c.effects, { now: () => 12 })).success, false);
});
test("third-close current mutation defeats historical fulfilled promises", async () => { const c = component(), settle = c.effects.settle; c.effects.settle = async close => { const result = await settle(close); result.repeated.durable.auditEqual = false; return result; }; assert.equal((await run(c.effects, { now: () => 12 })).success, false); });
for (const [name, change] of [
  ["peer after admitted return", (v: Final) => { v.snapshot.marks.peerClosed = 24; }], ["owner before admitted return", (v: Final) => { v.snapshot.marks.ownerCloseBegin = 22; }], ["owner end missing", (v: Final) => { v.snapshot.marks.ownerCloseEnd = 0; }], ["standalone70", (v: Final) => { v.standaloneExit = 70; }], ["cleanfalse", (v: Final) => { v.composition.clean = false; }], ["late audit", (v: Final) => { v.snapshot.durable.auditEqual = false; }], ["late message", (v: Final) => { v.snapshot.receiver.messageCount = 1; }],
] as const) test(`component final ${name} defeats cleanup qualification`, async () => {
  const c = component(), finish = c.effects.finish; c.effects.finish = async () => { const result = await finish(); change(result); return result; }; const result = await run(c.effects, { now: () => 12 }); assert.equal(result.success, false); assert.equal(result.cleanupConfirmed, false);
});

type RequestObserver = { request: (options: unknown) => Promise<unknown>; snapshot: () => { operations: { kind: string; method: string; outcome: string }[]; invalid: boolean; overflow: boolean } };
function observer(request: (options: unknown) => Promise<unknown>) { let ordinal = 0; return entryFn<(r: typeof request, mark: () => number, now: () => number) => RequestObserver>("createTenantTokenRequestObserver")(request, () => ++ordinal, () => 12); }
test("public observer retains exact options and original transport rejection without token data", async () => {
  const options = { method: "POST", url: "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", timeout: 5000, data: "PRIVATE_TOKEN_BODY" }, error = new Error("PRIVATE_ERROR"); let received: unknown;
  const o = observer(async value => { received = value; throw error; }); await assert.rejects(o.request(options), value => value === error); assert.equal(received, options); assert.equal(o.snapshot().operations[0]!.kind, "tenant_token_internal"); assert.equal(o.snapshot().operations[0]!.outcome, "rejected"); assert.equal(o.snapshot().invalid, false); assert.equal(JSON.stringify(o.snapshot()).includes("PRIVATE"), false);
});
for (const url of ["https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal", "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal?q=secret", "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal#secret", "https://secret@open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", "https://evil.invalid/open-apis/auth/v3/tenant_access_token/internal", "https://open.feishu.cn/open-apis/vc/v1/reserves/reserve/get_active_meeting"]) test(`public observer rejects alias or unexpected path ${url.split("/").at(-1)}`, async () => { const o = observer(async () => null); await o.request({ method: "POST", url, timeout: 5000 }); assert.equal(o.snapshot().invalid, true); });
test("public observer duplicate and third operation are sticky invalid and bounded", async () => { const o = observer(async () => null); for (let i = 0; i < 3; i++) await o.request({ method: "POST", url: "https://open.feishu.cn/callback/ws/endpoint", timeout: 5000 }); assert.equal(o.snapshot().invalid, true); assert.equal(o.snapshot().overflow, true); assert.equal(o.snapshot().operations.length, 2); });
test("request classifier rejects accessors without invoking them", () => { let calls = 0; const classify = entryFn<(v: unknown) => string>("classifyTenantTokenRequest"); const value = { method: "POST", get url() { calls++; return "SECRET"; } }; assert.equal(classify(value), "invalid"); assert.equal(calls, 0); });

for (const location of ["root", "marks", "times", "operations", "operation", "requests", "request", "hold", "owners", "receiver", "lifecycle", "event", "durable", "counts", "files", "qualification", "source", "failures"]) test(`writer ${location} accessor cannot run or emit private output`, async () => {
  const c = component(), result = structuredClone(await run(c.effects, { now: () => 12 })), out = mkdtempSync("/private/tmp/tenant-private-"); chmodSync(out, 0o700); let calls = 0;
  const root: object = location === "root" ? result : location === "qualification" ? result.qualification as object : location === "source" ? (result.qualification as { sources: object[] }).sources[0]! : location === "failures" ? result.failures : location === "operation" ? result.held!.operations[0]! : location === "request" ? result.held!.requests[0]! : location === "event" ? result.held!.lifecycle[0]! : location === "counts" ? result.held!.durable.counts : Reflect.get(result.held!, location) as object;
  Object.defineProperty(root, "privateSentinel", { enumerable: true, get() { calls++; return "PRIVATE"; } });
  try { const write = fn<(o: string, v: unknown) => void>("writeTenantTokenEvidence"); assert.throws(() => write(out, result)); assert.equal(calls, 0); assert.deepEqual(readdirSync(out), []); } finally { rmSync(out, { recursive: true, force: true }); }
});
for (const location of ["failures", "operations", "requests", "lifecycle", "sources"]) test(`writer ${location} custom array prototype cannot invoke inherited toJSON`, async () => {
  const result = structuredClone(await run(component().effects, { now: () => 12 })), out = mkdtempSync("/private/tmp/tenant-array-"); chmodSync(out, 0o700); let calls = 0;
  const array: object = location === "sources" ? (result.qualification as { sources: object[] }).sources : location === "failures" ? result.failures : Reflect.get(result.held!, location) as object;
  const proto = Object.create(Array.prototype); Object.defineProperty(proto, "toJSON", { get() { calls++; return () => ["PRIVATE"]; } }); Object.setPrototypeOf(array, proto);
  try { const write = fn<(o: string, v: unknown) => void>("writeTenantTokenEvidence"); assert.throws(() => write(out, result)); assert.equal(calls, 0); assert.deepEqual(readdirSync(out), []); } finally { rmSync(out, { recursive: true, force: true }); }
});
for (const mutate of [(v: Snapshot) => { Object.setPrototypeOf(v.owners, {}); }, (v: Snapshot) => { Object.defineProperty(v, Symbol("PRIVATE"), { value: "PRIVATE" }); }, (v: Snapshot) => { v.owners.http = NaN; }, (v: Snapshot) => { v.durable.totalAttempts = Number.MAX_SAFE_INTEGER + 1; }]) test("closed snapshot rejects custom record, symbol and invalid finite counters", () => { const capture = fn<(v: unknown) => unknown>("captureTenantTokenSnapshot"), v = snapshot(); mutate(v); assert.throws(() => capture(v)); });
test("synthetic flags cannot mint attempted application output", async () => { const result = structuredClone(await run(component().effects, { now: () => 12 })); result.provenance = "attempted-application"; const out = mkdtempSync("/private/tmp/tenant-forged-"); chmodSync(out, 0o700); try { const write = entryFn<(o: string, v: unknown) => void>("writeRealTenantTokenEvidence"); assert.throws(() => write(out, result), /actual_unqualified/); const ordinary = fn<(o: string, v: unknown) => void>("writeTenantTokenEvidence"); assert.throws(() => ordinary(out, result)); assert.deepEqual(readdirSync(out), []); } finally { rmSync(out, { recursive: true, force: true }); } });
test("source identity omission fails before any campaign effect", async () => { const c = component(), q = qualification(); q.sources.pop(); const phase = fn<(e: Effects, q: unknown) => Promise<Result>>("runTenantTokenPhase"); await assert.rejects(phase(c.effects, q)); assert.equal(c.calls.begin, 0); });
test("source qualification works with the existing built-stage layout without unshipped TypeScript sources", () => {
  const root = mkdtempSync("/private/tmp/tenant-qualified-layout-"), repository = path.resolve(import.meta.dirname, "..");
  try { symlinkSync(path.join(repository, "node_modules"), path.join(root, "node_modules")); for (const role of fn<() => string[]>("tenantTokenSourceRoles")()) { if (role.startsWith("src/") || role.startsWith("node_modules/")) continue; const target = path.join(root, role); mkdirSync(path.dirname(target), { recursive: true }); copyFileSync(path.join(repository, role), target); }
    const qualify = fn<(root: string) => { sources: { role: string; sha256: string }[] }>("qualifyTenantTokenSources"), result = qualify(root); assert.equal(result.sources.length, fn<() => string[]>("tenantTokenSourceRoles")().length); assert.ok(result.sources.every(row => /^[a-f0-9]{64}$/.test(row.sha256)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
function qualificationDependencyLayout(root: string) {
  const repository = path.resolve(import.meta.dirname, ".."); symlinkSync(path.join(repository, "node_modules"), path.join(root, "node_modules"));
  for (const role of new Set([...fn<() => string[]>("tenantTokenSourceRoles")(), "e2e/l4-campaign.mjs", "e2e/media-client.mjs"])) {
    if (role.startsWith("node_modules/")) continue; const target = path.join(root, role); mkdirSync(path.dirname(target), { recursive: true }); copyFileSync(path.join(repository, role), target); chmodSync(target, 0o600);
  }
}
for (const role of ["e2e/l4-campaign.mjs", "e2e/media-client.mjs"]) {
  test(`qualification changes when audited stage dependency ${role} bytes change`, () => {
    const qualify = fn<(root: string) => { sources: { role: string; sha256: string }[] }>("qualifyTenantTokenSources"), root = mkdtempSync("/private/tmp/tenant-dependency-hash-");
    try { qualificationDependencyLayout(root); const before = qualify(root); writeFileSync(path.join(root, role), "\n// component source-byte sensitivity\n", { flag: "a" }); const after = qualify(root);
      assert.notDeepEqual(after, before); assert.notEqual(after.sources.find(row => row.role === role)?.sha256, before.sources.find(row => row.role === role)?.sha256);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test(`qualification refuses a missing audited stage dependency ${role}`, () => {
    const qualify = fn<(root: string) => unknown>("qualifyTenantTokenSources"), root = mkdtempSync("/private/tmp/tenant-dependency-missing-");
    try { qualificationDependencyLayout(root); qualify(root); rmSync(path.join(root, role)); assert.throws(() => qualify(root)); } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const effect of ["begin", "send", "read", "closeHeld", "settle", "finish"] as const) test(`absolute deadline includes synchronous ${effect} time and still finishes once`, async () => {
  const c = component(); let now = 12;
  if (effect === "begin") { const original = c.effects.begin; c.effects.begin = async () => { const value = await original(); now = 100; return value; }; }
  if (effect === "send") c.effects.send = async () => { c.calls.send++; now = 100; };
  if (effect === "read") { const original = c.effects.read; c.effects.read = () => { const value = original(); now = 100; return value; }; }
  if (effect === "closeHeld") { const original = c.effects.closeHeld; c.effects.closeHeld = value => { const result = original(value); now = 100; return result; }; }
  if (effect === "settle") { const original = c.effects.settle; c.effects.settle = async close => { const result = await original(close); now = 100; return result; }; }
  if (effect === "finish") { const original = c.effects.finish; c.effects.finish = async () => { const result = await original(); now = 100; return result; }; }
  const result = await run(c.effects, { now: () => now, overallMs: 40 }); assert.equal(result.success, false); assert.equal(result.cleanupConfirmed, false); assert.ok(result.failures.includes("tenant_token_deadline")); assert.equal(c.calls.finish, 1);
});
test("expired-before-invocation prevents admission effects but retains one cleanup", async () => { const c = component(); let reads = 0; const result = await run(c.effects, { now: () => ++reads === 1 ? 0 : 100, overallMs: 40 }); assert.equal(c.calls.begin, 0); assert.equal(c.calls.finish, 1); assert.equal(result.success, false); });
test("held eligibility excludes token timeout races and shares exhausted poll allowance", async () => { const c = component(), read = c.effects.read; let reads = 0; c.effects.read = () => { reads++; const v = read(); v.hold = null; return v; }; const result = await run(c.effects, { now: () => 12, sleep: async () => {}, pollAllowance: { remaining: 0 } }); assert.equal(reads, 2); assert.equal(result.polls, 0); assert.equal(c.calls.selected, 0); assert.ok(result.failures.includes("tenant_token_poll_exhausted")); });
test("drain has a fixed commit+14500 cutoff before discovery abort and no repeat budget", async () => { const c = component(), settle = c.effects.settle; let now = 12; c.effects.settle = async close => { const value = await settle(close); now = 14510; return value; }; const result = await run(c.effects, { now: () => now }); assert.equal(result.success, false); assert.ok(result.failures.includes("tenant_token_deadline")); assert.equal(c.calls.finish, 1); });
test("late rejected close preserves primary failure alongside deadline and cannot promote cleanup", async () => { const c = component(); let now = 12; c.effects.settle = async () => { now = 14510; throw new Error("tenant_token_close_failed"); }; const result = await run(c.effects, { now: () => now }); assert.deepEqual(result.failures, ["tenant_token_close_failed", "tenant_token_deadline"]); assert.equal(result.success, false); assert.equal(c.calls.finish, 1); });
test("held eligibility expiry prevents either selected public close", async () => { const c = component(); let now = 12; c.effects.send = async () => { now = 2510; }; const result = await run(c.effects, { now: () => now }); assert.equal(c.calls.selected, 0); assert.equal(c.calls.close, 1); assert.equal(result.success, false); assert.equal(c.calls.finish, 1); });
test("same-stack close checkpoints prevent the second effect after a synchronous first-close overrun", () => { let expired = false, calls = 0; const close = fn<(v: unknown, r: () => unknown, app: unknown, mark: () => void, check: () => void) => unknown>("closeHeldTenantToken"); assert.throws(() => close(snapshot(), snapshot, { close() { calls++; expired = true; return Promise.resolve(); } }, () => {}, () => { if (expired) throw new Error("tenant_token_deadline"); }), /deadline/); assert.equal(calls, 1); });
test("held and settlement observations consume one shared finite poll allowance", async () => { const c = component(), read = c.effects.read, settle = c.effects.settle; let reads = 0; c.effects.read = () => { const v = read(); if (++reads === 1) v.hold = null; return v; }; c.effects.settle = async (close, phase, deadline) => { const value = await settle(close); await phase!.poll(deadline!); return value; }; const result = await run(c.effects, { now: () => 12, sleep: async () => {}, pollAllowance: { remaining: 1 } }); assert.equal(result.polls, 1); assert.ok(result.failures.includes("tenant_token_poll_exhausted")); assert.equal(result.success, false); assert.equal(c.calls.finish, 1); });
test("a regressing clock fixes failure and still invokes ownership cleanup once", async () => { const c = component(); let now = 12; c.effects.send = async () => { now = 0; }; const result = await run(c.effects, { now: () => now }); assert.equal(result.success, false); assert.equal(c.calls.finish, 1); });
test("preparation time consumes the existing overall budget rather than resetting at admission", async () => { const c = component(); const result = await run(c.effects, { startedAt: 0, now: () => 50, overallMs: 40 }); assert.equal(c.calls.begin, 0); assert.equal(c.calls.finish, 1); assert.equal(result.success, false); assert.equal(result.elapsedMs, 50); });
test("synchronous final serialization cannot turn a deadline overrun into success", async () => {
  const c = component(); let now = 12; const original = JSON.stringify;
  JSON.stringify = value => { const serialized = original(value); if (value && typeof value === "object" && Reflect.get(value, "schema") === "meeting-tenant-token-evidence/v1") now = 100; return serialized; };
  try { const result = await run(c.effects, { now: () => now, overallMs: 40 }); assert.equal(result.success, false); assert.equal(result.cleanupConfirmed, false); assert.ok(result.failures.includes("tenant_token_deadline")); assert.equal(c.calls.finish, 1); } finally { JSON.stringify = original; }
});
test("exact standalone parser accepts only one new absolute output path", () => { const parse = fn<(v: unknown) => { out: string }>("parseTenantTokenArguments"), root = mkdtempSync("/private/tmp/tenant-argv-"); try { assert.deepEqual(parse(["--out", path.join(root, "new")]), { out: path.join(root, "new") }); for (const args of [[], ["--out"], ["--out", "relative"], ["--out", root], ["--mode", "tenant-token-timeout-close", "--out", path.join(root, "new")], ["--out", path.join(root, "new"), "--out", path.join(root, "new2")]]) assert.throws(() => parse(args)); } finally { rmSync(root, { recursive: true, force: true }); } });

async function compiledFactory<T>(filename: string, name: string): Promise<T> { const value: unknown = await import(new URL(filename, import.meta.url).href); assert.ok(value && typeof value === "object"); const factory: unknown = Reflect.get(value, name); assert.equal(typeof factory, "function"); return factory as T; }
class Wire extends Duplex { _read() {} _write(_chunk: Buffer, _encoding: string, callback: () => void) { callback(); } }
type PeerControls = { handler: (request: IncomingMessage, response: ServerResponse) => void; armNext: (v: { route: string; outcome: string }) => string; readPendingHold: (id: string) => { id: string; method: string; route: string } | null; requests: { method: string; route: string; status: number }[]; close: () => void };
test("actual default-5000 HTTP owner aborts in-memory complete-body peer hold before fixture cleanup", async t => {
  const httpFactory = await compiledFactory<typeof HttpFactory>("../dist/src/adapters/feishu-sdk-http.js", "createFeishuSdkHttp"), socketFactory = await compiledFactory<typeof SocketFactory>("../dist/src/adapters/feishu-sdk-connection.js", "createFeishuSocketOwner");
  const controlsModule: unknown = await import(new URL("./feishu-peer-controls.mjs", import.meta.url).href); assert.ok(controlsModule && typeof controlsModule === "object"); const factory: unknown = Reflect.get(controlsModule, "createFeishuPeerControls"); assert.equal(typeof factory, "function");
  const p = (factory as (v: unknown) => PeerControls)({ meeting: { providerMeetingId: "component", meetingNo: "1", title: "component", startSeconds: 1 }, wsPath: () => "ws://peer.invalid/ws" }), id = p.armNext({ route: "tenant_access_token", outcome: "hold" }), wire = new Wire();
  class Agent extends HttpAgent { override createConnection(options: ClientRequestArgs): Duplex { void options; return wire; } }
  const owner = socketFactory(Agent); let fixtureCleanup = false, actualSignal: AbortSignal | undefined;
  const transport: NonNullable<NonNullable<Parameters<typeof HttpFactory>[0]>["request"]> = async opts => {
    owner.agent.createConnection({}); const request = new IncomingMessage(wire as unknown as Socket); request.method = opts.method; request.url = new URL(opts.url!).pathname;
    const body = Buffer.from(JSON.stringify(opts.data)); request.headers = { "content-length": String(body.length) }; const response = new ServerResponse(request); response.assignSocket(wire as unknown as Socket);
    actualSignal = opts.signal as AbortSignal; const pending = new Promise<never>((_resolve, reject) => { wire.once("close", () => reject(new Error("owned_remote_close"))); actualSignal!.addEventListener("abort", () => { request.destroy(); response.destroy(); wire.destroy(); }, { once: true }); });
    p.handler(request, response); request.complete = true; request.push(body); request.push(null); return pending;
  };
  t.mock.timers.enable({ apis: ["setTimeout"] }); const http = httpFactory({ request: transport, connection: owner }), pending = http.instance.post("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", { fixture: "PRIVATE" }); pending.catch(() => {});
  try { await setImmediate(); assert.deepEqual(p.readPendingHold(id), { id, method: "POST", route: "tenant_access_token" }); assert.equal(http.activeCount, 1); assert.equal(owner.activeCount, 1); assert.equal(owner.pendingCount, 0);
    t.mock.timers.tick(4999); assert.equal(actualSignal?.aborted, false); assert.equal(http.activeCount, 1); t.mock.timers.tick(1); await assert.rejects(pending, /feishu_http_timeout/); await setImmediate();
    assert.equal(actualSignal?.aborted, true); assert.equal(fixtureCleanup, false); assert.equal(http.activeCount, 0); assert.equal(owner.activeCount, 0); assert.equal(owner.pendingCount, 0); assert.equal(p.readPendingHold(id), null); assert.deepEqual(p.requests, [{ method: "POST", route: "tenant_access_token", status: 499 }]); await http.close(); fixtureCleanup = true; p.close();
  } finally { t.mock.timers.reset(); wire.destroy(); await http.close(); if (!fixtureCleanup) p.close(); }
});
test("actual socket owner retains destroy-requested ownership until the real close event", async () => {
  const factory = await compiledFactory<typeof SocketFactory>("../dist/src/adapters/feishu-sdk-connection.js", "createFeishuSocketOwner"); let complete!: () => void;
  class Delayed extends Wire { override _destroy(_error: Error | null, done: () => void) { complete = done; } }
  const wire = new Delayed(); class Agent extends HttpAgent { override createConnection(options: ClientRequestArgs): Duplex { void options; return wire; } } const owner = factory(Agent); owner.agent.createConnection({});
  const closing = owner.close(100); assert.equal(wire.destroyed, true); assert.equal(owner.activeCount, 1); complete(); await setImmediate(); assert.equal(await closing, true); assert.equal(owner.activeCount, 0);
});
test("actual HTTP owner forwards SDK-shaped lowercase endpoint post and uppercase tenant post into one normalized observer", async () => {
  const factory = await compiledFactory<typeof HttpFactory>("../dist/src/adapters/feishu-sdk-http.js", "createFeishuSdkHttp");
  type Request = NonNullable<NonNullable<Parameters<typeof HttpFactory>[0]>["request"]>;
  const original = new Error("component_transport_rejection"), received: { method: string | undefined; timeout: number | undefined }[] = [];
  const transport: Request = async options => { received.push({ method: options.method, timeout: options.timeout }); throw original; };
  const observe = entryFn<(request: Request, mark: () => number, now: () => number) => { request: Request; snapshot: RequestObserver["snapshot"] }>("createTenantTokenRequestObserver"); let ordinal = 0;
  const observed = observe(transport, () => ++ordinal, () => 12), http = factory({ request: observed.request });
  try {
    // SDK pullConnectConfig uses request(method:"post", timeout:15000).
    // SDK requestToken uses public instance.post, which the owner makes POST.
    await assert.rejects(http.instance.request({ method: "post", url: "https://open.feishu.cn/callback/ws/endpoint", timeout: 15000 }), /feishu_http_failed/);
    await assert.rejects(http.instance.post("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", { component: true }), /feishu_http_failed/);
    assert.deepEqual(received, [{ method: "post", timeout: 5000 }, { method: "POST", timeout: 5000 }]);
    assert.deepEqual(observed.snapshot().operations.map(row => row.kind), ["ws_endpoint", "tenant_token_internal"]); assert.deepEqual(observed.snapshot().operations.map(row => row.method), ["POST", "POST"]); assert.equal(observed.snapshot().invalid, false); assert.equal(observed.snapshot().overflow, false); assert.equal(http.activeCount, 0);
  } finally { await http.close(); }
});
test("actual frame decoder owner reaches the same production receiver projection and exact commit ACK assertion", async () => {
  const peer: unknown = await import(new URL("./feishu-peer.mjs", import.meta.url).href); assert.ok(peer && typeof peer === "object");
  const factory: unknown = Reflect.get(peer, "createFeishuFrameReceiver"), encode: unknown = Reflect.get(peer, "eventFrame"); assert.equal(typeof factory, "function"); assert.equal(typeof encode, "function");
  type ReceiverOwner = { invalid: boolean; overflow: boolean; observations: unknown[]; receive: (frame: Buffer) => void };
  const owner = (factory as () => ReceiverOwner)(); owner.receive((encode as (body: unknown, id: string) => Buffer)({ code: 200 }, "tenant-original-wire"));
  assert.equal(typeof Object.getOwnPropertyDescriptor(owner, "invalid")?.get, "function"); assert.ok(ingress && typeof ingress === "object");
  const dto: unknown = Reflect.get(ingress, "ingressReceiverFact"), assertAck: unknown = Reflect.get(ingress, "assertIngressAck"); assert.equal(typeof dto, "function"); assert.equal(typeof assertAck, "function");
  // External DTO validation remains getter-free; the trusted owner needs an
  // explicit public projection before crossing that unchanged boundary.
  assert.throws(() => (dto as (v: unknown) => unknown)(owner), /ingress_data_descriptor/);
  const project = entryFn<(owner: ReceiverOwner) => unknown>("projectTenantTokenReceiver"), projected = project(owner);
  assert.deepEqual(projected, { invalid: false, overflow: false, observations: [{ ordinal: 1, kind: "ack", messageId: "tenant-original-wire", payload: { code: 200 } }] });
  const hash = "a".repeat(64), send = { wireMessageId: "tenant-original-wire", eventId: "component-event", hash, occurrenceId: "component-occurrence" };
  assert.doesNotThrow(() => (assertAck as (send: unknown, delivery: unknown) => void)(send, { commit: { ordinal: 1, wireMessageId: send.wireMessageId, eventId: send.eventId, expectedHash: hash, persistedHash: hash, immutable: { occurrenceId: send.occurrenceId }, ackFloor: 0 }, receiver: projected }));
});
