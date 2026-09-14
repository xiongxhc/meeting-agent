import { readFileSync, writeSync, statSync, writeFileSync } from "node:fs";
import process from "node:process";
import { setInterval } from "node:timers";
import { Buffer } from "node:buffer";
import path from "node:path";
const config = JSON.parse(readFileSync(process.argv[process.argv.indexOf("--config") + 1], "utf8"));
const configPath = process.argv[process.argv.indexOf("--config") + 1];
if ((statSync(configPath).mode & 0o777) !== 0o600 || (statSync(path.dirname(configPath)).mode & 0o777) !== 0o700) process.exit(8);
if (config.evidenceRoot.includes("custody-")) {
  writeFileSync(path.join(config.evidenceRoot, "child.pid"), String(process.pid));
  writeFileSync(path.join(config.evidenceRoot, "child.config-path"), configPath);
}
const mode = config.bundleVersion;
const binding = config.custody;
const outcome = { schema: "bridge-process-outcome/v1", ...binding, outcome: "no_join_action", reason: "join_not_issued", observedAt: "2026-09-02T14:01:00.000Z" };
if (mode === "confirmed-exit2") { outcome.outcome = "departure_confirmed"; outcome.reason = "departure_observed"; }
if (mode === "unconfirmed-exit2") { outcome.outcome = "departure_unconfirmed"; outcome.reason = "departure_not_observed"; }
if (mode === "environment") {
  if (["RUNTIME_SECRET", "FEISHU_APP_SECRET", "NODE_OPTIONS", "DYLD_TEST_CANARY"].some((key) => process.env[key] !== undefined)) process.exit(7);
}
if (mode === "forced-exit2") {
  writeSync(3, JSON.stringify(outcome) + "\n");
  process.on("SIGTERM", () => process.exit(2)); setInterval(() => {}, 1000);
}
else if (mode === "hung" || mode === "early-outcome") {
  if (mode === "early-outcome") writeSync(3, JSON.stringify(outcome) + "\n");
  process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);
}
else if (mode === "flood") { setInterval(() => process.stdout.write("x".repeat(8192)), 1); }
else if (mode === "exit") process.exit(0);
else {
  process.stdin.resume();
  process.stdin.on("end", () => {
    let line = JSON.stringify(mode === "wrong" || mode === "wrong-exit2" ? { ...outcome, bridgeSessionId: "wrong" } : outcome) + "\n";
    if (mode === "malformed-exit2") line = "not-json\n";
    if (mode === "protocol-exit2") writeSync(1, "not-json\n");
    if (mode === "oversized") line = "x".repeat(4097);
    if (mode === "duplicate") line += line;
    if (mode === "duplicate-key") line = line.replace('"outcome":', '"outcome":"departure_unconfirmed","outcome":');
    if (mode === "conflicting") line += JSON.stringify({ ...outcome, outcome: "departure_unconfirmed", reason: "cleanup_failed" }) + "\n";
    if (mode === "truncated") line = line.slice(0, -1);
    if (mode === "fragmented") { for (const byte of Buffer.from(line)) writeSync(3, Buffer.from([byte])); }
    else writeSync(3, line);
    if (mode === "signal-outcome") process.kill(process.pid, "SIGTERM");
    if (mode === "failed-outcome" || mode.endsWith("-exit2")) process.exitCode = 2;
  });
}
