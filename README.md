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

## Running the built end-to-end spine

One command stages a fresh private root, builds the package, and drives the
SHIPPED standalone admission and composition against scripted local peers:

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
export MEETING_E2E_TEAMMEM_REPOSITORY=/absolute/path/to/teammem-checkout
export MEETING_E2E_ARTIFACTS_DIR=/absolute/path/to/artifacts   # only outside the default layout
npm run e2e -- --out /absolute/evidence/dir            # add --keep to retain the temp root
npm run e2e -- --out /absolute/evidence/dir --only-refusals
npm run e2e -- --out /absolute/evidence/interactive --interactive
npm run test:e2e                                    # sequential spines and focused peer checks
```

Two environment variables locate inputs that live outside this repository. Both
must be absolute paths.

- `MEETING_E2E_TEAMMEM_REPOSITORY` names the TeamMem meeting-storage checkout
  the pinned TeamMem tree is archived from. Every `e2e/run.mjs` mode except
  `--only-refusals` requires it and refuses to start without it, before pin
  verification, the build or staging.
- `MEETING_E2E_ARTIFACTS_DIR` names the directory holding the pinned Runtime
  artefacts and their review records. It defaults to `../../artifacts` relative
  to this checkout. Set it whenever the checkout is not at that location
  relative to the artifacts directory, for example a copy made elsewhere to run
  tests; the pins and `npm run test:e2e` read it too.

The application spine is excluded from `npm test`. Run it separately on an idle
machine, with only one spine running at a time; it builds and launches the whole
application and its peers. Do not overlap it with the full Node suite.

The timed Runtime integration tests and spine assess each private launcher through a no-argument
refusal before timed startup. This lets macOS complete executable assessment
during setup. The child exits before configuration or provider startup; existing
connection, media and cleanup deadlines remain unchanged. Test case windows
include a separate 60-second setup allowance.

It needs the pinned Runtime gateway and SDK tarball recorded in `e2e/pins.mjs`,
and refuses to run when either SHA256 differs. Network is used only to build and
install the TeamMem wheel. Set `E2E_ALLOW_LOCAL_BARE_PUSH=1` to let the real
TeamMem consumer publish; the push target is a bare repository the harness
creates inside its own temp root, never a real remote. Nothing outside that root
is written: `~/.local/share/teammem`, `~/.config/teammem` and any deployed hub
are untouched.

`--out` receives `bundle.json` (commands and exits with load averages, source
tree id, Runtime digests, the redacted static-code trace, the reopened state
database, the process tree at peak and every oracle) and `NEGATIVE-PROOFS.md`.

What the evidence is: scripted local application test readiness. It is not a
Feishu, provider, acoustic, Linux or remote-split acceptance. The shipped client
pins the Runtime profile to `online`, which requires remote HTTPS/WSS providers,
so the live lane runs against unreachable `.invalid` endpoints: audio is captured
and recorded, and no transcript turn is produced or faked. Every bundle therefore
carries an expected speech-recognition failure with `recovery: continue_session`
from those unreachable providers; it is the configuration working as designed,
not a fault of the run. The post-meeting lane
stays in the meeting's pinned `online` profile, because Meeting refuses a
post-meeting Runtime in any other profile: the launcher runs the separately
pinned scripted gateway with loopback providers, a local fixture answers the one
synthesis call and an idle peer stands in for recognition and speech, so the
alignment traversal and the synthesis are answered rather than invented.

`--interactive` selects the separately packaged feature-only scripted gateway
for the live lane, with loopback Feishu and speech/language transports. It drives
the shipped name gate and current-first/vault retrieval, then interrupts a held
active response through recognizer speech activity and matching playback flush.
The evidence checks real framed events, segment/turn bindings, fixture Git reads,
playback ACKs, capture progress, secret isolation and child cleanup. This is a
bounded interactive smoke checkpoint. Full L1–L3 acceptance still requires
final-playback races, durable recording/gap checks, repeated close and the native
credential-expiry/reconnect cuts recorded in the acceptance matrix. The default
production gateway and its provider validation remain separate.

The prepared `--r2-baseline` command creates only the incomplete revision 1
prerequisite for later R2 recovery. Run it on a permitted host with an explicit
validated wheelhouse and local bare publication opt-in:

```sh
export MEETING_E2E_TEAMMEM_REPOSITORY=/absolute/path/to/teammem-checkout
E2E_ALLOW_LOCAL_BARE_PUSH=1 /opt/homebrew/opt/node@24/bin/node e2e/run.mjs --out /absolute/private/evidence/r2-baseline --r2-baseline --dependency-wheelhouse /absolute/validated/wheelhouse --keep
```

Live capture uses the production online gateway and the default 51-frame peer.
After capture, an atomic config replacement selects the separately pinned
scripted gateway for postmeeting processing: final diarization stays unavailable,
synthesis stays healthy, and actual issued recognition/speech endpoints come
from a separate idle voice peer. The exposed shipped composition waits for the
exact live occurrence's confirmed cleanup, then calls one public backfill tick;
its automatic backfill cadence is one hour. No seed, artifact or receipt is
injected. A dry run or missing publication receipt fails this baseline.

The read-only schema29 projection requires one incomplete delivery, accepted
publication, due retry job and original +11d/+14d deadlines. Retained source
identity/hash and the actual TeamMem audio-store inventory are measured; on
POSIX the accepted consumer retains two directory entries sharing one copied
ciphertext inode (final file and custody hardlink), with link count two. File
names are discovered, not assumed. Capture-tail, custody, privacy and owned
process checks remain required. Idle voice telemetry proves zero recorded model
calls/PCM appends; it does not count TCP/WebSocket connections.

R2 inspects the SQLite file header and existing sidecars before any evidence
connection opens, then checks schema29 before ordinary reopened/capture reads.
A refused snapshot stops further SQL evidence collection without checkpointing
or repair. Any failed R2 evidence or exceptional refusal preserves its private
root and ciphertext even without `--keep`, with a bounded reason in `bundle.json`;
ordinary modes retain their existing cleanup policy.

Listener-free synthetic SQLite and provider checks are component evidence (C).
The command is prepared but has not established an app-generated baseline on
the currently restricted host. Actual cross-process capture/publication is
integration evidence (I); higher revisions, replay and early cleanup remain
separate R2 work. “VAD check gates speech recognition, not encrypted recording.
Recording must remain independent of provider failures.”

Run the prepared commands below from a reviewed preparation checkout, after
matching its source inventory to the matching versioned source manifest. Later reviewed
commits have successor manifests; V7 describes only its original source cut.
The raw development checkout includes an
excluded partial implementation and is not the packaged source for these commands.

The prepared ingress recovery campaign uses two sequential application owners
against the same preserved private root. An unavailable reservation first leaves
one durable metadata-blocked invite; duplicate and reordered events keep its
first title and identity. A corrected resolver on reopen leaves it blocked until
one public operator retry, then verifies one Runtime/bridge launch:

```sh
/opt/homebrew/opt/node@24/bin/node e2e/ingress-run.mjs --out /absolute/private/evidence/ingress
/opt/homebrew/opt/node@24/bin/node e2e/ingress-run.mjs --out /absolute/private/evidence/missing-launcher --missing-launcher
```

Use a fresh output directory for each sequential invocation on a permitted host.
The missing-launcher branch requires admitted metadata and the actual lazy
Runtime startup failure before any bridge launch. Inventory or root refusal
leaves that branch unexecuted. Exact commit-before-ACK observations, final ACK
history, direct-child and descendant cleanup must all pass; both roots are
preserved. The listener-free source checks do not establish R5/R7 application
acceptance, crash-before-callback recovery or terminal-session reopen.

The separate conflicting-replay selection sends a changed normalized invitation
under the original event identity, then replays the original content:

```sh
/opt/homebrew/opt/node@24/bin/node e2e/ingress-run.mjs --conflicting-replay --out /absolute/private/evidence/ingress-conflict
```

It requires an actual decoded SDK 500 for the conflict, no commit observation and
an unchanged durable invitation. The subsequent original replay must receive 200
and preserve the first title, hash and acceptance time. The existing two-owner
reopen, public metadata retry and one-launch checks still apply. This option can
also combine with `--missing-launcher` in a separate fresh output directory.
Reviewed listener-free tests cover the normalizer, store transaction, decoder and
campaign controls; actual SDK/application execution remains unverified. This
nonfatal rejection does not establish commit-before-callback crash recovery or
terminal-session reopen.

The separate closed-generation selection observes removal, closes the second
owner, and opens a third ordinary owner before replaying the original invite:

```sh
/opt/homebrew/opt/node@24/bin/node e2e/ingress-run.mjs --closed-generation-reopen --out /absolute/private/evidence/closed-generation
```

It requires a closed generation and timed owner, confirmed physical departure
and reap, separately assigned unknown-end recording custody, and unchanged first
invitation and audit facts. The third owner must accept the replay without
resolution, launch, deferral or durable mutation. Each owner must settle before
the next begins. This selection is exclusive with conflict and missing-launcher
options. The session remains `finalizing`; strict `failed`/`notified` terminal
reopen is still open. Reviewed component checks do not establish an actual
three-owner run, physical removal or recording custody.

The admission rollback selection installs one guarded fixture-only event
abort trigger on the admitted disposable database. For this command, `--out`
names a new evidence file under an existing canonical parent directory:

```sh
/opt/homebrew/opt/node@24/bin/node e2e/invite-admission-abort-run.mjs --out /absolute/private/evidence/invite-admission-abort.json
```

The first valid invite must receive 500 without a commit or partial occurrence.
After exact trigger removal, the original invite must receive 200 as its first
durable acceptance. A fresh ordinary application/store owner must then replay
it unchanged. Missing metadata references keep the case blocked without launch.
Both owners must close cleanly and the trigger must be absent. This is ordinary
same-process reopen after a nonfatal transaction abort. Real-store components
do not establish actual SDK ACKs, admitted ownership or crash recovery.

The separate durable-backlog selection fills the production 256-invitation
backlog without launching meetings. For this command, `--out` names a new
JSON evidence file under an existing canonical private parent directory:

```sh
/opt/homebrew/opt/node@24/bin/node e2e/invite-backlog-run.mjs --out /absolute/private/evidence/invite-backlog.json
```

All 256 distinct invitations must commit before receiving 200, then settle
with missing metadata references. Invitation 257 must receive 500 without a commit or partial row.
After clean ordinary application/store reopen, each original invitation must
receive 200 as an unchanged replay; the same overflow invitation must still
receive 500. The full invitation, audit and metadata state must remain intact,
with no downstream meeting work. Each application must close with zero owned transport work before fixture
cleanup; the peer then closes before admitted return and owner release. The
first owner must fully settle before the second begins. This is ordinary same-process reopen, not
process restart. Real-store and decoded-frame components do not establish actual
SDK ACKs, admitted application ownership or dispatcher saturation.

The prepared capacity command accepts `--count 1`, `2`, `4` or `8`. Run each
count sequentially with a fresh private output directory:

```sh
/opt/homebrew/opt/node@24/bin/node e2e/capacity-run.mjs --count 1 --out /absolute/private/evidence/capacity-n1
```

One application owner admits distinct scripted slots, retains the excess invite
in its durable queue, quarantines one missing physical outcome and drains the
healthy controls. Reopened state must preserve admission, exact departure
results and every observed capture watermark. These are prepared coordinator
checks; actual runs, artifact isolation, maintenance and resource headroom remain
unverified. Scripted slots do not establish simultaneous physical Mac meetings.

The prepared recording timing command changes only frame 26's nominal start by
two nanoseconds while retaining all 51 frames and their PCM samples:

```sh
export MEETING_E2E_TEAMMEM_REPOSITORY=/absolute/path/to/teammem-checkout
/opt/homebrew/opt/node@24/bin/node e2e/run.mjs --out /absolute/private/evidence/invalid2ns --keep --media-timing invalid2ns
```

The shipped backfill owner supplies selected COMPLETE alignment pages. Before
and after closure, the oracle requires partial timing coverage, the exact
confirmed finish boundary, continuous samples and matching clock-domain/source
provenance. It permits independent wall uncertainty without inventing audio loss.
This command skips publication, receipt and organizer-DM assertions. Listener-free
checks are accepted source/component evidence; actual recording conformance,
recognized speaker attribution and full L4/L5 remain unverified.

The selected L4 command prepares three separate attribution cases. Use a fresh
private output directory for each case:

```sh
export MEETING_E2E_TEAMMEM_REPOSITORY=/absolute/path/to/teammem-checkout
/opt/homebrew/opt/node@24/bin/node e2e/run.mjs --interactive --l4-case sent-named --keep --out /absolute/private/evidence/l4-sent-named
/opt/homebrew/opt/node@24/bin/node e2e/run.mjs --interactive --l4-case unavailable-missing --keep --out /absolute/private/evidence/l4-unavailable-missing
/opt/homebrew/opt/node@24/bin/node e2e/run.mjs --interactive --l4-case sent-drop --keep --out /absolute/private/evidence/l4-sent-drop
```

Each case requires actual Runtime final events, mapped capture evidence and an
application-written READY artifact from the production reconciler. The named
case requires observed speaker A; the missing-observation and declared-drop cases
require anonymous attribution. Silent participant S must never receive a person
summary, and A's explicit leave/rejoin must remain visible in attendance. The
selected turn permits chat-only handling and rejects live voice output. Provider
frame ordinals are not assumed to equal recorded source-frame positions.

The declared `observation_drop` is not proof of a physical restart or unobserved
attendance gap. These commands skip publication, receipt and organizer-DM
assertions. Independently reviewed listener-free tests establish source/component
preparation; actual case runs, ambiguous identity, full L4 acceptance and native
capture remain unverified.

The final-pair omission selection captures 49 frames below the 50-frame periodic
clock-pair cadence, then omits the final pair and finish exchange:

```sh
export MEETING_E2E_TEAMMEM_REPOSITORY=/absolute/path/to/teammem-checkout
/opt/homebrew/opt/node@24/bin/node e2e/run.mjs --out /absolute/private/evidence/omit-final-pair --keep --media-timing omit-final-pair
```

It requires an unconfirmed drain with reason `final_clock_pair_omitted`, no
requested or acknowledged finish boundary, and all 49 recorded frames present.
Selected COMPLETE alignment must retain continuous sample coverage while reporting
missing wall alignment. The initial pair cannot confirm the final tail. This
short selection skips publication, receipt and organizer-DM assertions; it does
not cover a long recording with a mapped prefix and unmapped tail. Reviewed
listener-free checks establish source/component evidence. Actual encrypted
recording and application conformance remain unverified.

The separate long omission selection captures 99 frames across the periodic
clock-pair cadence, retaining two actual pairs and omitting the final exchange:

```sh
export MEETING_E2E_TEAMMEM_REPOSITORY=/absolute/path/to/teammem-checkout
/opt/homebrew/opt/node@24/bin/node e2e/run.mjs --out /absolute/private/evidence/omit-final-pair-long --keep --media-timing omit-final-pair-long
```

Selected COMPLETE pages must preserve every sample, a nonempty mapped prefix and
an unmapped tail with no invented audio loss or finish confirmation. The mapped
prefix boundary is derived from the recorded clock evidence. A delayed capture
that cannot establish the selected shape fails. This skips publication, receipt
and organizer-DM checks; reviewed components do not prove actual encrypted
recording, recognition or full L4/L5 acceptance.

The prepared startup cancellation command holds the actual WebSocket endpoint
request and invokes the ordinary public application close while it is pending:

```sh
/opt/homebrew/opt/node@24/bin/node e2e/pending-startup-run.mjs --out /absolute/private/evidence/pending-startup
```

It requires cancellation and zero transport/request counts before fixture cleanup,
then peer closure before the admission owner is released. Campaign conformance
is separate from the underlying `clean:false` composition result and standalone
exit 70. The reviewed deadline fixes reject late synchronous results and retain
ordinary cleanup. Listener-free checks are component evidence; actual SDK
cancellation remains unverified.

The separate upgrade selection allows the HTTP endpoint lookup to finish with
status 200, then holds the actual GET WebSocket upgrade before acceptance:

```sh
/opt/homebrew/opt/node@24/bin/node e2e/pending-startup-run.mjs --mode ws-upgrade-normal-close --out /absolute/private/evidence/pending-upgrade
```

It rechecks the held upgrade immediately before ordinary public close. The
selected oracle requires the same peer-observed remote close and zero owned
HTTP/connection sockets before fixture cleanup; local fixture closure cannot
substitute. Overflow or later invalid observations keep cleanup unconfirmed even
if an earlier close promise fulfilled. It preserves the real `clean:false`
composition result and standalone exit 70 separately from campaign conformance.
This is reviewed source/component preparation, with no actual SDK upgrade run.
Tenant-token acquisition has its own prepared selection below. Child-launch and
signal selections remain separate unfinished boundaries.

The tenant-token selection delivers a valid invitation, observes an actual
outbound tenant-token request, and starts ordinary close while it is held:

```sh
/opt/homebrew/opt/node@24/bin/node e2e/tenant-token-run.mjs --out /absolute/private/evidence/tenant-token
```

Close must wait for the owned HTTP timeout, retain a retryable metadata timeout,
and settle remote request and transport ownership before fixture cleanup. This
is not prompt token cancellation. Repeated close must preserve the same promise
and state; peer cleanup must precede admission-owner release. Reviewed in-memory
HTTP/socket/peer and discovery/store components do not prove SDK cache behavior
or an actual application run.

The prepared D2 harness adds four independent cuts. Each requires real localhost
listeners and a fresh absolute output directory; run them sequentially:

```sh
export MEETING_E2E_TEAMMEM_REPOSITORY=/absolute/path/to/teammem-checkout
export E2E_ALLOW_LOCAL_BARE_PUSH=0
npm run e2e -- --interactive --d2-cut durable --out /absolute/evidence/durable
npm run e2e -- --interactive --d2-cut cancel-wins --out /absolute/evidence/cancel-wins
npm run e2e -- --interactive --d2-cut complete-wins --out /absolute/evidence/complete-wins
npm run e2e -- --interactive --d2-cut repeated-close --out /absolute/evidence/repeated-close
```

Durable checks reopen actual persisted live evidence, selected COMPLETE alignment
and the Runtime trace, including recording-duration consistency. The scripted
media-v3 peer now fences capture, sends its final clock pair and exact kind-10
boundary, and waits for the matching kind-11 ACK on the authenticated connection
under one 20-second stop budget. Its typed drain event precedes `left`, retaining
the original observed end time. The positive baseline also checks every final
frame/sample against the reopened confirmed drain and selected authenticated
alignment; partial wall coverage remains separate from audio loss. In-memory
byte-peer and synthetic SQLite/alignment tests are component evidence only.
Each ordering
waits for the actual bound Runtime playback acceptance; completion also requires
Runtime to observe the late speech onset. Cancellation measures the interval from scripted provider
onset send to the peer's flush-ACK write callback on the same host. It does not
measure physical interruption latency. The two race cuts suppress a late or
duplicate callback in the Node peer; Swift renderer acceptance remains separate.
Repeated close uses the real composition owner while playback is held, checks
one terminal through teardown, and preserves an actual unconfirmed-departure
refusal (exit 70 and durable quarantine). That disposition proves refusal and
cleanup, rather than clean physical departure; it does not exercise publication.

These cuts are prepared, not accepted: the October 1 managed profile rejects
localhost listeners with EPERM, so offline helper tests and a successful build
do not prove these integrations. Full Node gates and actual cut bundles are
required before acceptance or overlay repinning. Mac11d and D3–D4 remain open.

### Prepared Mac failure calibration and offline packages

`e2e/mac11d-swift` is a test-only native callback producer over the shipped
Swift capture/converter, timed-media and child-control owners. Build its
`mac11d-calibration` executable, then run one fresh SDK/gateway occurrence per
scenario, sequentially:

```sh
node e2e/mac11d-calibration.mjs --swift-child /absolute/mac11d-calibration --scenario normal
node e2e/mac11d-calibration.mjs --swift-child /absolute/mac11d-calibration --scenario confirmed-cleanup-write
node e2e/mac11d-calibration.mjs --swift-child /absolute/mac11d-calibration --scenario metadata-primary
node e2e/mac11d-calibration.mjs --swift-child /absolute/mac11d-calibration --scenario native-primary
node e2e/mac11d-calibration.mjs --swift-child /absolute/mac11d-calibration --scenario unconfirmed-cleanup-write
node e2e/mac11d-calibration.mjs --swift-child /absolute/mac11d-calibration --scenario expiry-rollback
```

The private metadata file separates source emission, actual completed writes,
primary failure, native cleanup, typed capture drain and departure custody.
Native failure may leave only an authenticated recording prefix; emitted samples
do not establish a persisted tail. Delayed cleanup retains the shipped five-second
stop budget and settles its real native callback afterward. Expiry uses an actual
issued three-second lease, a fixed monotonic cutoff and a test-only admission-wall
rollback; capture clock pairs retain their original coherent source.
The fresh expired-credential authentication probe runs before leave or voice stop,
and is bounded within a conservative reconnect window. Its empty EOF proves
refusal of that issued expired credential. For the default profile, empty EOF does not identify the gateway's active-fence
release or unique refusal cause: expiry remains `status: "incomplete"` with
CLI exit 1, even with optimistic proof labels.

This additional explicit TEST command is prepared for a later admitted host run;
it has not produced observed integration evidence:

```sh
/opt/homebrew/opt/node@24/bin/node e2e/mac11d-calibration.mjs --swift-child /absolute/mac11d-calibration --scenario expiry-rollback --runtime-profile runtime-media-evidence-test-20261005
```

TEST acceptance requires the actual native failure oracle, the held journal's
exact released admission, one fresh measured TCP probe, a unique credential-only
TTL rejection bound to that probe's tuple, and complete independently verified
journal/provenance/receipt and cleanup. The controller owns the staged observer
through the declaration-private, version-pinned SDK `startWithChildForTest`
constructor after the existing installed-SDK hash prerequisite and TEST package
checks. The default startup still uses the ordinary public SDK `start` path.
Observer close 0/no signal/all three pipes and SDK closure share one 1200ms deadline;
SDK graceful cleanup alone cannot authorize final receipt collection. Release
polling and the at-most1500ms probe retain the original conservative reconnect
deadline, issued lease and 3000ms budgets. There is no automatic default promotion.
The instrumented package remains build-only TEST evidence and requires the
external package erratum that records the failed full Cargo gate. Focused
component checks do not accept R2, D2–D4 or the whole Meeting application.
Control-only `e2e/mac11d-control.proof.mjs` never starts
media and cannot accept these media scenarios.

An explicit private wheelhouse can supply offline TeamMem dependencies:

```sh
export MEETING_E2E_TEAMMEM_REPOSITORY=/absolute/path/to/teammem-checkout
npm run e2e -- --out /absolute/evidence/offline --dependency-wheelhouse /absolute/private/dependencies
npm run e2e -- --out /absolute/evidence/package-refusals --only-refusals --package-refusals
```

The wheelhouse requires a closed `teammem-dependency-wheelhouse/v1` manifest,
validated wheel identities/hashes and an owned private directory. Pip consumes
an independently validated private snapshot, with no index or ambient pip config.
Omitting the option preserves the existing dependency path. Package refusal cuts
record prerequisite checks separately from unmodified main-loader checks; a
masked static-schema refusal or unexecuted lazy launcher remains incomplete.

These sources are unaccepted WIP. Actual SDK/media integration, D3 recovery and
D4 capacity/package acceptance still require their matrix evidence on a host that
permits localhost listeners and shipped macOS filesystem admission.

### Prepared R1 recovery cut

```sh
node e2e/recovery-run.mjs --out /absolute/evidence/r1 # fresh directory; optional --keep
node e2e/recovery-run.mjs --out /absolute/evidence/r1-warning-crash --warning-cut accepted-before-store-crash
node e2e/recovery-run.mjs --out /absolute/evidence/r1-warning-sql --warning-cut acceptance-transaction-abort
```

This test-only controller uses the built application's real admission, SQLite,
Runtime and maintenance workers. It drives a positive meeting end, fails the
initial builder through one external provider 503, waits for confirmed owned
process cleanup, then kills the actual app owner before a canonical artifact
exists. It reopens the same private state and encrypted source, advances only
the maintenance deadline clock through the original endedAt+11d and +14d
boundaries, and injects one failure before the real warning adapter's file fsync.
The cut requires persisted warning retry and acceptance, one physical warning
file, and governed encrypted-source deletion; Runtime operation time remains
monotonic and real. Failed attempts preserve their private root and evidence.

The explicit `accepted-before-store-crash` variant holds the real filesystem
sink receipt before SQLite acceptance, verifies the admitted owner's source,
claim and process inventory, then kills and reaps that app. A dedicated reopen
polls idle at the persisted claim expiry minus one millisecond and replays at
the exact expiry, requiring the same file name, bytes, hash, device and inode
before continuing to the original source expiry. The default warning cut remains
`before-file-fsync`.
`e2e/warning-commit-cut.test.ts` separately executes a component subprocess
crash/replay proof with synthetic recording/capability metadata and the real
migrated store, warning worker and sink. That leaf proof is not application
admission, Runtime authentication or R1 integration evidence.

The explicit `acceptance-transaction-abort` variant installs a scoped test-only
SQLite AFTER UPDATE trigger after the actual application's seed reaches its
original warning boundary. The unmodified sink durably accepts the file, then
the real store's acceptance statement aborts and the real worker persists a
pending retry. The fault is explicitly cleared after verification; a dedicated
application reopen polls idle at persisted retry minus one millisecond and
accepts at that exact retry, retaining the same bytes/hash/device/inode before
the original source expiry. This injects a SQLite statement/acceptance-transaction
abort, not a low-level COMMIT or disk fsync failure. The worker catches its SQL
exception; the prepared application evidence records the installed fault and
persisted reschedule, while `e2e/warning-store-fault.test.ts` separately proves
the exact exception and rollback with synthetic component seed metadata.

This is unaccepted source preparation. A passing scoped cut does not establish
the complete R1 matrix, common privacy/K4 evidence, other recovery/custody fault
variants, publication, or real-device readiness. The host must permit localhost
TCP listeners, shipped macOS filesystem admission and `/bin/ps` process
inventory. Any of these restrictions can prevent reaching the first seed;
reaping a known child alone does not prove complete descendant cleanup.

## Running the tests

Node24 is the verified local environment. SDK-dependent test/typecheck/build/start
require the actual reviewed `@conversation/runtime` package. The optional peer
prevents an unpublished package registry fetch; it does **not** make that
prerequisite optional. `npm ci` removes a prior local bootstrap.

### Local SDK bootstrap

Use an existing Runtime checkout path, but package only the immutable reviewed
tree; never copy a concurrent worktree's `dist` or install a source alias. The
pin is Runtime commit `316a3f6` (tree `dd73d353`) on `feat/meeting-online-profile`,
a reviewed local commit not yet on a reviewed remote.

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH # macOS Homebrew Node24, if needed
: "${RUNTIME_REPO:?Set the local Runtime checkout path}"
SDK_STAGE=$(mktemp -d)
mkdir "$SDK_STAGE/runtime"
git -C "$RUNTIME_REPO" archive 316a3f6017aa483bc13af845d1049924fac62d01 | tar -x -C "$SDK_STAGE/runtime"
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
not just version0.1.0, and requires both timed start commands and the SDK's
`stopIfActive`. Registry publication remains a separate gate. The
`StdioGatewayTransport` owns bounded EOF/TERM/KILL/reap cleanup and reports its
cleanup outcome; Meeting application composition remains separate. `start --standalone-config <file>` composes the live graph,
while the no-argument legacy entry still fails closed; a successful prerequisite check does not start a meeting.
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
same immutable source, built from the same `316a3f6` commit staged above. Build
it before starting the unchanged test deadlines:

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

When TeamMem refuses a revision for good it writes
`<receipts>/<segment>/<revision>.refused.json` (`teammem-meeting-refusal/v1`).
The outbox reads it only for a pending, unpublished row with the exact
occurrence, revision and artifact hash, and only when no matching receipt
exists. The row then keeps TeamMem's reason code (migration 031), stops
counting retries and is rechecked only at the 60 s retry cap. The organizer
gets nothing, since no URL was published.

A complete revision refused for quoting its own transcript
(`transcript_text_in_note`) is re-synthesised once: the refusal and a due
backfill job for the next revision commit together, and that build tells the
synthesis never to quote the transcript verbatim. This raises no operator
alert. Every other refusal, and a second own-transcript refusal for the same
occurrence, stays terminal and raises one operator alert file
(`meeting-publication-refusal-alert/v1`, identity, hash and reason code only)
in `outbox/operator-warnings/`; the refusal is recorded only after that file is
durable. An incomplete revision's own retry also gets the no-quote instruction.
A higher revision publishes and cleans the refused one only when one is built:
by that one re-synthesis or by an incomplete transcript's retry. An exact
receipt for a refused revision (the producer cleared its refusal) is still
accepted. Any publication of the occurrence removes its refusal alert files.
Retention still ends at `ended_at + 14 days`.

Before a bundle exists, the builder applies TeamMem's text rules. Names, titles,
project names and model names admit no control character. Prose keeps tab, LF
and CR. A stray control character from the summary model or a display name is
removed (a line break or tab in a name becomes a space). A name that is blank
or `.`/`..` after that gets a fixed fallback: the title becomes `Meeting
<meeting number>`, a display name `Participant`, a project `Unnamed project`,
a model name `unknown`. Each repaired field counts in one `text_normalized`
processing warning. Person ids get no fallback. `enqueue` refuses any artifact
that still breaks the rules, so TeamMem never quarantines it unseen.

These library paths are not yet selected by a shipped application lifecycle.
Application composition and human live checks remain separate gates; no live
provider/device/TeamMem or whole-application E2E proof is implied here.

### Timed live evidence library

The reviewed SDK adapter accepts the discriminated
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
