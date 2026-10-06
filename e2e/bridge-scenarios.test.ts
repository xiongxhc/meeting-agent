import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { validateCustodyBinding, decodeBridgeProcessOutcome, sameCustodyBinding, OUTCOME_MAX_BYTES } from "../src/contracts/bridge-process-outcome-v1.ts";
// @ts-expect-error Private fixture helper has no public declaration.
import { parsePhysicalOutcomeScenario, readPhysicalOutcomeClose, createPhysicalOutcomeEmitter } from "./fixtures/bridge-scenarios.mjs";
// @ts-expect-error Private fixture lifecycle has no public declaration.
import { createCaptureLifecycle } from "./fixtures/scripted-capture-lifecycle.mjs";

const config = JSON.parse(fs.readFileSync(new URL("../spikes/feishu/fixtures/process/config-v2.json", import.meta.url), "utf8"));
const binding = validateCustodyBinding(config.custody);
const at = "2026-10-05T10:00:00.123Z";
const scenario = (mode: string) => parsePhysicalOutcomeScenario({ schema: "e2e-bridge-physical-outcome/v1", mode });
const command = (action = "emit", expected = binding) => ({ schema: "e2e-bridge-physical-outcome-close/v1", binding: { ...expected }, action });
const observations = [
  { joined: false, left: null, outcome: "no_join_action", reason: "join_not_issued" },
  { joined: true, left: null, outcome: "departure_unconfirmed", reason: "departure_not_observed" },
  ...["ended", "removed", "bridge_failure"].map(left => ({ joined: true, left, outcome: "departure_confirmed", reason: "departure_observed" })),
];
function pipe(mode?: string, overrides: Record<string, unknown> = {}) {
  const stream = new PassThrough(), chunks: Buffer[] = [], states: Array<Record<string, unknown>> = [];
  let writes = 0, closes = 0, ended = false;
  const eof = (async () => { for await (const chunk of stream) chunks.push(Buffer.from(chunk)); ended = true; return Buffer.concat(chunks); })();
  const owner = createPhysicalOutcomeEmitter({ binding, scenario: mode === undefined ? parsePhysicalOutcomeScenario(undefined) : scenario(mode),
    write: (bytes: Buffer) => { writes++; stream.write(bytes); return bytes.length; },
    close: () => { closes++; stream.end(); }, now: () => at,
    onState: (state: Record<string, unknown>) => states.push(state), ...overrides });
  return { owner, eof, stream, states, writes: () => writes, closes: () => closes, ended: () => ended };
}
function expected(row: typeof observations[number], when = at) {
  return `${JSON.stringify({ schema: "bridge-process-outcome/v1", ...binding, outcome: row.outcome, reason: row.reason, observedAt: when })}\n`;
}
function decode(bytes: Buffer) {
  assert.ok(bytes.length <= OUTCOME_MAX_BYTES); assert.equal(bytes.at(-1), 10);
  assert.equal(bytes.toString().split("\n").length, 2);
  return decodeBridgeProcessOutcome(bytes.toString().slice(0, -1));
}

