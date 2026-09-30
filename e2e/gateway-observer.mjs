// A byte-preserving stdout tap in the private TEST launcher, never a Runtime replacement.
// It forwards the packaged child's actual control bytes and persists only safe event fields.
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { FrameDecoder } from "@conversation/runtime";

const [gateway, keyPath, eventsPath, pidsPath, ...args] = process.argv.slice(2);
const child = spawn(gateway, args, { cwd: process.cwd(), stdio: ["pipe", "pipe", "inherit"], env: {
  ...process.env, E2E_RUNTIME_RECORDING_KEY: readFileSync(keyPath, "utf8").trim(),
  E2E_PROVIDER_CREDENTIAL: "e2e-synthetic-provider-credential-not-real",
} });
const decoder = new FrameDecoder();
let failed = false, reapTimer;
function terminate(failure) {
  if (failure && !failed) { failed = true; process.stderr.write("gateway_observer_failed\n"); }
  process.stdin.unpipe(child.stdin);
  child.stdin.end();
  child.kill("SIGTERM");
  reapTimer ??= setTimeout(() => child.kill("SIGKILL"), 2000);
}
// Forward the original bytes before observation. The tap never re-encodes them.
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stdout.on("data", (chunk) => {
  if (failed) return;
  try {
  for (const bytes of decoder.push(chunk)) {
    const frame = JSON.parse(Buffer.from(bytes).toString("utf8"));
    const event = frame.type === "voice_event" ? frame.event : null;
    if (event !== null) {
      const detail = { type: event.type, at: Date.now() };
      for (const key of ["segment_id", "turn_id", "generation_id", "reason", "activity", "milestone", "state"]) {
        if (event[key] !== undefined) detail[key] = event[key];
      }
      if (event.event) detail.event = { type: event.event.type, turn_id: event.event.turn_id };
      appendFileSync(eventsPath, `${JSON.stringify(detail)}\n`);
    }
  }
  } catch { terminate(true); }
});
child.stdout.on("end", () => { try { decoder.finish(); } catch { terminate(true); } });
child.stdin.on("error", () => terminate(true));
process.stdout.on("error", () => terminate(true));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => terminate(false));
child.on("error", () => terminate(true));
try { appendFileSync(pidsPath, `${child.pid}\n`); } catch { terminate(true); }
child.on("close", (code) => {
  clearTimeout(reapTimer);
  process.stdin.destroy();
  process.exitCode = failed ? 70 : code ?? 70;
});
