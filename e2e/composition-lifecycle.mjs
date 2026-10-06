// Test-entry-only lifecycle: same public owner/options and close order as the
// shipped runner, with an exposed handle for repeated-close integration.
/* global AbortController */
import process from "node:process";

export async function closeRepeatedly(app) {
  const first = app.close(), second = app.close();
  const results = await Promise.allSettled([first, second]);
  const third = app.close();
  results.push(...await Promise.allSettled([third]));
  return {
    concurrentPromiseSame: first === second, settledPromiseSame: first === third,
    results: results.map((result) => result.status === "fulfilled" ? { status: result.status } : {
      status: result.status,
      reason: /^composition_close_failed:[a-z_,:]+$/.test(result.reason?.message ?? "") ? result.reason.message : "close_failed",
    }),
    outcomes: app.occurrenceOutcomes().map((outcome) => ({
      occurrenceId: outcome.occurrenceId, phase: outcome.phase,
      finalization: outcome.finalization, runtimeClose: outcome.runtimeClose,
      runtimeCleanup: outcome.runtimeCleanup, failure: outcome.failure,
      controlSessionId: outcome.controlSessionId?.toString() ?? null,
    })),
  };
}

export async function runExposedComposition(compose, config, owner, options, onHandle, controller = new AbortController()) {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const onSignal = () => controller.abort();
  for (const signal of signals) process.once(signal, onSignal);
  try {
    let app;
    try { app = await compose(config, owner, { ...options, shutdownSignal: controller.signal }); }
    catch (error) {
      const message = error instanceof Error ? error.message : "";
      return { status: "composition_unavailable", reason: /^[a-z_]+(:[A-Za-z]+)?$/.test(message) ? message : "composition_failed" };
    }
    onHandle(app);
    let clean = true;
    try {
      if (!controller.signal.aborted) {
        await app.start();
        await app.discover();
        await new Promise((resolve) => {
          if (controller.signal.aborted) resolve();
          else controller.signal.addEventListener("abort", resolve, { once: true });
        });
      }
    } catch { clean = false; }
    try { await app.close(); } catch { clean = false; }
    return { status: "composition_closed", clean };
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
  }
}