test("selector defaults to frozen normal and refuses unknown shapes", () => {
  assert.deepEqual(parsePhysicalOutcomeScenario(undefined), scenario("normal"));
  assert.ok(Object.isFrozen(scenario("held")));
  for (const value of [null, [], "normal", {}, { schema: "wrong", mode: "normal" }, { schema: "e2e-bridge-physical-outcome/v1", mode: "unknown" }, { ...scenario("normal"), extra: true }]) {
    assert.throws(() => parsePhysicalOutcomeScenario(value), /invalid_physical_outcome_scenario/);
  }
});
test("absent and explicit normal preserve original bytes, key order, classification and EOF", async () => {
  for (const row of observations) for (const mode of [undefined, "normal"]) {
    const f = pipe(mode); await f.owner.finish(row); const bytes = await f.eof;
    assert.equal(bytes.toString(), expected(row)); assert.equal(sameCustodyBinding(decode(bytes), binding), true);
    assert.equal(f.writes(), 1); assert.equal(f.closes(), 1); assert.equal(f.ended(), true);
  }
});
test("missing closes without bytes; invalid emits only the fixed rejected record", async () => {
  for (const mode of ["missing", "invalid"]) {
    const f = pipe(mode); assert.deepEqual(await f.owner.finish(observations[2]), { exitCode: 0, phase: mode === "missing" ? "closed_missing" : "emitted" });
    const bytes = await f.eof;
    assert.equal(bytes.toString(), mode === "missing" ? "" : '{"schema":"bridge-process-outcome/v1"}\n');
    assert.equal(f.closes(), 1); assert.throws(() => decodeBridgeProcessOutcome(bytes.toString()));
  }
});
test("stale generation changes only serialized generation and keeps expected binding immutable", async () => {
  for (const first of ["0", "a"]) {
    const input = { ...binding, physicalGenerationId: first + binding.physicalGenerationId.slice(1) }, before = { ...input };
    const f = pipe("stale_generation", { binding: input }); await f.owner.finish(observations[2]); const result = decode(await f.eof);
    assert.equal(sameCustodyBinding(result, input), false); assert.deepEqual(input, before);
    assert.equal(result.physicalGenerationId, (first === "0" ? "1" : "0") + input.physicalGenerationId.slice(1));
    assert.deepEqual({ ...result, physicalGenerationId: input.physicalGenerationId }, { ...JSON.parse(expected(observations[2]!)), ...input });
  }
});
test("nonzero requests cooperative exit 2 with normal bytes for every classification, not OS reap evidence", async () => {
  for (const row of observations.slice(0, 3)) {
    const f = pipe("nonzero_exit"); assert.deepEqual(await f.owner.finish(row), { exitCode: 2, phase: "emitted" });
    assert.equal((await f.eof).toString(), expected(row)); assert.equal(f.closes(), 1);
  }
});
test("held requires explicit close and samples timestamp at emit, then cancels deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let when = at, settled = false;
  const f = pipe("held", { now: () => when }); const finish = f.owner.finish(observations[2]);
  void finish.then(() => { settled = true; }); await Promise.resolve();
  assert.equal(f.owner.finish(observations[0]), finish); assert.equal(f.writes(), 0); assert.equal(f.ended(), false); assert.equal(settled, false);
  assert.deepEqual(f.states, [{ mode: "held", phase: "held", binding }]);
  t.mock.timers.tick(999); await Promise.resolve(); assert.equal(f.writes(), 0); assert.equal(settled, false);
  when = "2026-10-05T10:00:01.123Z"; f.owner.closeWith(command());
  assert.deepEqual(await finish, { exitCode: 0, phase: "emitted" }); assert.equal((await f.eof).toString(), expected(observations[2]!, when));
  t.mock.timers.runAll(); assert.equal(f.writes(), 1); assert.equal(f.closes(), 1);
  assert.throws(() => f.owner.closeWith(command()), /physical_outcome_not_held/); f.owner.dispose(); assert.equal(f.closes(), 1);
});
test("held omit settles actual EOF and refuses duplicate release", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = pipe("held"), finish = f.owner.finish(observations[2]);
  f.owner.closeWith(command("omit")); assert.deepEqual(await finish, { exitCode: 0, phase: "closed_missing" });
  assert.equal((await f.eof).length, 0); t.mock.timers.runAll(); assert.equal(f.closes(), 1);
  assert.throws(() => f.owner.closeWith(command()), /physical_outcome_not_held/);
});
test("fixed hold timeout closes actual pipe without positive bytes or late revival", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = pipe("held"), finish = f.owner.finish(observations[2]);
  t.mock.timers.tick(1000); assert.deepEqual(await finish, { exitCode: 0, phase: "closed_missing" }); assert.equal((await f.eof).length, 0);
  assert.deepEqual(f.states.at(-1), { mode: "held", phase: "closed_missing", cause: "hold_timeout" });
  assert.throws(() => f.owner.closeWith(command()), /physical_outcome_not_held/); f.owner.dispose(); t.mock.timers.runAll(); assert.equal(f.closes(), 1);
});
test("dispose before or during finish owns one missing-result EOF", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const before of [true, false]) {
    const f = pipe("held"); if (before) f.owner.dispose(); const finish = f.owner.finish(observations[2]); f.owner.dispose();
    assert.deepEqual(await finish, { exitCode: 0, phase: "closed_missing" }); assert.equal((await f.eof).length, 0);
    assert.throws(() => f.owner.closeWith(command()), /physical_outcome_not_held/); t.mock.timers.runAll(); assert.equal(f.closes(), 1);
  }
});
test("two held owners use separate immutable bindings and never release each other", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const other = { ...binding, bridgeSessionId: "other-session" };
  const f = pipe("held"), g = pipe("held", { binding: other }); const finish = f.owner.finish(observations[2]), second = g.owner.finish(observations[2]);
  const rejected = assert.rejects(finish, /invalid_physical_outcome_close/);
  assert.throws(() => f.owner.closeWith(command("emit", other)), /invalid_physical_outcome_close/); await rejected; assert.equal((await f.eof).length, 0);
  assert.equal(g.writes(), 0); assert.equal(g.ended(), false); g.owner.closeWith(command("emit", other)); await second; decode(await g.eof);
  t.mock.timers.runAll(); assert.equal(f.closes(), 1); assert.equal(g.closes(), 1);
});
test("control refuses before hold and malformed or each wrong-ID command closes held with no bytes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const fresh = pipe("held");
  assert.throws(() => fresh.owner.closeWith(command()), /physical_outcome_not_held/); fresh.owner.dispose(); await fresh.eof;
  for (const invalid of [null, [], { ...command(), extra: true }, { ...command(), schema: "wrong" }, command("cleanup"),
    { ...command(), binding: { ...binding, extra: true } }, ...Object.keys(binding).map(key => command("emit", { ...binding, [key]: "wrong" }))]) {
    const f = pipe("held"), finish = f.owner.finish(observations[2]), rejected = assert.rejects(finish, /invalid_physical_outcome_close/);
    assert.throws(() => f.owner.closeWith(invalid), /invalid_physical_outcome_close/); await rejected;
    f.owner.dispose(); assert.equal((await f.eof).length, 0); assert.equal(f.closes(), 1); assert.equal(f.writes(), 0);
  }
  t.mock.timers.runAll();
});
test("configured selector and binding are copied before callers can mutate them", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const input = { ...binding }, selected = { ...scenario("held") };
  const f = pipe("held", { binding: input, scenario: selected }); input.bridgeSessionId = "changed"; selected.mode = "missing";
  const finish = f.owner.finish(observations[2]); f.owner.closeWith(command()); await finish;
  assert.equal(sameCustodyBinding(decode(await f.eof), binding), true); assert.deepEqual(f.states[0], { mode: "held", phase: "held", binding });
});
test("narrow reader accepts a regular bounded command and refuses unsafe or malformed files", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-outcome-")), file = path.join(dir, "physical-outcome-close.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(readPhysicalOutcomeClose(file), null); fs.writeFileSync(file, JSON.stringify(command())); assert.deepEqual(readPhysicalOutcomeClose(file), command());
  for (const text of ["{", "x".repeat(16 * 1024 + 1), JSON.stringify({ ...command(), extra: true })]) {
    fs.writeFileSync(file, text); assert.throws(() => readPhysicalOutcomeClose(file), /physical_outcome_control_read_failed/);
  }
  fs.unlinkSync(file); fs.symlinkSync(path.join(dir, "missing"), file); assert.throws(() => readPhysicalOutcomeClose(file), /physical_outcome_control_read_failed/);
  fs.unlinkSync(file); fs.mkdirSync(file); assert.throws(() => readPhysicalOutcomeClose(file), /physical_outcome_control_read_failed/);
  fs.rmdirSync(file); fs.writeFileSync(file, JSON.stringify(command()));
  assert.throws(() => readPhysicalOutcomeClose(path.join(file, "child")), /physical_outcome_control_read_failed/);
});
test("reader bounds actual reads and refuses replacement identity and nonregular open races", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-outcome-race-")), file = path.join(dir, "physical-outcome-close.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); fs.writeFileSync(file, JSON.stringify(command()));
  const realOpen = fs.openSync; let flagsSeen = 0;
  const open = t.mock.method(fs, "openSync", (name: fs.PathLike, flags: number) => {
    flagsSeen = flags; fs.renameSync(file, path.join(dir, "original")); fs.writeFileSync(file, JSON.stringify(command())); return realOpen(name, flags);
  });
  assert.throws(() => readPhysicalOutcomeClose(file), /physical_outcome_control_read_failed/);
  assert.ok(flagsSeen & fs.constants.O_NONBLOCK); assert.ok(flagsSeen & fs.constants.O_NOFOLLOW); open.mock.restore();
  let reads = 0; const realRead = fs.readSync;
  const read = t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => { reads++; return realRead(...args); });
  const stat = t.mock.method(fs, "fstatSync", () => ({ isFile: () => false }));
  assert.throws(() => readPhysicalOutcomeClose(file), /physical_outcome_control_read_failed/); assert.equal(reads, 0);
  stat.mock.restore(); read.mock.restore();
  const denied = t.mock.method(fs, "openSync", () => { throw Object.assign(new Error("private path"), { code: "EACCES" }); });
  assert.throws(() => readPhysicalOutcomeClose(file), { message: "physical_outcome_control_read_failed" }); denied.mock.restore();
});
test("writer throw, short write and close throw reject without successful phase or duplicate close", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const fault of ["write", "short", "close"]) {
    let writes = 0, closes = 0; const stream = new PassThrough(); const eof = (async () => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); })();
    const states: Array<Record<string, unknown>> = [];
    const owner = createPhysicalOutcomeEmitter({ binding, scenario: scenario("held"), now: () => at,
      write: (bytes: Buffer) => { writes++; if (fault === "write") throw new Error("secret"); stream.write(fault === "short" ? bytes.subarray(0, 4) : bytes); return fault === "short" ? 4 : bytes.length; },
      close: () => { closes++; stream.end(); if (fault === "close") throw new Error("secret"); }, onState: (value: Record<string, unknown>) => states.push(value) });
    const finish = owner.finish(observations[2]), rejected = assert.rejects(finish, { message: "physical_outcome_io_failed" });
    owner.closeWith(command()); await rejected; await eof; owner.dispose(); t.mock.timers.runAll();
    assert.equal(writes, 1); assert.equal(closes, 1); assert.equal(states.some(value => value.phase === "emitted"), false);
    assert.throws(() => owner.closeWith(command()), /physical_outcome_not_held/);
  }
});
test("same capture stop→finish chain emits nothing until actual pending connection settles", async () => {
  let settle!: () => void; const connection = new Promise<void>(resolve => { settle = resolve; });
  const f = pipe(), events: unknown[] = [];
  const lifecycle = createCaptureLifecycle({ getMedia: () => null, fenceCapture: () => {}, getCaptureWork: () => Promise.resolve(),
    getConnectionWork: () => connection, emit: (event: unknown) => events.push(event) });
  const completion = (async () => { await lifecycle.stop(); return f.owner.finish(observations[2]); })();
  await Promise.resolve(); assert.equal(f.writes(), 0); assert.equal(f.ended(), false); assert.equal(events.length, 0);
  settle(); await completion; assert.equal(f.writes(), 1); decode(await f.eof); assert.equal(events.length, 1);
});
