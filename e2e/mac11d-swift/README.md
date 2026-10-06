# Mac11d normal V3 drain calibration child

Test-only standalone Swift package. It imports the unchanged `../../bridges/mac`
library and composes `TimedMediaSession` → `TimedMediaControlOwner` →
`BridgeProcess` / `runBridgeControl` with the real `RuntimeMediaEndpointClient`.
Synthetic UI, capture and output never enumerate devices, read AX, or invoke live
Feishu/provider APIs. This is not the production executable or physical-device
acceptance, and does not close the mandatory expiry/reconnect/fault families.

## Runner contract

`mac11d-calibration --config /absolute/private/config.json --telemetry /absolute/private/telemetry.jsonl [--scenario normal|confirmed-cleanup-write|metadata-primary]`

Both paths are explicit, different absolute paths. Configuration is decoded by
the public `BridgeProcessConfiguration.read(path:inspection:false)` and must be
config3 with custody and audio. The telemetry parent must be owner-only (0700);
the create-new telemetry file is 0600, with no symlink traversal. Existing files
are rejected. No arguments or environment contain media credentials or keys.

- stdin: existing NDJSON `bridge-session/v2` commands, including the exact
  SDK-produced `connect_media` JSON. The shipped bounded public decoder validates
  it; no credential, authentication ACK, lease or wire protocol is fabricated.
- stdout: only shipped `bridge-session/v2` events.
- inherited fd3: shipped `BridgeOutcomeWriter` custody result.
- stderr: fixed diagnostic codes only; never error descriptions or config data.
- exit 0: serialized control and outcome/metadata writes returned successfully;
  the runner must separately require the scenario's typed drain outcome and
  authenticated source reopen.
  Exit 2 is bounded failure, with the original error retained through cleanup.

The runner waits for `capture_emission_complete` and actual control admission,
then issues leave/release through the child slot. Keep stdin open until command
results; EOF causes the shipped cleanup path. Signal handling uses the shipped
cancellation flag. All socket/owner/cleanup deadlines remain real monotonic time.

## Synthetic source and metadata

The native backend emits memory-only mono Float32 +0.25 at 24 kHz, buffers
`[480,480,137]`, with continuous PTS anchored to the real CoreMedia host clock.
Each callback is emitted retrospectively at +20/+40/+60 ms. It counts an emitted
buffer only after invoking the actual native sample callback. Stop fences future
callbacks on the same serial queue; the shipped converter drains its partial
tail. Local source conversion must preserve 1097 frames; emission counts alone
are not gateway recording proof. The runner verifies exact contiguous reopened
SDK source coverage, actual final boundary and authenticated finalization.

The injected pair sampler derives its declared wall time from one real host/wall
anchor and subsequent real host deltas; sample PTS uses that same host domain.
This proves declared synthetic timing, not certified UTC or device timing. The
shipped same-rate converter may report initial `unknownPriming`; preserve that
unavailable timing rather than inventing support.

Telemetry is JSONL, schema `mac11d-calibration/v1`. Barrier records have exactly
`schema,type:"barrier",name`, where names are `child_ready`, `capture_started`,
`output_started`, `capture_emission_complete`, `capture_stopped`, `output_stopped`,
`control_finished`. Capture/output stop order is producer-owned, not prescribed.
`control_finished` means the control loop returned, including failure cleanup.

The final record has `schema,type:"result",captureStarts,captureStops,outputStarts,
outputStops,emittedBuffers,emittedSamples,cleanupConfirmed,captureDrain,
departureOutcome,departureReason`. Counters are JSON integers. `cleanupConfirmed`
comes only from the actual `TimedMediaControlOwner.stopResult()`. `captureDrain`
is the public `CaptureDrainReport` encoding unchanged: confirmed has
`{drain:"confirmed",reason:null,boundary:{captureEpoch,lastFrameSequence,
outputEndSample,finalClockPairSequence}}` with canonical decimal strings;
unconfirmed has `{drain:"unconfirmed",reason:actualProducerReason,boundary:null}`.
Missing typed report is null. Departure fields are the actual process cleanup
status or null. No raw PCM, keys, credentials, UI text, environment dump, endpoint
or session identifiers enter this telemetry.

