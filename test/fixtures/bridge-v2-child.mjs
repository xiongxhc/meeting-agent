// Scripted real bridge child that speaks bridge-session/v2 on stdout for
// test/child-bridge-process.test.ts. It copies the launched config into the
// evidence root named by that config, then:
//   join:          emits joined, one ui_snapshot and command_result ok;
//   connect_media: answers truthfully -- it owns no media stack -- with
//                  command_result failed and no media_connected;
//   anything else: command_result rejected;
//   stdin EOF:     writes the private outcome on fd 3 (departure_unconfirmed
//                  after a join, no_join_action otherwise) and exits 0;
//   hung:          ignores SIGTERM and never exits cooperatively;
//   noisy:         around the join answer also writes one malformed line, one
//                  oversized line, one replayed sequence and 64 KiB of stderr;
//   garbage:       answers the join with nine malformed lines and stays up;
//   dense:         after the join answer, 17 malformed lines each followed by a
//                  valid one;
//   spread:        10 such pairs, a 400 ms pause, 10 more, then one valid line;
//   crash:         answers the join, then exits 3 without an outcome;
//   media:         reports connect_media as connected (owns no media stack).
import { readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { setInterval, setTimeout } from "node:timers";
import { Buffer } from "node:buffer";

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
  writeAll(1, JSON.stringify({ schema: "bridge-session/v2", sessionId, sequence, observedAt: "2026-09-02T14:01:00.000Z", ...payload }) + "\n");
}
// Pipes may be non-blocking: retry until every byte is written, in order.
function writeAll(fd, text) {
  const bytes = Buffer.from(text);
  for (let offset = 0; offset < bytes.length;) {
    try { offset += writeSync(fd, bytes, offset, Math.min(8192, bytes.length - offset)); }
    catch (error) { if (error.code !== "EAGAIN") throw error; }
  }
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
    if (command.type === "join" && config.bundleVersion === "garbage") {
      for (let index = 0; index < 9; index += 1) writeSync(1, "not-json\n");
    } else if (command.type === "join") {
      joined = true;
      const noisy = config.bundleVersion === "noisy";
      if (noisy) { writeAll(2, "x".repeat(65_536)); writeAll(1, "not-json\n"); }
      emit({ type: "joined", meetingOccurrenceId: command.meetingOccurrenceId, observationTiming: timing, observationTimingReason: null });
      if (noisy) {
        writeAll(1, "y".repeat(200_000) + "\n");
        writeSync(1, JSON.stringify({ schema: "bridge-session/v2", sessionId, sequence, observedAt: "2026-09-02T14:01:00.000Z", type: "chat_disclosure", outcome: "sent" }) + "\n");
      }
      emit({ type: "ui_snapshot", snapshotSequence: 1, observationTiming: timing, state: "unknown", feishuUserId: null, reason: "no_highlight", barrierBefore: "stream_start" });
      result(command, "ok", null);
      if (config.bundleVersion === "crash") process.exit(3);
      const pairs = (count) => { for (let index = 0; index < count; index += 1) { writeAll(1, "not-json\n"); emit({ type: "chat_disclosure", outcome: "sent" }); } };
      if (config.bundleVersion === "dense") pairs(17);
      if (config.bundleVersion === "spread") { pairs(10); setTimeout(() => { pairs(10); emit({ type: "chat_disclosure", outcome: "failed" }); }, 400); }
    } else if (command.type === "connect_media" && config.bundleVersion === "media") {
      // Stands in for a bridge whose media stack connected; no media is sent.
      emit({ type: "media_connected", endpoint: command.mediaLease.connectEndpoint });
      result(command, "ok", null);
    } else if (command.type === "connect_media") result(command, "failed", "synthetic bridge owns no media stack");
    else result(command, "rejected", "unsupported by the synthetic bridge");
  });
  lines.on("close", () => {
    const outcome = joined ? { outcome: "departure_unconfirmed", reason: "departure_not_observed" } : { outcome: "no_join_action", reason: "join_not_issued" };
    writeSync(3, JSON.stringify({ schema: "bridge-process-outcome/v1", ...binding, ...outcome, observedAt: "2026-09-02T14:01:00.000Z" }) + "\n");
  });
}
