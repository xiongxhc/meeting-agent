# Private physical-custody contract

`spikes/feishu/fixtures/process/{outcome-v1,config-v2}.json` are shared Node/Swift
normative fixtures. Synthetic selectors are never deployment measurements.
Frozen bridge-session/v1 stdout and config/v1 acceptance are unchanged.

Config/v2 adds exactly `custody` to the existing static config fields. Its exact
keys are physicalClientId, physicalGenerationId, occurrenceId, bridgeSessionId.
The parent mints the generation and session before the durable claim. Slot labels
are explicit provisioning identity, never PID/build/lease/session-derived.
Slot:1..128 ASCII letters/digits/dot/underscore/hyphen, excluding dot/dotdot;
generation:32 lowercase hex. Existing occurrence/session validators and logical
bridge ID nonempty-string semantics remain authoritative, with no new character
grammar or independent smaller ID cap. The largest possible serialized outcome
with those bindings must fit4096 bytes including LF; per-value early rejection
above4096 only follows from that total bound. Reject, never truncate, before claim
or launch. Generated complete config retains the existing64KiB file bound.

Descriptor3 exclusively emits one UTF-8 JSON line then EOF, <=4096 bytes including
LF. Exact keys: schema, four binding IDs, outcome, reason, observedAt. Schema is
bridge-process-outcome/v1. observedAt is a real UTC instant, whole seconds or
three fractional digits with Z; it is local observation audit, not physical
transition accuracy. Unknown keys/values, duplicates, trailing lines, missing LF,
invalid UTF-8, oversize, wrong binding or incomplete EOF invalidate the result.

Allowed pairs only:

|outcome|reason|
|---|---|
|departure_confirmed|departure_observed|
|no_join_action|join_not_issued, client_not_running, client_pid_mismatch, client_not_unique|
|departure_unconfirmed|departure_not_observed, evidence_unavailable, input_reap_failed, cleanup_failed|

The three `client_*` reasons are written before any UI action, AX handle, stdout
line or media, when the bridge binds no Feishu/Lark client at launch. The static
config's `pid` is optional: without it the bridge resolves the one running
process whose bundle identifier and bundle path equal the config (live, with a
launch time). `client_not_running` means no such process runs;
`client_not_unique` means several run and no `pid` selects one;
`client_pid_mismatch` means a configured `pid` is not such a process (for
example, stale after a client restart). The bridge then exits nonzero with the
same code as its diagnostic. Custody clears as `join_not_issued`, the proof
kind; the cause stays in the recorded outcome.

No UI text, audio, transcript, credentials or caught error strings belong here.
Reserve join-action issuance before native press; never infer no-action from an
unreadable UI. Confirmed departure requires positive observation, evidence close
and resolved cleanup. Prefer unconfirmed input_reap_failed, evidence_unavailable,
cleanup_failed, departure_not_observed in that order. FD3 has its own absolute1s
write deadline, independent of control cancellation, then closes even on failure.

Parent clears only after one exact valid result, EOF and owned-child reap with
no protocol/cleanup failure. Ordinary nonsignal nonzero exit is separately audited
as `exitDiagnostic: "nonzero_exit"`, never a departure proof or veto; a positive
private outcome can coexist with logical/control failure. Signal termination,
forced cleanup, invalid private/control protocol, failed reap or commit still
block clearing. The diagnostic never masks a blocking failure. It is parent-only
audit, not a new private outcome wire field. Stdout left, exit, lease TTL and elapsed time never
clear custody. Missing confirmation after a parent crash requires audited manual
clear of the exact unresolved generation; no outcome file is a second authority.
