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

import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";
import { closeSync, mkdirSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";

import { connectMediaClient, parseCaptureMediaTiming } from "../media-client.mjs";
import { createCaptureLifecycle } from "./scripted-capture-lifecycle.mjs";
import { createPhysicalOutcomeEmitter, parsePhysicalOutcomeScenario, readPhysicalOutcomeClose } from "./bridge-scenarios.mjs";
import { createBridgeEventEmitter, createBridgeObservationOwner } from "./bridge-observations.mjs";

import { compileL4Plan, l4Configuration, l4PlanHash } from "../l4-campaign.mjs";

const configPath = process.argv[process.argv.indexOf("--config") + 1];
const config = JSON.parse(readFileSync(configPath, "utf8"));
if ((statSync(configPath).mode & 0o777) !== 0o600) process.exit(8);
for (const leaked of ["RUNTIME_SECRET", "FEISHU_APP_SECRET", "E2E_RUNTIME_RECORDING_KEY", "E2E_RECORDING_KEY", "E2E_PROVIDER_CREDENTIAL", "NODE_OPTIONS"]) {
  if (process.env[leaked] !== undefined) process.exit(7);
}

l4Configuration({ ...config, interactive: true });
const l4Origin = config.l4Case === undefined ? null : { hostNs: process.hrtime.bigint().toString(), wallMs: Date.now() };
if (l4Origin) config.observationPlan = compileL4Plan(config.l4Case, l4Origin);

const mediaTiming = parseCaptureMediaTiming(config);
const control = config.controlDir;
const binding = config.custody;
const physicalOutcomeScenario = parsePhysicalOutcomeScenario(config.physicalOutcomeScenario);
const sessionId = binding.bridgeSessionId;
const state = {
  ...(l4Origin ? { l4: { case: config.l4Case, origin: l4Origin, bridgeSessionId: sessionId, planSha256: l4PlanHash(config.observationPlan) } } : {}),
  pid: process.pid, configPath, envKeys: Object.keys(process.env).sort(),
  mediaTiming, mediaTimingTargetSequence: mediaTiming === "invalid2ns" ? "26" : null,
  joined: false, mediaConnected: false, framesSent: 0, mediaEndpoint: null,
  mediaClosedReason: null, left: null, endObservation: null, captureDrain: null, captureFinish: null, commands: [], playback: [], flushes: [], disclosure: null,
  capturePosition: { captureEpoch: "1", sequence: "0", outputEndSample: "0" }, renderCallbacks: [], renderReleases: [],
};
const FRAME_MS = 20;
const CLOCK_PAIR_EVERY = 50; // one second at 20 ms frames

const emit = createBridgeEventEmitter({ sessionId, write: bytes => writeSync(1, bytes) });
// Built staging includes dist/e2e, never src. An enabled plan must use the
// shipped codec and pass complete admission before control/state/timer effects.
let observations = null;
if (config.observationPlan !== undefined) {
  try {
    const { parseEventV2 } = await import("../../dist/src/contracts/bridge-session-v2.js");
    observations = createBridgeObservationOwner({ plan: config.observationPlan, binding,
      participants: config.participants, parseEvent: parseEventV2, emit,
      onState: summary => { state.observationPlan = summary; persist(); } });
  } catch { throw new Error("invalid_bridge_observation_plan"); }
}
mkdirSync(control, { recursive: true, mode: 0o700 });
function result(command, outcome, detail) {
  emit({ type: "command_result", commandId: command.commandId, outcome, detail });
}
function persist() {
  writeFileSync(path.join(control, "state.json"), JSON.stringify(state));
}
let physicalOutcomeTimer = null;
const physicalOutcome = createPhysicalOutcomeEmitter({ binding, scenario: physicalOutcomeScenario,
  write: bytes => writeSync(3, bytes), close: () => closeSync(3),
  onState: observation => {
    if (observation.phase !== "held" && physicalOutcomeTimer !== null) {
      clearInterval(physicalOutcomeTimer); physicalOutcomeTimer = null;
    }
    state.physicalOutcomeScenario = observation;
    persist();
    if (observation.phase !== "held") return;
    physicalOutcomeTimer = setInterval(() => {
      try {
        const command = readPhysicalOutcomeClose(path.join(control, "physical-outcome-close.json"));
        if (command !== null) physicalOutcome.closeWith(command);
      } catch {
        observations?.dispose();
        physicalOutcome.dispose();
        state.physicalOutcomeScenario = { mode: physicalOutcomeScenario.mode, phase: "failed", cause: "control_failure" };
        persist();
        process.exitCode = 11;
      }
    }, 25);
  },
});
const timing = () => {
  const before = process.hrtime.bigint();
  return { clockDomainId: "e2e-clock", hostBeforeNs: before.toString(), hostAfterNs: process.hrtime.bigint().toString() };
};

let media = null;
let capture = null, connectionWork = Promise.resolve();
const connectionAbort = new globalThis.AbortController();
let captureRunning = true, captureTimer = null, wakeCapture = null;
let snapshotSequence = 0, endTimer = null;

async function streamSilence() {
  const limit = config.captureFrameLimit ?? Number.POSITIVE_INFINITY;
  for (;;) {
    if (!captureRunning || media === null || state.framesSent >= limit) return;
    try {
      let voiced = false;
      try { readFileSync(path.join(control, "barge")); voiced = true; } catch { /* silent baseline */ }
      const number = await media.sendSilentFrame(480, 24_000, voiced);
      state.framesSent = number;
      state.capturePosition = media.capturePosition;
      if (captureRunning && number % CLOCK_PAIR_EVERY === 0) await media.sendClockPair();
    } catch (error) {
      state.mediaClosedReason = mediaTiming === "omit-final-pair-long" ? media?.closedReason ?? "long_tail_capture_failed" : String(error?.message ?? error);
      persist();
      return;
    }
    persist();
    if (!captureRunning) return;
    await new Promise((resolve) => {
      wakeCapture = resolve;
      captureTimer = setTimeout(() => { captureTimer = null; wakeCapture = null; resolve(); }, FRAME_MS);
    });
  }
}

const renderRequestsSeen = new Set();
const renderTimer = setInterval(() => {
  let requests;
  try { requests = JSON.parse(readFileSync(path.join(control, "render-callbacks.json"), "utf8")); } catch { return; }
  for (const request of requests) {
    if (media === null || renderRequestsSeen.has(request.id)) continue;
    renderRequestsSeen.add(request.id);
    void media.releaseRendered(request.sequence, request.generation).then((detail) => {
      state.renderReleases.push({ requestId: request.id, ...detail }); persist();
    }, (error) => { state.mediaClosedReason = String(error?.message ?? error); persist(); });
  }
}, 25);
renderTimer.unref?.();

const captureLifecycle = createCaptureLifecycle({
  getMedia: () => media, getCaptureWork: () => capture ?? Promise.resolve(),
  getConnectionWork: () => connectionWork,
  abortConnection: () => { if (media === null) connectionAbort.abort(); },
  participants: observations === null ? config.participants ?? [] : [], emit,
  fenceCapture: () => {
    observations?.dispose();
    captureRunning = false;
    clearInterval(renderTimer);
    if (endTimer !== null) clearInterval(endTimer);
    endTimer = null;
    if (captureTimer !== null) clearTimeout(captureTimer);
    captureTimer = null; wakeCapture?.(); wakeCapture = null;
  },
  onOutcome: ({ captureDrain, captureFinish }) => {
    state.captureDrain = captureDrain; state.captureFinish = captureFinish;
    state.mediaClosedReason = media?.closedReason ?? state.mediaClosedReason; persist();
  },
});

/** The harness's scripted meeting end; never inferred from the media socket. */
function watchForEnd() {
  const endPath = path.join(control, "end");
  endTimer = setInterval(() => {
    let reason;
    try { reason = readFileSync(endPath, "utf8").trim(); } catch { return; }
    if (!["ended", "removed", "bridge_failure"].includes(reason)) return;
    clearInterval(endTimer); endTimer = null;
    const before = process.hrtime.bigint(), observedAt = new Date().toISOString(), after = process.hrtime.bigint();
    const observation = { reason, observedAt, observationTiming: { clockDomainId: "e2e-clock",
      hostBeforeNs: before.toString(), hostAfterNs: after.toString() }, observationTimingReason: null };
    state.left = reason; state.endObservation = observation; persist();
    void captureLifecycle.observeEnd(observation).catch(() => { observations?.dispose(); physicalOutcome.dispose(); process.exit(11); });
  }, 25);
  endTimer.unref?.();
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  void (async () => {
    const command = JSON.parse(line);
    state.commands.push(command.type);
    if (command.schema !== "bridge-session/v2" || command.sessionId !== sessionId) { observations?.dispose(); physicalOutcome.dispose(); process.exit(9); }
    if (command.type === "join") {
      const joinTiming = timing();
      observations?.prepareJoin(joinTiming);
      state.joined = true;
      emit({ type: "joined", meetingOccurrenceId: command.meetingOccurrenceId, observationTiming: joinTiming, observationTimingReason: null });
      if (observations === null) {
        snapshotSequence += 1;
        emit({ type: "ui_snapshot", snapshotSequence, observationTiming: timing(), state: "unknown",
          feishuUserId: null, reason: "no_highlight", barrierBefore: "stream_start" });
        for (const participant of config.participants ?? []) {
          emit({ type: "participant_joined", feishuUserId: participant.feishuUserId, displayName: participant.displayName,
            observationTiming: timing(), observationTimingReason: null });
        }
      }
      result(command, "ok", null);
      persist();
      watchForEnd();
      if (observations !== null) void observations.start().catch(() => { observations.dispose(); physicalOutcome.dispose(); process.exit(10); });
      return;
    }
    if (command.type === "connect_media") {
      const lease = command.mediaLease;
      state.mediaEndpoint = lease.connectEndpoint;
      try {
        if (captureLifecycle.stopping || lease.mediaProtocolVersion !== 3 || lease.timingContract !== "capture-clock/v1" ||
          lease.captureFormat !== "pcm_s16le/24000/1/20ms" || lease.bridgeSessionId !== sessionId) throw new Error("drainable timed media lease required");
        connectionWork = connectMediaClient({
          mediaTiming, endpoint: lease.connectEndpoint, credential: lease.credential,
          sessionId: BigInt(lease.sessionId), bridgeSessionId: lease.bridgeSessionId,
          authTimeoutMs: Math.min(20000, Number(BigInt(lease.expiresAtMs) - BigInt(Date.now()))), signal: connectionAbort.signal,
          holdPlayback: () => { try { readFileSync(path.join(control, "hold-playback")); return true; } catch { return false; } },
          onPlayback: (detail) => { state.playback.push(detail); persist(); },
          onFlush: (detail) => { state.flushes.push(detail); persist(); },
          onRenderCallback: (detail) => { state.renderCallbacks.push(detail); persist(); },
        });
        const connected = await connectionWork;
        if (captureLifecycle.stopping) throw new Error("capture admission closed");
        media = connected;
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
      if (state.l4) state.l4.disclosureCommandId = command.commandId;
      if (observations === null) {
        state.disclosure = "failed";
        emit({ type: "chat_disclosure", outcome: "failed" });
        result(command, "failed", "synthetic disclosure failure");
      } else state.disclosure = observations.postDisclosure(command.commandId);
      persist();
      return;
    }
    result(command, "rejected", "unsupported by the scripted client");
    persist();
  })().catch(() => { observations?.dispose(); physicalOutcome.dispose(); process.exit(10); });
});

lines.on("close", () => {
  observations?.dispose();
  void (async () => {
    try {
      await captureLifecycle.stop();
      persist();
      const completion = await physicalOutcome.finish({ joined: state.joined, left: state.left });
      if (completion.exitCode !== 0) process.exitCode = completion.exitCode;
    } finally {
      if (physicalOutcomeTimer !== null) clearInterval(physicalOutcomeTimer);
      physicalOutcomeTimer = null;
    }
  })().catch(() => { observations?.dispose(); physicalOutcome.dispose(); process.exit(11); });
});
