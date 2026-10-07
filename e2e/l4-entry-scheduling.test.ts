import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
// @ts-expect-error Private fixture module has no declarations.
import { compileL4Plan, createSubmittedFrameTracker, driveL4Capture, l4PlanHash } from "./l4-campaign.mjs";

const entryPath = new URL("./entry.mjs", import.meta.url);
const source = readFileSync(entryPath, "utf8"), ast = ts.createSourceFile("entry.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function declaration(name: string) {
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node && ts.isFunctionDeclaration(node)); return node;
}
const poller = declaration("waitFor").getText(ast).replace(/^export /, "");
function entryPrefix() {
  const owner = declaration("driveApplication"), statements: ts.Statement[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "drive") {
      assert.ok(node.initializer && ts.isCallExpression(node.initializer));
      let fn: ts.Expression = node.initializer.expression;
      if (ts.isParenthesizedExpression(fn)) fn = fn.expression;
      assert.ok(ts.isArrowFunction(fn) && ts.isBlock(fn.body));
      for (const statement of fn.body.statements) {
        if (ts.isIfStatement(statement) && statement.expression.getText(ast) === 'plan.d2Cut === "repeated-close"') break;
        statements.push(statement);
      }
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(owner); assert.ok(statements.length >= 10); return statements.map(node => node.getText(ast)).join("\n");
}
type Timer = { callback: () => void; cadenceNs: bigint; nextNs: bigint };
function virtualPoller(phaseNs = 0n, forcedCadenceMs?: number) {
  let host = 0n, id = 0, first = true;
  const timers = new Map<number, Timer>(), cadences: number[] = [];
  const context = vm.createContext({ Date: { now: () => Number(host / 1000000n) }, Promise,
    setInterval(callback: () => void, cadence: number) {
      cadences.push(cadence); const period = BigInt(forcedCadenceMs ?? cadence) * 1000000n;
      const next = host + period + (first ? phaseNs : 0n); first = false;
      timers.set(++id, { callback, cadenceNs: period, nextNs: next }); return id;
    }, clearInterval(token: number) { timers.delete(token); } });
  const waitFor = vm.runInContext(poller + "\nwaitFor", context) as (check: () => unknown, options: Record<string, unknown>) => Promise<unknown>;
  return { context, waitFor, cadences, host: () => host, jump: (value: bigint) => { host = value; },
    async settle<T>(pending: Promise<T>) {
      let done = false, result: T | undefined, failure: unknown;
      void pending.then(value => { done = true; result = value; }, error => { done = true; failure = error; });
      for (let step = 0; step < 10000 && !done; step++) {
        for (let i = 0; i < 12; i++) await Promise.resolve();
        if (done) break;
        assert.ok(timers.size, "pending operation must own a scheduled poll");
        const timer = [...timers.values()].sort((a, b) => Number(a.nextNs - b.nextNs))[0]!;
        host = timer.nextNs; timer.nextNs += timer.cadenceNs; timer.callback();
      }
      assert.ok(done, "bounded scheduler must settle"); if (failure) throw failure; return result as T;
    }, timers };
}
const origin = { hostNs: "0", wallMs: Date.parse("2026-10-06T12:00:00Z") };
function readiness(l4Case = "sent-conflict") {
  const plan = compileL4Plan(l4Case, origin), tracker = createSubmittedFrameTracker();
  tracker.connect("one"); tracker.update("one", { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 24000 } } } });
  const child = { joined: true, mediaConnected: true, framesSent: 0,
    l4: { case: l4Case, origin, planSha256: l4PlanHash(plan), bridgeSessionId: "bridge", disclosureCommandId: "chat" },
    observationPlan: { phase: "running", planned: plan.events.length, emitted: 6 } };
  return { tracker, child };
}
async function selectAtPhase(phaseNs: bigint, readyAtNs = 1480000000n, forceCadence?: number, budgetMs = 2000) {
  const clock = virtualPoller(phaseNs, forceCadence), f = readiness(); let selected = -1n, transcripts = 0;
  clock.jump(1400000000n);
  const provider = { get submitted() { return { ...f.tracker.snapshot(), ready: clock.host() >= readyAtNs }; }, transcript() { transcripts++; } };
  const pending = driveL4Capture({ l4Case: "sent-conflict", provider, child: () => f.child, runtimeEvents: () => [], nowHostNs: clock.host, budgetMs,
    waitFor(check: () => unknown, options: Record<string, unknown>) {
      if (options.name === "l4_submitted_window") { selected = clock.host(); throw new Error("test_selected_stop"); }
      return clock.waitFor(check, options);
    } });
  let failure = ""; try { await clock.settle(pending); } catch (error) { failure = (error as Error).message; }
  assert.equal(transcripts, 0); assert.equal(clock.timers.size, 0);
  return { selected, failure, cadences: clock.cadences };
}
test("real entry enters conflict readiness before the generic51-frame late threshold", async () => {
  const clock = virtualPoller(), f = readiness(), marks: Array<{ name: string; at: bigint }> = [];
  let entered = -1n;
  Object.assign(clock.context, { plan: { meeting: { eventId: "synthetic" }, l4Case: "sent-conflict", captureFrames: 51, budgets: { startMs: 2000, admitMs: 2000, captureMs: 6000 }, controlDir: "synthetic" },
    trace: ["composition_started"], peer: { connectionCount: 1, acknowledgements: [{ code: 200 }], deliverInvite() {} }, inviteEnvelope: () => ({}),
    event: (name: string) => marks.push({ name, at: clock.host() }), path: { join: () => "synthetic-state" },
    readJson: () => ({ ...f.child, framesSent: clock.host() >= 1647761917n ? 51 : 50 }), interactive: { get submitted() { return f.tracker.snapshot(); } },
    runtimeEvents: () => [], l4Drive: null, compositionHandle: null, driveInteractive: () => { throw new Error("unused"); },
    driveWaitFor: clock.waitFor,
    async driveL4Capture(input: Record<string, unknown>) {
      entered = clock.host();
      return driveL4Capture({ ...input, nowHostNs: clock.host, waitFor: (check: () => unknown, options: Record<string, unknown>) => {
        if (options.name === "l4_submitted_window") throw new Error("test_selected_stop");
        return clock.waitFor(check, options);
      } });
    } });
  const pending = vm.runInContext("(async () => {" + entryPrefix() + "})()", clock.context) as Promise<unknown>;
  await assert.rejects(clock.settle(pending), /test_selected_stop/);
  assert.ok(entered >= 0n && entered < 1480000000n); assert.ok(clock.host() >= 1480000000n && clock.host() <= 1500000000n);
  assert.equal(marks.some(row => row.name === "media_capture"), false);
});
test("actual25ms poll model has phases that miss the unchanged20ms window", async () => {
  let passed = 0, missed = 0;
  for (let phase = 0; phase < 25; phase++) {
    const row = await selectAtPhase(BigInt(phase) * 1000000n, 1480000000n, 25);
    if (row.failure === "test_selected_stop") passed++; else { assert.equal(row.failure, "l4_fixed_window_missed"); missed++; }
  }
  assert.equal(passed, 21); assert.equal(missed, 4);
});
test("campaign5ms readiness poll selects safely for every declared phase", async () => {
  let minimum = 2000000000n, maximum = 0n;
  for (let phase = 0; phase < 5000; phase++) {
    const row = await selectAtPhase(BigInt(phase) * 1000n);
    assert.equal(row.failure, "test_selected_stop"); assert.deepEqual(row.cadences, [5]);
    assert.ok(row.selected >= 1480000000n && row.selected <= 1500000000n);
    if (row.selected < minimum) minimum = row.selected; if (row.selected > maximum) maximum = row.selected;
  }
  assert.equal(minimum, 1480000000n); assert.equal(maximum, 1484999000n);
});
test("late readiness and overslept polls fail closed instead of moving the window", async () => {
  for (const ready of [1500000001n, 1600000000n]) {
    const row = await selectAtPhase(0n, ready); assert.equal(row.selected, -1n); assert.equal(row.failure, "l4_fixed_window_missed");
  }
  const missed = await selectAtPhase(101000000n); assert.equal(missed.selected, -1n); assert.equal(missed.failure, "l4_fixed_window_missed");
});
test("conflict deadline is checked before and after readiness predicates", async () => {
  for (const inCheck of [false, true]) {
    const clock = virtualPoller(); clock.jump(1400000000n); let calls = 0;
    const pending = clock.waitFor(() => { calls++; if (inCheck) clock.jump(1500000000n); return true; }, { budgetMs: inCheck ? 10 : 5, name: "deadline", pollMs: 5 });
    await assert.rejects(clock.settle(pending), /e2e_timeout:deadline/); assert.equal(calls, inCheck ? 1 : 0); assert.equal(clock.timers.size, 0);
  }
});
test("ordinary poller keeps25ms cadence and existing success-before-timeout behavior", async () => {
  const clock = virtualPoller(); let calls = 0;
  const pending = clock.waitFor(() => { calls++; return "original-success"; }, { budgetMs: 1, name: "ordinary" });
  assert.equal(await clock.settle(pending), "original-success"); assert.equal(calls, 1); assert.deepEqual(clock.cadences, [25]);
});
test("delayed readiness remains phase-bounded and exact upper boundary is fail closed", async () => {
  for (const readyAt of [1490000000n, 1495000000n]) for (let phase = 0; phase < 5000; phase++) {
    const row = await selectAtPhase(BigInt(phase) * 1000n, readyAt);
    assert.equal(row.failure, "test_selected_stop"); assert.ok(row.selected >= readyAt && row.selected <= 1500000000n);
  }
  const boundary = await selectAtPhase(0n, 1500000000n); assert.equal(boundary.selected, 1500000000n);
  for (const phase of [1n, 1000n, 4999000n]) {
    const row = await selectAtPhase(phase, 1500000000n); assert.equal(row.selected, -1n); assert.equal(row.failure, "l4_fixed_window_missed");
  }
});
test("bounded special polling refuses other cadences and invalid budgets before any effects", async () => {
  for (const options of [...[0, 1, 10, 50, NaN].map(pollMs => ({ pollMs, budgetMs: 100 })), ...[0, -1, NaN, Infinity].map(budgetMs => ({ pollMs: 5, budgetMs }))]) {
    const clock = virtualPoller(); let effects = 0;
    await assert.rejects(clock.waitFor(() => { effects++; return true; }, { ...options, name: "refused" }), /l4_poll_refused/);
    assert.equal(effects, 0); assert.equal(clock.timers.size, 0);
  }
});
test("special readiness cancellation clears its timer before a predicate effect", async () => {
  const clock = virtualPoller(), controller = new AbortController(); let effects = 0;
  const pending = clock.waitFor(() => { effects++; return true; }, { budgetMs: 100, name: "cancelled", pollMs: 5, signal: controller.signal });
  controller.abort(); await assert.rejects(clock.settle(pending), /l4_drive_cancelled/); assert.equal(effects, 0); assert.equal(clock.timers.size, 0);
});
test("real entry ordinary branch retains the capture prewait and interactive ordering", async () => {
  for (const interactive of [false, true]) {
    const clock = virtualPoller(), names: string[] = [];
    Object.assign(clock.context, { plan: { meeting: { eventId: "synthetic" }, captureFrames: 51, budgets: { startMs: 100, admitMs: 100, captureMs: 2000 }, controlDir: "synthetic" },
      trace: ["composition_started"], peer: { connectionCount: 1, acknowledgements: [{ code: 200 }], deliverInvite() {} }, inviteEnvelope: () => ({}),
      event: (name: string) => names.push(name), path: { join: () => "synthetic-state" }, readJson: () => ({ mediaConnected: true, framesSent: clock.host() >= 1647761917n ? 51 : 50 }),
      interactive: interactive ? {} : null, compositionHandle: null, runtimeEvents: () => [], l4Drive: null, driveWaitFor: clock.waitFor,
      driveL4Capture: () => { throw new Error("ordinary branch must not enter L4"); }, driveInteractive: () => names.push("interactive") });
    await clock.settle(vm.runInContext("(async () => {" + entryPrefix() + "})()", clock.context) as Promise<void>);
    assert.deepEqual(names, ["long_connection_ready", "invite_delivered", "invite_acknowledged", "media_capture", ...(interactive ? ["interactive"] : [])]);
    assert.equal(clock.host(), 1650000000n); assert.ok(clock.cadences.every(value => value === 25));
  }
});
test("full actual conflict driver keeps future tracking,25ms downstream waits and complete UI drain", async () => {
  const clock = virtualPoller(), f = readiness(), events: Array<Record<string, string>> = [];
  let selected = -1n, startFrame = 0, endFrame = 0, transmitted = 0;
  const plan = compileL4Plan("sent-conflict", origin), audio = Buffer.alloc(960).toString("base64");
  const provider = { get submitted() {
    const target = Number(clock.host() / 20000000n);
    while (f.tracker.snapshot().appended < target) f.tracker.append("one", audio);
    return f.tracker.snapshot();
  }, transcript(_text: string, range: { startFrame: number; endFrame: number }) {
    transmitted++; assert.ok(f.tracker.snapshot().appended >= range.endFrame); startFrame = range.startFrame; endFrame = range.endFrame;
    events.push({ type: "voice_transcript_final", segment_id: "1", session_id: "41" }, { type: "response_skipped", segment_id: "1", session_id: "41" });
  } };
  const result = await clock.settle<{ range: { startFrame: number; endFrame: number }; rawRows: number }>(driveL4Capture({ l4Case: "sent-conflict", provider, runtimeEvents: () => events, nowHostNs: clock.host, budgetMs: 6000,
    child() { const emitted = plan.events.filter((row: { emitAtHostNs: string }) => BigInt(row.emitAtHostNs) <= clock.host()).length;
      return { ...f.child, observationPlan: { ...f.child.observationPlan, emitted, phase: emitted === 64 ? "completed" : "running" } }; },
    waitFor(check: () => unknown, options: Record<string, unknown>) {
      if (options.name === "l4_submitted_window") selected = clock.host();
      return clock.waitFor(check, options);
    } }));
  assert.equal(selected, 1480000000n); assert.equal(transmitted, 1); assert.equal(endFrame - startFrame + 1, 50);
  assert.equal(startFrame, 75); assert.equal(result.range.startFrame, startFrame); assert.equal(result.range.endFrame, endFrame); assert.equal(result.rawRows, 64);
  assert.equal(clock.cadences[0], 5); assert.ok(clock.cadences.slice(1).every(value => value === 25));
  assert.ok(clock.host() >= 4900000000n); assert.equal(clock.timers.size, 0);
});
test("real entry keeps its generic capture assertion after an early L4 campaign", async () => {
  for (const captures of [50, 51]) {
    const clock = virtualPoller(), f = readiness(), names: string[] = []; let entered = 0;
    Object.assign(clock.context, { plan: { meeting: { eventId: "synthetic" }, l4Case: "sent-conflict", captureFrames: 51, budgets: { startMs: 100, admitMs: 100, captureMs: 100 }, controlDir: "synthetic" },
      trace: ["composition_started"], peer: { connectionCount: 1, acknowledgements: [{ code: 200 }], deliverInvite() {} }, inviteEnvelope: () => ({}),
      event: (name: string) => names.push(name), path: { join: () => "synthetic-state" }, readJson: () => ({ ...f.child, framesSent: captures }),
      interactive: {}, compositionHandle: null, runtimeEvents: () => [], l4Drive: null, driveWaitFor: clock.waitFor,
      async driveL4Capture() { entered++; return { case: "sent-conflict", rawRows: 64 }; } });
    const pending = vm.runInContext("(async () => {" + entryPrefix() + "})()", clock.context) as Promise<void>;
    if (captures === 50) { await assert.rejects(clock.settle(pending), /e2e_timeout:media_capture/); assert.equal(names.includes("media_capture"), false); }
    else { await clock.settle(pending); assert.deepEqual(names.slice(-2), ["media_capture", "l4_capture_recognized"]); }
    assert.equal(entered, 1);
  }
});

