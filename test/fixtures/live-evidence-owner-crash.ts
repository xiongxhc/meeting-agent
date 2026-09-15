import process from "node:process";
import { openSessionStore } from "../../src/adapters/sqlite-session-store.ts";
import { LiveProvisionalCorrelator } from "../../src/sessions/live-provisional.ts";
const store = openSessionStore({ filename: process.argv[2]! });
const owner = new LiveProvisionalCorrelator({ store, binding: { occurrenceId: process.argv[3]!, bridgeSessionId: "bridge-one", runtimeSessionId: 42n },
  nowMs: () => 1000, catchupClock: { now: () => 0, schedule: () => () => {} } });
owner.finalize({ type: "voice_transcript_final", sessionId: 42n, segmentId: "9", turnId: null, text: "prior process wording",
  capture: { kind: "source_sample_range/v1", clockDomainId: "domain", captureEpoch: 1n, firstFrameSequence: 1n, lastFrameSequence: 1n,
    sourceStartSample: 0n, sourceEndSample: 480n, sampleRateHz: 24000 },
  liveCoverage: { kind: "whole_touched_frame_nominal_host_envelope/v1", hostStartNs: 1n, hostEndNs: 20000001n, firstFrameHostEndNs: 20000001n,
    captureUncertaintyNs: null, knownRoundingAllowanceNs: 1n, mappingQuality: "nominal_frame_endpoint_interpolation" } });
process.send?.("durable_pending");
process.on("message", () => {});
