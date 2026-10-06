import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error Test-only lifecycle helper has no public declaration.
import { closeRepeatedly, runExposedComposition } from "./composition-lifecycle.mjs";

test("test entry exposes one handle after admission and preserves start/discover/signal/close ownership", async () => {
  const calls: string[] = [];
  const config = {}, owner = {}, options = { marker: "same-options" };
  const controller = new AbortController();
  let count = 0;
  const app = {
    async start() { calls.push("start"); },
    async discover() { calls.push("discover"); controller.abort(); },
    close() { count += 1; calls.push("close"); return Promise.resolve(); },
  };
  const result = await runExposedComposition(async (actualConfig: unknown, actualOwner: unknown, actualOptions: { marker: string; shutdownSignal: AbortSignal }) => {
    assert.equal(actualConfig, config); assert.equal(actualOwner, owner);
    assert.equal(actualOptions.marker, options.marker);
    assert.equal(actualOptions.shutdownSignal, controller.signal);
    calls.push("compose"); return app;
  }, config, owner, options, (handle: unknown) => { assert.equal(handle, app); calls.push("expose"); }, controller);
  assert.deepEqual(calls, ["compose", "expose", "start", "discover", "close"]);
  assert.equal(count, 1);
  assert.deepEqual(result, { status: "composition_closed", clean: true });
});

test("repeated close records real shared rejection and settled outcomes without inventing successful custody", async () => {
  let closePromise: Promise<void> | null = null;
  const app = {
    close() { return closePromise ??= Promise.reject(new Error("composition_close_failed:application_close_failed")); },
    occurrenceOutcomes() { return [{ occurrenceId: "synthetic", phase: "settled", finalization: "recorded",
      runtimeClose: "closed", runtimeCleanup: "graceful", failure: null, controlSessionId: 42n, organizer: { privateField: "excluded" } }]; },
  };
  const result = await closeRepeatedly(app);
  assert.equal(result.concurrentPromiseSame, true);
  assert.equal(result.settledPromiseSame, true);
  assert.deepEqual(result.results, Array.from({ length: 3 }, () => ({ status: "rejected", reason: "composition_close_failed:application_close_failed" })));
  assert.deepEqual(result.outcomes, [{ occurrenceId: "synthetic", phase: "settled", finalization: "recorded",
    runtimeClose: "closed", runtimeCleanup: "graceful", failure: null, controlSessionId: "42" }]);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("failed start still awaits the actual close and reports unclean instead of fabricating success", async () => {
  let closed = false;
  const app = {
    async start() { throw new Error("start failed"); },
    async discover() { assert.fail("discovery after failed start"); },
    async close() { closed = true; throw new Error("close failed"); },
  };
  assert.deepEqual(await runExposedComposition(async () => app, {}, {}, {}, () => {}, new AbortController()),
    { status: "composition_closed", clean: false });
  assert.equal(closed, true);
});

test("test entry preserves shipped static compose refusals and hides arbitrary error text", async () => {
  const run = (message: string) => runExposedComposition(async () => { throw new Error(message); }, {}, {}, {},
    () => assert.fail("failed composition cannot expose a handle"), new AbortController());
  assert.deepEqual(await run("state_unavailable:Error"), { status: "composition_unavailable", reason: "state_unavailable:Error" });
  assert.deepEqual(await run("private path and credential"), { status: "composition_unavailable", reason: "composition_failed" });
});