## Confirmed-cleanup write-failure scenario

Normal mode remains the default. Explicit `confirmed-cleanup-write` uses the
same real Runtime endpoint behind a test-only ownership decorator. Initial auth
reads/writes pass unchanged. On the first connection only, one post-native read
is held for at most two real seconds, and the second clock-pair write fails once
after finite capture progress while that owned continuation is still parked.
An absent or expired hold cannot select the fault. The shipped writer records that transport error
before cancellation. The decorator releases and joins its held read during
cleanup and combines that fact with the real endpoint's close confirmation.
Subsequent endpoint instances pass through. No authentication ACK or recording
metadata is invented, and no production timeout is widened.

The controller waits for actual `reconnected` attempt1 plus the second finite
capture emission before issuing leave/finalization. The first source emitted1097
samples but its137-sample converter tail cannot be forwarded by the failed
writer; the second source emits1097, including its normal final tail. The
independently reopened SDK recording must prove2057 samples in five frames,
epoch1 then epoch2 with actual reconnect discontinuity/gap and exact typed final
drain. Emission2194 and successful local writes do not prove recorded coverage.
Both initial priming uncertainty and nominal capture lacking a same-run wall
bracket remain explicit partial timing warnings, rather than fabricated UTC or
audio loss.

Private telemetry in this mode uses `mac11d-reconnect/v1`, the existing barrier
names plus `transport_write_fault`, and the existing result fields plus
`connectionsCreated,openedConnections,captureWrites,clockPairWrites,
injectedWriteFailures,heldReads,releasedHeldReads,pendingHeldReads`. Counters come
from actual decorator operations; completed writes are counted only after the
underlying write returns. They contain no wire body or connection identity.

From the Meeting checkout, after build and private child compilation:

```sh
/opt/homebrew/opt/node@24/bin/node e2e/mac11d-control.proof.mjs --swift-child /absolute/path/mac11d-calibration --scenario normal
/opt/homebrew/opt/node@24/bin/node e2e/mac11d-control.proof.mjs --swift-child /absolute/path/mac11d-calibration --scenario confirmed-cleanup-write
/opt/homebrew/opt/node@24/bin/node e2e/mac11d-calibration.mjs --swift-child /absolute/path/mac11d-calibration --scenario normal
/opt/homebrew/opt/node@24/bin/node e2e/mac11d-calibration.mjs --swift-child /absolute/path/mac11d-calibration --scenario confirmed-cleanup-write
```

Control proof launches the actual Swift child, validates join/leave/custody/reap
and zero native starts; it does not open media or prove reconnect. Run normal
SDK/gateway calibration first in a session permitting localhost listeners, then
the reconnect scenario. Component/source readiness does not close Mac11d/D2.

## Metadata-primary failure scenario

Explicit `metadata-primary` uses the unchanged real endpoint with no transport
fault decorator. After the three finite capture callbacks complete, only the
media clock's wall sampling is invalidated. Its first rejected sample writes
`metadata_clock_fault` and throws `BridgeProcessError.invalidInput`; every later
wall sample remains invalid. Admission uses the original coherent source and
UI observations retain the actual host clock, so neither is an alternate reason
for refusal. No socket cancellation is injected when arming the fault.

The runner keeps the occurrence alive until the shipped maintenance loop fails
and emits a diagnostic disconnect, then observes it for another 600 ms (beyond
the 100 ms retry delay and two 250 ms observation ticks). No reconnect attempt or
second native start is allowed. Leave still invokes shipped physical cleanup.
Native cleanup must be confirmed independently of the typed drain, which must
be `unconfirmed/drain_not_attempted`: the invalid final clock sample cannot
authorize a CaptureFinish or an acknowledged boundary. Cleanup should preserve
all 1097 PCM samples, including the 137-sample converter tail; the authenticated
SDK source must demonstrate that coverage with one epoch and only the initial
clock pair. Missing wall brackets and initial priming remain explicit timing
uncertainty. Generic delivery/transport diagnostics do not prove PCM loss or
classify the primary error.

Private `mac11d-metadata/v1` telemetry has the normal result fields plus exactly
`connectionsCreated,metadataInvalidations,rejectedWallSamples`. These count
factory calls, idempotent arming and actual refused wall samples. The final
oracle requires one real endpoint factory call and at least two refusals (the
maintenance and final pair). This scenario never emits reconnect counters or
the transport-write-fault barrier.

