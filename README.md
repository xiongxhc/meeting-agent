# Meeting Agent

This is a reusable public engine; private config, pins, and schedules live in a deployment overlay. It integrates with TeamMem only through the meeting inbox, and reads team knowledge only from the rendered Team Vault.

## Status

Feasibility spike stage. The frozen bridge contract and both halves of the
Feishu bridge exist and are tested; nothing has yet been run against a real
Feishu client, and no feasibility measurement has been recorded.

The engine also includes real SDK-backed invitation intake and durable organizer
discovery, verified against local HTTP/WebSocket peers and SQLite only. See
[invitation discovery](docs/feishu-invite-ingress.md) for explicit configuration,
shutdown ownership, operator commands and remaining human prerequisites.

```
protocols/          bridge-session/v1 JSON Schema — the normative contract
fixtures/contracts/ the frozen contract bytes both languages test against
spikes/feishu/      platform-neutral half: validator, recorder, observation
                    reducer (the reference ambiguity policy), replay harness
bridges/mac/        Swift package: accessibility observer, client adapter,
                    duplex audio bridge, JSONL recorder — unit-tested against
                    synthetic trees and marker bytes only
bridges/linux-browser/  agent-box web-client probe: meeting discovery and
                    capability classification, over recorded synthetic DOM
docs/feasibility/   the client matrix and the Mac language decision — both
                    written, both with every measurement cell still empty
docs/HUMAN-CHECKLIST.md  steps deliberately not attempted by an agent
```

## Running the tests

Node24 is the verified local environment. SDK-dependent test/typecheck/build/start
require the actual reviewed `@conversation/runtime` package. The optional peer
prevents an unpublished package registry fetch; it does **not** make that
prerequisite optional. `npm ci` removes a prior local bootstrap.

### Local SDK bootstrap

Use an existing Runtime checkout path, but package only the immutable reviewed
commit; never copy a concurrent worktree's `dist` or install a source alias.

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH # macOS Homebrew Node24, if needed
: "${RUNTIME_REPO:?Set the local Runtime checkout path}"
SDK_STAGE=$(mktemp -d)
mkdir "$SDK_STAGE/runtime"
git -C "$RUNTIME_REPO" archive 4c9dc85ddbb513c61abc738d06ea10e61ab8c885 | tar -x -C "$SDK_STAGE/runtime"
npm --prefix "$SDK_STAGE/runtime" ci --ignore-scripts --no-audit --no-fund
npm --prefix "$SDK_STAGE/runtime" run build --workspace @conversation/runtime
npm pack "$SDK_STAGE/runtime/packages/typescript" --ignore-scripts --pack-destination "$SDK_STAGE"
npm ci --no-audit --no-fund
npm install --save-dev --ignore-scripts --no-save --package-lock=false --no-audit --no-fund \
  "$SDK_STAGE/conversation-runtime-0.1.0.tgz"
node scripts/check-runtime-sdk.mjs
```

Do not commit the tarball or a machine-specific dependency path; the tracked lock
contains only optional peer metadata. The check pins reviewed built file digests,
not just version0.1.0. Registry publication remains a separate gate. Runtime13's
`StdioGatewayTransport` owns bounded EOF/TERM/KILL/reap cleanup and reports its
cleanup outcome; Meeting application composition remains separate. The package's `start` still intentionally refuses to compose
unconfigured live adapters; a successful prerequisite check does not start a meeting.
The install flags are intentional: `--save-dev` selects the optional peer in
npm's in-memory ideal tree, scripts stay disabled, `--no-save` preserves the
manifest, and `--package-lock=false` preserves the lock while installing the real
package bytes instead of a copied tree or source alias.

Recovery capabilities and alignment staging belong in an owned private0700 state
directory outside shared/Git/TeamMem roots. SQL projections alone do not encrypt
or protect SQLite/WAL files. Deployment must establish and verify private roots
before opening the store; no helper changes permissions on existing user paths.
Recording/provider keys and plaintext audio remain exclusively outside Meeting.

The hardware-free encrypted restart test also needs a prebuilt gateway from that
same immutable source. Build it before starting the unchanged test deadlines:

```sh
RUNTIME_TARGET=$(mktemp -d)
RUNTIME_BUILD_TMP=$(mktemp -d)
(cd "$SDK_STAGE/runtime" && CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=1 \
  CARGO_TARGET_DIR="$RUNTIME_TARGET" TMPDIR="$RUNTIME_BUILD_TMP" \
  cargo build --locked -p conversation-runtime-gateway --bin conversation-runtime-gateway)
