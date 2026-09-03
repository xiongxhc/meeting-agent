# Evidence handling

`evidence/` contains this schema only. JSONL, audio, and screenshots are
ignored by git; keep every run artifact outside the checkout when possible.

## Safe JSONL projection

The TypeScript and Swift `BridgeRecorder` implementations persist a command as
`bridge-session/v1` JSONL only after contract validation. For `connect_media`,
the persisted message omits `sessionToken` entirely. It is not masked, salted,
or reversibly encrypted. The live command may carry the token to the bridge,
but no recorder snapshot or JSONL line may contain it.

Other command and event fields retain the frozen `bridge-session/v1` shape.
The JSONL schema is one object per line:

```json
{"recordedAt":"2026-09-02T14:00:00.000Z","direction":"command","message":{"schema":"bridge-session/v1","sessionId":"sess_example","commandId":"cmd_example","type":"connect_media","endpoint":"udp://redacted-endpoint","format":"pcm_s16le/48000/1/20ms","expiresAt":"2026-09-02T15:00:00Z"}}
```

Run artifacts must also exclude real meeting URLs, participant names, raw audio,
screenshots, transcripts, and provider credentials. The redacted artifact is
the only file that may be hashed. Never hash or retain a pre-projection command
log.

## Capture continuity checkpoints

`AudioBridge.captureWatchdogTick()` is called by endpoint-side scheduling,
independent of capture callbacks. It returns a `CaptureEvidenceCheckpoint` with
the forwarded frame count, final sequence, and a SHA-256 chain hash of ordered
frame bytes. It retains no payload. A terminal silence emits an open capture
`audio_gap`; if capture resumes, the corresponding closing event shares its
`startedAt`.

For an hour-run sidecar, record only this redacted shape at a fixed interval
and on every watchdog transition:

```json
{"schema":"capture-checkpoint/v1","recordedAt":"2026-09-02T14:00:00.000Z","frameCount":123,"lastSequence":123,"frameHash":"<sha256-hex>"}
```

The endpoint integration must reject a run with missing or non-increasing
checkpoint sequence/count progress. Hash the redacted JSONL and checkpoint
sidecar together only after both pass the credential scan in the human
checklist.