```sh
/opt/homebrew/opt/node@24/bin/node e2e/mac11d-control.proof.mjs --swift-child /absolute/path/mac11d-calibration --scenario metadata-primary
/opt/homebrew/opt/node@24/bin/node e2e/mac11d-calibration.mjs --swift-child /absolute/path/mac11d-calibration --scenario metadata-primary
```

Normal and reconnect SDK/gateway calibration still precede acceptance of this
scenario. Its component and no-media control checks cannot establish real
gateway authentication, primary-error ordering or reopened-source coverage.

## Configuration example

The runner replaces `evidenceRoot` and custody with its own private run binding.
`static-config.json` preserves this direct-child config3 example. When routing
through the application's existing physical-slot launcher, the parent runner
normalizes its private static copy to config1 without custody; the shipped
launcher injects the real run custody and config3 audio before spawning this child.
Selectors marked measured below describe this synthetic UI fixture only; they
are not real Feishu measurements. No PID/app/device lookup uses these fields.

```json
{
  "schema":"feishu-bridge-config/v3",
  "pid":123,"bundlePath":"/Applications/Synthetic.app",
  "bundleIdentifier":"test.synthetic","bundleVersion":"1","locale":"en-US",
  "evidenceRoot":"/private/tmp/PRIVATE-RUN/bridge-evidence",
  "observationIntervalMs":250,"joinDeadlineMs":1000,"actionDeadlineMs":1000,"axCallTimeoutMs":100,
  "custody":{"physicalClientId":"mac11d-slot","physicalGenerationId":"00000000000000000000000000000001","occurrenceId":"123456789@2026-10-01T00:00:00Z","bridgeSessionId":"mac11d-session"},
  "audio":{"captureDisplayId":123,"outputDeviceUid":"mac11d.synthetic.output"},
  "selectors":{"build":"1","locale":"en-US","measured":true,"titles":{},"identifiers":{
    "appWindow":"mac11d.synthetic.appWindow",
    "joinMeetingNumberField":"mac11d.synthetic.joinMeetingNumberField",
    "joinButton":"mac11d.synthetic.joinButton",
    "meetingWindow":"mac11d.synthetic.meetingWindow",
    "meetingEndedNotice":"mac11d.synthetic.meetingEndedNotice",
    "meetingNumberLabel":"mac11d.synthetic.meetingNumberLabel",
    "leaveButton":"mac11d.synthetic.leaveButton",
    "leaveConfirmButton":"mac11d.synthetic.leaveConfirmButton",
    "chatToggle":"mac11d.synthetic.chatToggle",
    "chatInput":"mac11d.synthetic.chatInput",
    "chatSendButton":"mac11d.synthetic.chatSendButton",
    "participantsPanel":"mac11d.synthetic.participantsPanel",
    "participantRowPrefix":"mac11d.synthetic.participantRowPrefix",
    "speakerGrid":"mac11d.synthetic.speakerGrid",
    "speakerTilePrefix":"mac11d.synthetic.speakerTilePrefix"
  }}
}
```

## Focused offline validation

Run from the Meeting checkout, with writable package scratch/cache paths:

```sh
CLANG_MODULE_CACHE_PATH=/private/tmp/mac11d-calibration-clang swift test \
  --package-path e2e/mac11d-swift --scratch-path /private/tmp/mac11d-calibration-build \
  --cache-path /private/tmp/mac11d-calibration-cache --config-path /private/tmp/mac11d-calibration-config \
  --security-path /private/tmp/mac11d-calibration-security --disable-sandbox
```

The debug binary is `/private/tmp/mac11d-calibration-build/arm64-apple-macosx/debug/mac11d-calibration`
on this arm64 Mac. `swift build --show-bin-path` with the same paths derives it.
`--disable-sandbox` disables SwiftPM's nested manifest/build sandbox only; it
does not change the enclosing managed session's filesystem or socket restrictions.
These focused tests create no TCP listener or real endpoint connection. A passing
build/helper suite is compile/component proof only; normal gateway calibration
remains unverified until the parent runner can execute with socket permission.
