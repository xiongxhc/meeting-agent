// Scripted real bridge child that speaks bridge-session/v2 on stdout for
// test/child-bridge-process.test.ts. It copies the launched config into the
// evidence root named by that config, then:
//   join:          emits joined, one ui_snapshot and command_result ok;
//   connect_media: answers truthfully -- it owns no media stack -- with
//                  command_result failed and no media_connected;
//   anything else: command_result rejected;
//   stdin EOF:     writes the private outcome on fd 3 (departure_unconfirmed
//                  after a join, no_join_action otherwise) and exits 0;
//   hung:          ignores SIGTERM and never exits cooperatively.
import { readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { setInterval } from "node:timers";

const configPath = process.argv[process.argv.indexOf("--config") + 1];
const bytes = readFileSync(configPath);
const config = JSON.parse(bytes.toString("utf8"));
if ((statSync(configPath).mode & 0o777) !== 0o600 || (statSync(path.dirname(configPath)).mode & 0o777) !== 0o700) process.exit(8);
if (["RUNTIME_SECRET", "FEISHU_APP_SECRET", "NODE_OPTIONS", "DYLD_TEST_CANARY"].some((key) => process.env[key] !== undefined)) process.exit(7);
if (config.evidenceRoot.includes("bridge-v2-")) {
  writeFileSync(path.join(config.evidenceRoot, "child.pid"), String(process.pid));
  writeFileSync(path.join(config.evidenceRoot, "child.config-path"), configPath);
  writeFileSync(path.join(config.evidenceRoot, "child.config.json"), bytes);
}
const binding = config.custody;
const sessionId = binding.bridgeSessionId;
const timing = { clockDomainId: "synthetic-clock", hostBeforeNs: "1000000000", hostAfterNs: "1000500000" };
let sequence = 0, joined = false;
function emit(payload) {
  sequence += 1;
  writeSync(1, JSON.stringify({ schema: "bridge-session/v2", sessionId, sequence, observedAt: "2026-09-02T14:01:00.000Z", ...payload }) + "\n");
}
function result(command, outcome, detail) { emit({ type: "command_result", commandId: command.commandId, outcome, detail }); }
if (config.bundleVersion === "hung") {
  process.on("SIGTERM", () => {});
  process.stdin.resume();
  setInterval(() => {}, 1000);
} else {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const command = JSON.parse(line);
    if (command.schema !== "bridge-session/v2" || command.sessionId !== sessionId) process.exit(9);
    if (command.type === "join") {
      joined = true;
      emit({ type: "joined", meetingOccurrenceId: command.meetingOccurrenceId, observationTiming: timing, observationTimingReason: null });
      emit({ type: "ui_snapshot", snapshotSequence: 1, observationTiming: timing, state: "unknown", feishuUserId: null, reason: "no_highlight", barrierBefore: "stream_start" });
      result(command, "ok", null);
    } else if (command.type === "connect_media") result(command, "failed", "synthetic bridge owns no media stack");
    else result(command, "rejected", "unsupported by the synthetic bridge");
  });
  lines.on("close", () => {
    const outcome = joined ? { outcome: "departure_unconfirmed", reason: "departure_not_observed" } : { outcome: "no_join_action", reason: "join_not_issued" };
    writeSync(3, JSON.stringify({ schema: "bridge-process-outcome/v1", ...binding, ...outcome, observedAt: "2026-09-02T14:01:00.000Z" }) + "\n");
  });
}