for (const l4Case of ["sent-named", "unavailable-missing", "sent-drop"]) {
  for (const reachesThreshold of [false, true]) {
    test(`real entry original ${l4Case} capture ${reachesThreshold ? "51" : "50"} precedes exactly one driver`, async () => {
      const clock = virtualPoller(), f = readiness(l4Case), names: string[] = [];
      const audio = Buffer.alloc(960).toString("base64");
      for (let frame = 0; frame < 48; frame++) f.tracker.append("one", audio);
      assert.equal(f.tracker.snapshot().ready, true);
      assert.equal(f.tracker.snapshot().appended, 48);
      let entered = 0;
      const captureCount = () => reachesThreshold && clock.host() >= 1600000000n ? 51 : 50;
      Object.assign(clock.context, { plan: { meeting: { eventId: "synthetic" }, l4Case, captureFrames: 51,
        budgets: { startMs: 100, admitMs: 100, captureMs: 2000 }, controlDir: "synthetic" },
        trace: ["composition_started"], peer: { connectionCount: 1, acknowledgements: [{ code: 200 }], deliverInvite() {} }, inviteEnvelope: () => ({}),
        event: (name: string) => names.push(name), path: { join: () => "synthetic-state" }, readJson: () => ({ ...f.child, framesSent: captureCount() }),
        interactive: { get submitted() { return f.tracker.snapshot(); } }, compositionHandle: null, runtimeEvents: () => [], l4Drive: null, driveWaitFor: clock.waitFor,
        async driveL4Capture() {
          entered++;
          assert.equal(captureCount(), 51, "original cases must finish capture prewait before driver entry");
          assert.equal(names.at(-1), "media_capture", "capture event must precede original driver");
          names.push("driver"); return { case: l4Case, rawRows: compileL4Plan(l4Case, origin).events.length };
        } });
      const pending = vm.runInContext("(async () => {" + entryPrefix() + "})()", clock.context) as Promise<void>;
      if (reachesThreshold) {
        await clock.settle(pending);
        assert.equal(entered, 1);
        assert.deepEqual(names.slice(-3), ["media_capture", "driver", "l4_capture_recognized"]);
        assert.equal(names.filter(name => name === "media_capture").length, 1);
        assert.equal(names.filter(name => name === "l4_capture_recognized").length, 1);
        assert.equal(clock.host(), 1600000000n);
      } else {
        await assert.rejects(clock.settle(pending), /e2e_timeout:media_capture/);
        assert.equal(entered, 0, "provider readiness cannot bypass captured-frame threshold");
        assert.equal(names.includes("media_capture"), false);
        assert.equal(names.includes("l4_capture_recognized"), false);
      }
      assert.ok(clock.cadences.every(value => value === 25));
      assert.equal(clock.timers.size, 0);
    });
  }
}
