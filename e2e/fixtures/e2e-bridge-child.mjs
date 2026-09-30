// The scripted physical client for the built end-to-end spine. It is a real
// child process launched by the SHIPPED `createChildBridgeSlot` adapter over
// the accepted bridge-session/v2 wire, and it is the only peer here that owns
// a media stack: on `connect_media` it opens the gateway's authenticated media
// listener and streams silent 20 ms pcm_s16le/24000/1 frames with
// capture-clock/v1 provenance, which is what makes the recorder produce a real
// encrypted recording.
//
// The harness drives it through two files inside its own evidence root:
//   `<control>/end`   -- written by the harness: emit `left` with this reason;
//   `<control>/state.json` -- written here: what the child actually observed.
// It never fabricates a transcript, a speaker or a UI identity.

import { clearInterval, setInterval, setTimeout } from "node:timers";
import { mkdirSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";

import { connectMediaClient } from "../media-client.mjs";

const configPath = process.argv[process.argv.indexOf("--config") + 1];
const config = JSON.parse(readFileSync(configPath, "utf8"));
if ((statSync(configPath).mode & 0o777) !== 0o600) process.exit(8);
for (const leaked of ["RUNTIME_SECRET", "FEISHU_APP_SECRET", "E2E_RUNTIME_RECORDING_KEY", "E2E_RECORDING_KEY", "E2E_PROVIDER_CREDENTIAL", "NODE_OPTIONS"]) {
  if (process.env[leaked] !== undefined) process.exit(7);
}

const control = config.controlDir;
mkdirSync(control, { recursive: true, mode: 0o700 });
const binding = config.custody;
const sessionId = binding.bridgeSessionId;
const state = {
  pid: process.pid, configPath, envKeys: Object.keys(process.env).sort(),
  joined: false, mediaConnected: false, framesSent: 0, mediaEndpoint: null,
  mediaClosedReason: null, left: null, commands: [], playback: [], flushes: [], disclosure: null,
};
const FRAME_MS = 20;
const CLOCK_PAIR_EVERY = 50; // one second at 20 ms frames

let sequence = 0;
function emit(payload) {
  sequence += 1;
  writeSync(1, `${JSON.stringify({ schema: "bridge-session/v2", sessionId, sequence, observedAt: new Date().toISOString(), ...payload })}\n`);
}
function result(command, outcome, detail) {
  emit({ type: "command_result", commandId: command.commandId, outcome, detail });
}
function persist() {
  writeFileSync(path.join(control, "state.json"), JSON.stringify(state));
}
const timing = () => {
  const before = process.hrtime.bigint();
  return { clockDomainId: "e2e-clock", hostBeforeNs: before.toString(), hostAfterNs: (before + 1000n).toString() };
};

let media = null;
let capture = null;
let snapshotSequence = 0;

async function streamSilence() {
  let pair = 1;
  const limit = config.captureFrameLimit ?? Number.POSITIVE_INFINITY;
  for (;;) {
    if (media === null || state.framesSent >= limit) return;
    try {
      let voiced = false;
      try { readFileSync(path.join(control, "barge")); voiced = true; } catch { /* silent baseline */ }
      const number = await media.sendSilentFrame(480, 24_000, voiced);
      state.framesSent = number;
      if (number % CLOCK_PAIR_EVERY === 0) { pair += 1; await media.sendClockPair({ sequence: pair }); }
    } catch (error) {
      state.mediaClosedReason = String(error?.message ?? error);
      persist();
      return;
    }
    persist();
    await new Promise((resolve) => setTimeout(resolve, FRAME_MS));
  }
}

/** The harness's scripted meeting end; never inferred from the media socket. */
function watchForEnd() {
  const endPath = path.join(control, "end");
  const timer = setInterval(() => {
    let reason;
    try { reason = readFileSync(endPath, "utf8").trim(); } catch { return; }
    if (!["ended", "removed", "bridge_failure"].includes(reason)) return;
    clearInterval(timer);
    state.left = reason;
    for (const participant of config.participants ?? []) {
      emit({ type: "participant_left", feishuUserId: participant.feishuUserId, observationTiming: timing(), observationTimingReason: null });
    }
    persist();
    emit({ type: "left", reason, observationTiming: timing(), observationTimingReason: null });
  }, 25);
  timer.unref?.();
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  void (async () => {
    const command = JSON.parse(line);
    state.commands.push(command.type);
    if (command.schema !== "bridge-session/v2" || command.sessionId !== sessionId) process.exit(9);
    if (command.type === "join") {
      state.joined = true;
      emit({ type: "joined", meetingOccurrenceId: command.meetingOccurrenceId, observationTiming: timing(), observationTimingReason: null });
      snapshotSequence += 1;
      emit({ type: "ui_snapshot", snapshotSequence, observationTiming: timing(), state: "unknown",
        feishuUserId: null, reason: "no_highlight", barrierBefore: "stream_start" });
      for (const participant of config.participants ?? []) {
        emit({ type: "participant_joined", feishuUserId: participant.feishuUserId, displayName: participant.displayName,
          observationTiming: timing(), observationTimingReason: null });
      }
      result(command, "ok", null);
      persist();
      watchForEnd();
      return;
    }
    if (command.type === "connect_media") {
      const lease = command.mediaLease;
      state.mediaEndpoint = lease.connectEndpoint;
      try {
        media = await connectMediaClient({
          endpoint: lease.connectEndpoint, credential: lease.credential,
          sessionId: BigInt(lease.sessionId), bridgeSessionId: lease.bridgeSessionId,
          holdPlayback: () => { try { readFileSync(path.join(control, "hold-playback")); return true; } catch { return false; } },
          onPlayback: (detail) => { state.playback.push(detail); persist(); },
          onFlush: (detail) => { state.flushes.push(detail); persist(); },
        });
        await media.sendEpoch();
        await media.sendClockPair();
      } catch (error) {
        state.mediaClosedReason = String(error?.message ?? error);
        persist();
        result(command, "failed", "media listener unavailable");
        return;
      }
      state.mediaConnected = true;
      persist();
      emit({ type: "media_connected", endpoint: lease.connectEndpoint });
      result(command, "ok", null);
      capture = streamSilence();
      return;
    }
    if (command.type === "post_disclosure") {
      state.disclosure = "failed";
      emit({ type: "chat_disclosure", outcome: "failed" });
      result(command, "failed", "synthetic disclosure failure");
      persist();
      return;
    }
    result(command, "rejected", "unsupported by the scripted client");
    persist();
  })().catch(() => process.exit(10));
});

lines.on("close", () => {
  void (async () => {
    const socket = media;
    media = null;
    await capture?.catch(() => undefined);
    await socket?.close().catch(() => undefined);
    persist();
    const outcome = state.left !== null
      ? { outcome: "departure_confirmed", reason: "departure_observed" }
      : state.joined ? { outcome: "departure_unconfirmed", reason: "departure_not_observed" }
        : { outcome: "no_join_action", reason: "join_not_issued" };
    writeSync(3, `${JSON.stringify({ schema: "bridge-process-outcome/v1", ...binding, ...outcome, observedAt: new Date().toISOString() })}\n`);
  })().catch(() => process.exit(11));
});