export MEETING_TEST_RUNTIME_GATEWAY="$RUNTIME_TARGET/debug/conversation-runtime-gateway"
npm run build
```

Missing gateway/bootstrap prerequisites fail explicitly; tests do not skip this
proof or start a real device/provider. Its private Runtime-owned shell generates
a synthetic key, imports it with shell builtins after environment sanitization,
and execs the gateway. Meeting receives only the finalized opaque capability.

### Postmeeting alignment component

`createConversationRuntimeClient` accepts an actual open SDK v4 client;
`connectPostmeetingRuntime` explicitly negotiates v4 over a caller-owned transport.
Live admission is available only through explicit timed/v2 library composition
described below; legacy injected starts remain unavailable in the actual adapter.
`RecordingAlignmentOwner` stages one
reader at a time using a separately stored `RecordingRecovery`. Historical
`sourceSessionId` is never replaced by the new gateway's `currentSessionId`.
Normal and failed-generation recording transactions bind restart authority
atomically; ordinary session/recording/evidence projections omit it.

`openSessionStore` leaves legacy behavior intact, but recovery/staging APIs reject
memory-only stores, non-owned/symlink/hardlinked/replaced files, or immediate
parents with group/other permissions. POSIX ownership is required; no Windows ACL
claim is made. Private0700 parents protect DB and sidecars; SQL is not encryption.

Each private page is at most64 entries and32KiB **stored UTF-8**, using a versioned
canonical bigint-tag representation of SDK-parsed values. Attempts cap at2million
entries,250000pages and256MiB payload. These are not SQLite/WAL/index disk bounds;
operators need additional disk headroom. Representation overhead can reject an
otherwise Runtime-valid maximum page; this fails visibly instead of truncating.
Tentative pages never appear in selected evidence. Matching terminal selection
is atomic, and bounded keyset reads retain the chosen attempt identity. Partial
coverage stays partial; legacy unavailable has no timing policy/anchor. Legacy
speaker/artifact consumers keep that null alignment; timed final consumers use
the separate selected-evidence path below.

Use one shared `RecordingAlignmentOwner`, and await `owner.close()` **before**
closing its Runtime/SQLite dependencies. A failed cleanup retains ownership.
Reopen, age and absent in-memory state do not authorize takeover. Recovery needs
an awaited trusted application/supervisor exclusive-owner proof. An application
that owns the gateway through Runtime13's `StdioGatewayTransport` must await close
and require a successful cleanup outcome before issuing that proof; failed or
unknown cleanup is not authority. Never attempt to reap an unrelated historical
PID. The proof is not cryptographic; Runtime-validated one-use permits and
exact-token CAS enforce binding.
Reclaim deletes at most64 pages per transaction; selected evidence survives failed
replacement and a bounded static last-failure reason remains durable.
Successful replacement atomically retires the previous selection as non-owner
payload, without a failure warning. Before another stage, the shared owner resumes
that cleanup in bounded yielding batches; `recover` can also finish released
payload cleanup without asserting a nonexistent reader has died. A real staging
or failed-cleanup reader still requires the trusted proof. Owner close waits for
pending reclaim, and no new reader is admitted during it.

### Timed final evidence library

`reconcilePersistedTimedSpeakers` reads one exact occurrence/bridge/recording binding
through the actual SDK's `reconcileFinalizedRecording({capability})`. It requires
an already closed timed evidence owner and selected authenticated alignment; it
does not recover a live owner, start alignment staging, or take ownership of the
Runtime client/store. Historical source ID/handle/hash remain distinct from the
current text-control ID. Callers must await the operation before closing SQLite;
an abort signal fences result acceptance and iterator cleanup, but the actual SDK
RPC has no per-call abort option, so its transport lifecycle remains caller-owned.

Reads use one at-most64-entry/32KiB alignment page and at-most8 UI rows, with only
the separately bounded256 live-wording rows reordered in memory. Expiry, closed
ownership and the selected source/attempt are checked throughout and at return.
No transaction spans the Runtime await. Null terminal time on an exact closed
failed attempt does not prevent reading its prefix, but never establishes an
occurrence end; the result stays incomplete. Nothing extends retention deadlines.

Names are recomputed from fresh, attended, same-host UI-observed whole-frame
coverage. Outward sample boundaries use conservative candidate-lower/conflict-upper
counts, exact80%/500ms comparisons and the prior observation's earliest activation
bound. Provider clusters can veto, never grant, identity. Timingless administrative
rows do not erase coverage; explicit observation/disconnect barriers do. Unlocated
UI-loss disables naming for that generation without erasing words or by itself
making transcription incomplete. Fully processed final wording may recover live-
cache loss; known capture gaps, failed prefixes, failed final processing or retained
live buffers outside final coverage remain incomplete. These are processing-level
claims, not acoustic accuracy or evidence that every utterance was recognized.

Final wording supersedes a live unit only when its outward worded interval union
covers the entire mapped submitted live buffer (including its padding). Equality
and adjacency count; even a one-sample hole retains the entire live unit. Original
durable live history is never removed. No semantic matching or word-time guessing
is used. `buildTimedTeamMemMeetingArtifact` checks the exact selected provenance
and audio hash separately from current `processText` identity. It requires an
authoritative known meeting end and admitted local-wall endpoints, and emits one
bounded component-maxima warning with overall physical/UTC accuracy still unknown.
Signed local estimates are floored to the frozen artifact's microsecond precision;
mapping and serialization rounding remain separately described, not invented UTC.

**v1 compatibility:** ordinary padding/partially overlapping live and final
observations, or overlapping final speech, can produce overlapping retained units.
Frozen artifact v1 requires nonoverlapping intervals. The builder therefore refuses
before text synthesis when all retained units cannot be represented, just as it
refuses missing/step-crossing timestamps. All private words/history remain available;
it does not drop, splice, retime, group mixed provenance, or weaken the contract.
For these observations, explicitly opt into `buildTimedTeamMemMeetingArtifactV2`.
It emits `teammem-meeting/v2`, preserving each whole observation's wording,
interval, ID, speaker, confidence and stage/model provenance. Entries are ordered
by exact start, end and ASCII ID, with overlap allowed. Synthesis receives those
intervals/provenance and treats overlap as potentially the same speech, not proof
of repeated events. This is not semantic deduplication or a model-accuracy claim.
The existing v1 builder and reader retain their original refusal behavior.
`parseTeamMemMeetingArtifactV2` and `parseSupportedTeamMemMeetingArtifact` expose
explicit v2 and supported-version validation; the outbox preserves either version
through restart. Manifest and receipt versions remain v1. Consuming v2 requires a
matching v2-capable TeamMem package; it is never silently downgraded to v1.

These library paths are not yet selected by a shipped application lifecycle.
Application composition and human live checks remain separate gates; no live
provider/device/TeamMem or whole-application E2E proof is implied here.

### Timed live evidence library

The reviewed SDK 4c9dc85 adapter accepts the discriminated
`{ timingContract: "capture-clock/v1", bridgeSessionId, profile: "online",
responseMode: "external_gate" }` start. Its typed lease proves command admission,
not provider/native health. `createMeetingSession` accepts a bridge-v2 transport
and explicit `timedEvidence: { store, onTranscript?, onResult? }`. The connected
control ID binds evidence before synchronous join observations arrive; it is not
voice-start or recording-finalization authority. Legacy v1 callers/guards remain
unchanged. This does not select config3 or change the application/main factory.

Wording, source sample locator and separately labelled whole-touched-frame nominal
envelope are retained atomically, without invented UTC, receipt-time origins or
physical accuracy. Missing timing never discards admissible wording. Text/name
gate/retrieval/authorization proceeds without waiting for UI. A separate one-shot
provisional result may arrive up to2s later, and never rewrites a response or final
speaker identity. Positive names require fresh observed activation, attendance,
same-host ordered readable snapshots over the **whole** envelope and no gap over2s.
Unchanged polls do not refresh activation; first-frame **end** governs freshness.
This is UI-observed coverage, not physical continuity between polls or final80%
reconciliation. Unknown physical uncertainty remains null.

One correlator admits32 pending segments and4096 observation/domain-history slots.
Durable generation bounds are256 live rows, each16KiB text +4KiB evidence +4KiB
result, and65536 UI rows/256MiB payload at4096bytes/event. Reads take at most8 UI
rows or1 live row. Payload caps exclude SQLite/WAL/index overhead; provision disk
headroom. Pure250ms polls fit roughly4.55h, less with other events. Overflow latches
separate UI/wording loss facts; wording delivery/name gating continues, but no
unpersisted row/result is represented as durable. B2 interprets these facts later.
The existing bounded event queue/drop policy is unchanged: a dropped v2 event
immediately closes provisional coverage, and a dropped timed final latches the
separate `runtime_queue_overflow` wording-loss fact. Failed loss writes remain
visible cleanup/routing failures, never falsely reported as persisted evidence.

Await session/correlator close before store close. `recoverPendingLiveEvidence`
requires an awaited, trusted exclusive prior-owner cleanup proof, then fences the
old token and terminalizes unresolved rows anonymously in yielding one-row batches.
Reopen/TTL alone never authorizes recovery. No pre-crash UI coverage is reconstructed.
The callback must own/bound its cleanup; controlled tests actually reap a child.
Existing terminal+14d expiry remains authoritative. Expired data is unreadable
even while physical reclamation is pending. Synchronous legacy purge performs at
most one timed batch (8 UI +1 live row); for a complete timed drain, own and await
`drainExpiredTimedEvidence(store, nowMs, signal?)`, which yields between transactions.
Cancellation leaves unreadable expired rows for an explicit later drain. No audio
retention, final completeness, artifact builder or TeamMem policy changes here.

### External package check

After building, install both tarballs into a fresh temporary consumer (no publish,
source alias or global link). `--ignore-scripts` is intentional here: this check
imports package roots/types and exercises safe startup, not SQLite native loading;
the main suite separately uses real migrated SQLite with its installed binding.

```sh
CONSUMER_STAGE=$(mktemp -d)
npm pack --ignore-scripts --pack-destination "$CONSUMER_STAGE"
npm --prefix "$CONSUMER_STAGE" install --ignore-scripts --no-save --no-audit --no-fund \
  "$CONSUMER_STAGE/meeting-agent-0.1.0.tgz" "$SDK_STAGE/conversation-runtime-0.1.0.tgz"
cp test/fixtures/runtime-package-consumer.mjs test/fixtures/runtime-package-consumer.mts "$CONSUMER_STAGE/"
(cd "$CONSUMER_STAGE" && node runtime-package-consumer.mjs)
node node_modules/typescript/bin/tsc --noEmit --target ES2023 --module NodeNext \
  --moduleResolution NodeNext --skipLibCheck "$CONSUMER_STAGE/runtime-package-consumer.mts"
```

The installed package includes its exact prerequisite helper. Missing or changed
SDK builds give a bootstrap diagnostic; a valid installed SDK reaches the existing
intentional adapter-composition refusal, never false service readiness. This is
postmeeting component proof, not shipped application/live meeting acceptance.

```
npm test                        # TypeScript: node --test over the source trees
cd bridges/mac && swift test    # Swift: no external dependencies, no network
```
