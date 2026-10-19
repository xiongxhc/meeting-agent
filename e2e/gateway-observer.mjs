// A byte-preserving stdout tap in the private TEST launcher, never a Runtime replacement.
// It forwards the packaged child's actual control bytes and persists only safe event fields.
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { appendFileSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";
import { FrameDecoder } from "@conversation/runtime";
import { createExpiryEvidenceCollector } from "./expiry-evidence-collector.mjs";
import { LIFECYCLE_FILE, clientCommandRow, gatewayExitRow, gatewayMessageRow } from "./voice-end-evidence.mjs";

let argv = process.argv.slice(2), collector, child;
try {
  let descriptorPath;
  if (argv[0] === "--expiry-evidence-descriptor") {
    if (!argv[1] || argv[1].startsWith("--") || argv[2] !== "--") throw new Error();
    descriptorPath = argv[1]; argv = argv.slice(3);
  }
  const [gateway, keyPath, , , ...args] = argv;
  if (argv.length < 4 || argv.slice(0, 4).some(value => !value || value.startsWith("--"))) throw new Error();
  if (descriptorPath) collector = createExpiryEvidenceCollector(descriptorPath, { gatewayPath: gateway });
  const env = { ...process.env, E2E_RUNTIME_RECORDING_KEY: readFileSync(keyPath, "utf8").trim(), E2E_PROVIDER_CREDENTIAL: "e2e-synthetic-provider-credential-not-real" };
  // Ambient journal activation cannot opt an ordinary observer into evidence.
  delete env.RUNTIME_MEDIA_ADMISSION_EVIDENCE_PATH;
  child = collector ? collector.spawn(args, { cwd: process.cwd(), env }) : spawn(gateway, args, { cwd: process.cwd(), stdio: ["pipe", "pipe", "inherit"], env });
  if (collector) child.stderr.resume(); // Private failure path never echoes child diagnostics.
} catch {
  try { collector?.close(); } catch { /* static refusal below */ }
  process.stderr.write("gateway_observer_failed\n"); process.exit(70);
}
const [, , eventsPath, pidsPath] = argv;
const decoder = new FrameDecoder();
let failed = false, reapTimer, evidenceTimer;
// Voice-end lifecycle beside the voice events, opened once on first use. Best
// effort: a failure disables it once and never terminates or recodes the gateway.
const lifecyclePath = path.join(path.dirname(eventsPath), LIFECYCLE_FILE);
let lifecycleOpen = true, lifecycleFd = null;
function lifecycle(row) {
  if (!lifecycleOpen || failed) return;
  try {
    lifecycleFd ??= openSync(lifecyclePath, "a", 0o600);
    writeSync(lifecycleFd, `${JSON.stringify({ ...row, observerPid: process.pid, at: Date.now(), monotonicNs: process.hrtime.bigint().toString() })}\n`);
  } catch {
    lifecycleOpen = false;
    try { process.stderr.write("gateway_observer_lifecycle_unavailable\n"); } catch { /* diagnostics only; never fail the gateway */ }
  }
}
function terminate(failure) {
  if (failure && !failed) { failed = true; collector?.fail(); process.stderr.write("gateway_observer_failed\n"); }
  process.stdin.unpipe(child.stdin);
  child.stdin.end();
  child.kill("SIGTERM");
  reapTimer ??= setTimeout(() => child.kill("SIGKILL"), 2000);
}
// Sampling shares the owned child's lifespan, with no separate wait budget.
// The controller's reader also holds its own no-follow FD for release scheduling.
if (collector) evidenceTimer = setInterval(() => { try { collector.readTail(); } catch { terminate(true); } }, 10);
// Forward the original bytes before observation. The tap never re-encodes them.
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
// Client commands are observed after the pipe has forwarded the same chunk.
const clientDecoder = new FrameDecoder();
let clientObserved = true;
process.stdin.on("data", (chunk) => {
  if (!clientObserved) return;
  try { for (const bytes of clientDecoder.push(chunk)) lifecycle(clientCommandRow(JSON.parse(Buffer.from(bytes).toString("utf8")))); }
  catch { clientObserved = false; lifecycle({ event: "client_decode_failed" }); }
});
process.stdin.on("end", () => lifecycle({ event: "client_eof" }));
child.stdout.on("data", (chunk) => {
  if (failed) return;
  try {
  for (const bytes of decoder.push(chunk)) {
    const frame = JSON.parse(Buffer.from(bytes).toString("utf8"));
    const event = frame.type === "voice_event" ? frame.event : null;
    if (event !== null) {
      const detail = { type: event.type, at: Date.now(), monotonicNs: process.hrtime.bigint().toString() };
      for (const key of ["session_id", "segment_id", "turn_id", "generation_id", "reason", "activity", "milestone", "state"]) {
        if (event[key] !== undefined) detail[key] = event[key];
      }
      if (event.event) detail.event = { type: event.event.type, turn_id: event.event.turn_id };
      appendFileSync(eventsPath, `${JSON.stringify(detail)}\n`);
    }
    const row = gatewayMessageRow(frame);
    if (row !== null) lifecycle(row);
  }
  } catch { terminate(true); }
});
child.stdout.on("end", () => { lifecycle({ event: "gateway_stdout_end" }); try { decoder.finish(); } catch { terminate(true); } });
child.stdin.on("error", () => terminate(true));
process.stdout.on("error", () => terminate(true));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { lifecycle({ event: "observer_signal", signal }); terminate(false); });
child.on("error", () => terminate(true));
try { appendFileSync(pidsPath, `${child.pid}\n`); } catch { terminate(true); }
child.on("close", async (code, signal) => {
  lifecycle(gatewayExitRow(code, signal));
  clearTimeout(reapTimer);
  clearInterval(evidenceTimer);
  process.stdin.destroy();
  if (collector) {
    try {
      await collector.whenClosed();
      const result = collector.complete(); collector.close();
      if (!result.ok && !failed) { failed = true; process.stderr.write(`gateway_observer_failed\n${result.code}\n`); }
    } catch { if (!failed) { failed = true; process.stderr.write("gateway_observer_failed\n"); } }
  }
  process.exitCode = failed ? 70 : code ?? 70;
});
