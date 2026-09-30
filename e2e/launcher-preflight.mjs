import { spawnSync } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";

export const LAUNCHER_PREFLIGHT_TIMEOUT_MS = 60_000;

/** Assess the actual private launcher before timed protocol startup. Runtime
 * rejects no arguments before loading config or starting providers/network.
 * spawnSync reaps this refusal; credentials remain owned by the launcher.
 * The setup budget is separate from every SDK/media/cleanup deadline. */
export function preflightLauncher(launcherPath, { env = {} } = {}) {
  const started = performance.now();
  const result = spawnSync(launcherPath, [], {
    cwd: path.dirname(launcherPath), env, shell: false,
    input: "", encoding: "utf8", maxBuffer: 64 * 1024,
    timeout: LAUNCHER_PREFLIGHT_TIMEOUT_MS, killSignal: "SIGKILL",
  });
  if (result.error || result.signal !== null || result.status !== 1 || result.stdout !== "") {
    // Never echo child diagnostics: a private launcher may include secrets.
    throw new Error("private Runtime launcher argument-refusal preflight failed");
  }
  return { command: "private Runtime launcher argument refusal (no arguments)", exit: result.status,
    durationMs: Math.round(performance.now() - started) };
}
