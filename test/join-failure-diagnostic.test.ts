import assert from "node:assert/strict";
import fs, { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, lstatSync, symlinkSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { test as nodeTest, mock } from "node:test";
import { types } from "node:util";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import { createCoordinator } from "../src/sessions/coordinator.ts";
import { createMeetingSession, BridgeContractError, type MeetingSession } from "../src/sessions/meeting-session.ts";
import type { VoiceSessionHandle } from "../src/ports/conversation-runtime.ts";
import type { BridgeCommandMessageV2 } from "../src/contracts/bridge-session-v2.ts";
import { fakeRuntime } from "./lib/session-fakes.ts";

type Diagnostic = { phase(value: string): void; fail(error: unknown): void };
async function diagnostic() {
  let helper: { createJoinFailureDiagnostic?: () => Diagnostic | undefined } = {};
  try { helper = await import(new URL("../src/sessions/join-failure-diagnostic.ts", import.meta.url).href); } catch { /* Missing implementation is an assertion. */ }
  assert.equal(typeof helper.createJoinFailureDiagnostic, "function", "private observer must exist");
  return helper.createJoinFailureDiagnostic!();
}
function test(name: string, run: () => void | Promise<void>) {
  const selected = process.env.MEETING_PRIVATE_JOIN_FAILURE_TEST;
  if (selected) { if (selected === name) nodeTest(name, run); return; }
  nodeTest(name, () => {
    const root = mkdtempSync("/private/tmp/join-failure-test-"); const sink = path.join(root, "sink"); mkdirSync(sink, { mode: 0o700 });
    try {
      const env: Record<string, string> = { MEETING_PRIVATE_JOIN_FAILURE_TEST: name };
      if (!name.startsWith("disabled")) env.MEETING_PRIVATE_JOIN_DIAGNOSTIC_DIR = sink;
      const child = spawnSync(process.execPath, ["--test", fileURLToPath(import.meta.url)], { env, encoding: "utf8" });
      assert.equal(child.status, 0, child.stdout + child.stderr); assert.equal(child.signal, null);
    } finally { rmSync(root, { recursive: true }); }
  });
}
const sink = () => process.env.MEETING_PRIVATE_JOIN_DIAGNOSTIC_DIR!;
const rows = () => { process.emit("exit", 0); return readdirSync(sink()).sort().map(name => JSON.parse(readFileSync(path.join(sink(), name), "utf8"))); };
const expected = (phase: string, errorClass = "native_error") => ({ schema: "join-failure-diagnostic/v1", phase, errorClass });
async function joinProbe(mode: string, original: unknown = new Error("PRIVATE-ORIGINAL"), enabled = true) {
  const directory = sink() ? path.dirname(sink()) : mkdtempSync("/private/tmp/join-failure-disabled-");
  const store = openSessionStore({ filename: path.join(directory, "state.db") }); const clock = { now: () => 1000 };
  const identity = buildMeetingIdentity({ providerMeetingId: "synthetic", meetingNo: "000000000", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "Synthetic", organizer: null });
  const coordinator = createCoordinator({ store, clock, bridgeLeaseTtlMs: 30000, maxConcurrentSessions: 1 }); coordinator.discover(identity);
  const lifecycle: string[] = [], commands: string[] = [];
  const handle = { timingContract: "capture-clock/v1", sessionId: 42n, bridgeSessionId: "private-bridge", mediaLease: { sessionId: 42n, mediaProtocolVersion: 3, timingContract: "capture-clock/v1", captureFormat: "pcm_s16le/24000/1/20ms", credential: "PRIVATE-CAPABILITY", connectEndpoint: "PRIVATE-ENDPOINT", expiresAtMs: 60000n, reconnectWindowMs: 10000n } };
  if (mode === "binding") handle.mediaLease.captureFormat = "wrong";
  if (mode === "parse") handle.mediaLease.credential = "";
  const fake = fakeRuntime();
  const runtime = { ...fake, currentSessionId: mode === "control" ? 0n : 42n,
    async startVoiceSession() { lifecycle.push("runtime_start"); if (mode.startsWith("runtime")) throw original; if (mode === "cancel") void session.dispose(); return handle as VoiceSessionHandle; },
    subscribe: () => () => { lifecycle.push("runtime_unsubscribe"); } };
  const bridge = { subscribe() { if (mode === "subscribe") throw original; return () => { lifecycle.push("bridge_unsubscribe"); }; },
    async send(command: BridgeCommandMessageV2) { lifecycle.push(command.type); commands.push(command.type);
      if (command.type === "join" && mode === "join") throw original;
      if (command.type === "connect_media" && mode === "connect") throw original;
      if (command.type === "leave" && mode === "runtime-cleanup") throw new Error("PRIVATE-CLEANUP");
    } };
  const session: MeetingSession = createMeetingSession({ identity, runtime, bridge, coordinator, clock, agentIdentity: { aliases: ["Meetbot"] }, bridgeId: "mac", bridgeSessionId: "private-bridge", disclosureText: "Disclosure", timedEvidence: { store } });
  let caught: unknown;
  try {
    try { await session.join(); } catch (error) { caught = error; }
    const state = session.state(); const settledLifecycle = [...lifecycle];
    if (enabled) assert.deepEqual(readdirSync(sink()), [], "join settlement cannot flush diagnostic");
    await session.dispose(); store.close(); if (!enabled) rmSync(directory, { recursive: true });
    if (enabled) assert.deepEqual(readdirSync(sink()), [], "disposal cannot flush diagnostic");
    return { original, caught, state, commands, lifecycle: settledLifecycle, rows: enabled ? rows() : [] };
  } catch (error) { await session.dispose(); store.close(); throw error; }
}
for (const [mode, phase] of [["join", "join_send"], ["runtime", "runtime_admission"], ["connect", "connect_media_send"], ["subscribe", "subscriptions"]]) {
  test(`actual imported session first ${mode} rejection retains phase and original identity`, async () => {
    const p = await joinProbe(mode!); assert.equal(p.caught, p.original); assert.equal(p.state.terminalReason, "join_failed");
    assert.deepEqual(p.rows, [expected(phase!)]); assert.ok(p.lifecycle.includes("bridge_unsubscribe") || mode === "subscribe");
    assert.equal(p.commands.includes("connect_media"), mode === "connect");
    if (mode === "runtime") assert.deepEqual(p.lifecycle, ["join", "runtime_start", "leave", "bridge_unsubscribe", "runtime_unsubscribe"]);
  });
}
for (const [mode, phase] of [["control", "timed_control"], ["binding", "admitted_binding"], ["parse", "connect_media_send"], ["cancel", "admission_cancel_check"]]) {
  test(`actual imported session existing ${mode} guard records only current boundary`, async () => {
    const p = await joinProbe(mode!); assert.ok(p.caught instanceof Error); assert.deepEqual(p.rows, [expected(phase!)]);
    assert.equal(p.commands.includes("connect_media"), false);
  });
}
test("actual imported session native BridgeContractError keeps original media-format guard", async () => {
  const original = new BridgeContractError("command", "synthetic", "synthetic", "PRIVATE");
  const p = await joinProbe("join", original); assert.equal(p.caught, original); assert.equal(p.state.terminalReason, "media_format_rejected"); assert.deepEqual(p.rows, [expected("join_send")]);
});
test("actual imported session unknown primitive keeps exact original rejection", async () => {
  const original = Symbol("PRIVATE"); const p = await joinProbe("runtime", original); assert.equal(p.caught, original); assert.deepEqual(p.rows, [expected("runtime_admission", "unknown")]);
});
test("actual imported session cleanup rejection cannot replace first Runtime rejection", async () => {
  const p = await joinProbe("runtime-cleanup"); assert.equal(p.caught, p.original); assert.equal(p.state.terminalReason, "join_failed");
  assert.deepEqual(p.rows, [expected("runtime_admission")]);
  assert.deepEqual(p.lifecycle, ["join", "runtime_start", "leave", "bridge_unsubscribe", "runtime_unsubscribe"]);
});
test("actual imported session diagnostic classifier exception cannot replace first rejection", async () => {
  const classifier = mock.method(types, "isNativeError", () => { throw new Error("PRIVATE-OBSERVER"); });
  try { const p = await joinProbe("runtime"); assert.equal(p.caught, p.original); assert.equal(p.state.terminalReason, "join_failed"); assert.deepEqual(p.rows, []); }
  finally { classifier.mock.restore(); }
});
test("actual imported session success retains commands and produces no failure row", async () => {
  const p = await joinProbe("success"); assert.equal(p.caught, undefined); assert.equal(p.state.terminalReason, null);
  assert.deepEqual(p.commands.slice(0, 3), ["join", "connect_media", "post_disclosure"]); assert.deepEqual(p.rows, []);
});
test("disabled import installs no observer and preserves original runtime rejection", async () => {
  assert.equal(await diagnostic(), undefined);
  assert.equal(process.rawListeners("exit").some(listener => Reflect.get(listener, "listener")?.name === "flushJoinFailureDiagnostic"), false);
  const p = await joinProbe("runtime", new Error("PRIVATE"), false); assert.equal(p.caught, p.original);
});
test("helper performs no filesystem or serialization before exit", async () => {
  const create = (await import(new URL("../src/sessions/join-failure-diagnostic.ts", import.meta.url).href)).createJoinFailureDiagnostic as () => Diagnostic;
  const spies = [mock.method(fs, "lstatSync"), mock.method(fs, "realpathSync"), mock.method(fs, "openSync"), mock.method(fs, "writeSync"), mock.method(fs, "closeSync")];
  const stringify = mock.method(JSON, "stringify"); syncBuiltinESMExports();
  try {
    const d = create(); d.phase("runtime_admission"); d.fail(new Error("PRIVATE"));
    assert.deepEqual(spies.map(spy => spy.mock.callCount()), [0, 0, 0, 0, 0]);
    assert.equal(stringify.mock.callCount(), 0);
    process.emit("exit", 0); assert.deepEqual(spies.map(spy => spy.mock.callCount()), [1, 1, 1, 1, 1]); assert.equal(stringify.mock.callCount(), 1);
    process.emit("exit", 0); assert.equal(stringify.mock.callCount(), 1);
  } finally { for (const spy of spies) spy.mock.restore(); stringify.mock.restore(); syncBuiltinESMExports(); }
});
for (const variant of ["proxy", "revoked", "accessors", "prototype-proxy", "custom-prototype", "non-error", "primitive"] as const) {
  test(`helper ${variant} classification invokes no traps getters coercion or prototype traversal`, async () => {
    const d = (await diagnostic())!; let invoked = 0;
    const trap = () => { invoked++; throw new Error("PRIVATE-TRAP"); };
    let error: unknown = new Error("PRIVATE");
    if (variant === "proxy") error = new Proxy(error as Error, { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap, ownKeys: trap });
    if (variant === "revoked") { const p = Proxy.revocable(error as Error, {}); p.revoke(); error = p.proxy; }
    if (variant === "accessors") for (const key of ["name", "message", "stack", "cause", "constructor"]) Object.defineProperty(error, key, { get: trap });
    if (variant === "prototype-proxy") Object.setPrototypeOf(error, new Proxy({}, { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap, ownKeys: trap }));
    if (variant === "custom-prototype") Object.setPrototypeOf(error, { get name() { return trap(); }, get constructor() { return trap(); } });
    if (variant === "non-error") error = { get name() { return trap(); }, [Symbol.toPrimitive]: trap };
    if (variant === "primitive") error = Symbol("PRIVATE");
    const original = error; d.phase("runtime_admission"); d.fail(error); assert.equal(error, original); assert.equal(invoked, 0);
    const native = ["accessors", "prototype-proxy", "custom-prototype"].includes(variant);
    assert.deepEqual(rows(), [expected("runtime_admission", native ? "native_error" : "unknown")]); assert.equal(invoked, 0);
  });
}
test("helper retains one closed row despite duplicate failure and phase floods", async () => {
  const d = (await diagnostic())!; d.phase("join_send"); d.fail(new Error("PRIVATE"));
  for (let i = 0; i < 10000; i++) { d.phase("connect_media_send"); d.fail(Symbol("PRIVATE")); }
  assert.deepEqual(rows(), [expected("join_send")]); assert.equal(readdirSync(sink()).length, 1); assert.equal(lstatSync(path.join(sink(), "join-failure.json")).mode & 0o777, 0o600);
});
test("helper second attempted join invalidates all evidence without allocating another observer", async () => {
  const d = (await diagnostic())!; d.phase("join_send"); d.fail(new Error("PRIVATE")); assert.equal(await diagnostic(), undefined);
  assert.deepEqual(rows(), []);
});
test("enabled import owns one exit listener consumed once", async () => {
  const listeners = () => process.rawListeners("exit").filter(listener => Reflect.get(listener, "listener")?.name === "flushJoinFailureDiagnostic");
  assert.equal(listeners().length, 1); const d = (await diagnostic())!; d.phase("join_send"); d.fail(new Error("PRIVATE"));
  assert.deepEqual(rows(), [expected("join_send")]); assert.equal(listeners().length, 0); assert.equal(await diagnostic(), undefined);
});
test("helper refuses unknown phase without coercing or retaining unsafe input", async () => {
  const d = (await diagnostic())!; let traps = 0;
  d.phase(new Proxy({}, { get() { traps++; throw new Error("PRIVATE"); } }) as unknown as string); d.fail(new Error("PRIVATE"));
  assert.equal(traps, 0); assert.deepEqual(rows(), []);
});
test("export validates sink only at exit and refuses unsafe permissions", async () => {
  const d = (await diagnostic())!; d.phase("join_send"); d.fail(new Error("PRIVATE")); fs.chmodSync(sink(), 0o755); assert.deepEqual(rows(), []);
});
test("export refuses symlink sink while retaining no admission IO", async () => {
  const d = (await diagnostic())!; d.phase("join_send"); d.fail(new Error("PRIVATE"));
  const actual = sink() + "-actual"; fs.renameSync(sink(), actual); symlinkSync(actual, sink());
  assert.deepEqual(rows(), []); assert.deepEqual(readdirSync(actual), []);
});
test("export exclusive no-follow output preserves preexisting symlink target", async () => {
  const d = (await diagnostic())!; d.fail(new Error("PRIVATE")); const target = path.join(path.dirname(sink()), "target"); writeFileSync(target, "PRIVATE-EXISTING", { mode: 0o600 }); symlinkSync(target, path.join(sink(), "join-failure.json")); process.emit("exit", 0);
  assert.equal(readFileSync(target, "utf8"), "PRIVATE-EXISTING"); assert.equal(lstatSync(path.join(sink(), "join-failure.json")).isSymbolicLink(), true);
});
test("export write failure closes descriptor and cannot throw or retry", async () => {
  const d = (await diagnostic())!; d.fail(new Error("PRIVATE")); const write = mock.method(fs, "writeSync", () => { throw new Error("PRIVATE"); }), close = mock.method(fs, "closeSync"); syncBuiltinESMExports();
  try { assert.doesNotThrow(() => process.emit("exit", 0)); assert.equal(write.mock.callCount(), 1); assert.equal(close.mock.callCount(), 1); process.emit("exit", 0); assert.equal(write.mock.callCount(), 1); }
  finally { write.mock.restore(); close.mock.restore(); syncBuiltinESMExports(); }
});
if (!process.env.MEETING_PRIVATE_JOIN_FAILURE_TEST) for (const compiled of [false, true]) for (const failedSink of [false, true]) {
  nodeTest(`${compiled ? "compiled" : "source"} helper genuine process.exit70 flush preserves exit and nonexit no-IO with ${failedSink ? "refused" : "safe"} sink`, () => {
    const root = mkdtempSync("/private/tmp/join-failure-explicit70-"); const directory = path.join(root, "sink"); mkdirSync(directory, { mode: failedSink ? 0o755 : 0o700 });
    try {
      const helper = new URL(compiled ? "../dist/src/sessions/join-failure-diagnostic.js" : "../src/sessions/join-failure-diagnostic.ts", import.meta.url).href;
      const code = `import assert from 'node:assert/strict'; import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; const {createJoinFailureDiagnostic}=await import(${JSON.stringify(helper)}); const counts=[0,0,0,0,0]; for (const [i,key] of ['lstatSync','realpathSync','openSync','writeSync','closeSync'].entries()){const f=fs[key];fs[key]=(...args)=>{counts[i]++;return f(...args);};}syncBuiltinESMExports();let serializations=0;const stringify=JSON.stringify;JSON.stringify=(...args)=>{serializations++;return stringify(...args);};const d=createJoinFailureDiagnostic();d.phase('runtime_admission');d.fail(new Error('PRIVATE'));for(let i=0;i<10000;i++){d.phase('connect_media_send');d.fail(Symbol('PRIVATE'));}assert.deepEqual(counts,[0,0,0,0,0]);assert.equal(serializations,0);process.exit(70);`;
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { MEETING_PRIVATE_JOIN_DIAGNOSTIC_DIR: directory }, encoding: "utf8" });
      assert.equal(child.status, 70, child.stdout + child.stderr); assert.equal(child.signal, null); assert.equal(child.stdout, ""); assert.equal(child.stderr, "");
      if (failedSink) assert.deepEqual(readdirSync(directory), []);
      else { assert.deepEqual(readdirSync(directory), ["join-failure.json"]); assert.deepEqual(JSON.parse(readFileSync(path.join(directory, "join-failure.json"), "utf8")), expected("runtime_admission")); assert.equal(lstatSync(path.join(directory, "join-failure.json")).mode & 0o777, 0o600); }
    } finally { rmSync(root, { recursive: true }); }
  });
}
