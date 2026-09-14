# Feishu invitation discovery

The public engine exports `createFeishuSdkHttp`, `createFeishuInviteIngress`,
`createFeishuOrganizerMetadata`, and `createInviteDiscovery`. These are real
SDK-backed components, tested against local HTTP/WebSocket peers and SQLite.
They are not yet wired into `main.ts`, the desktop bridge, or Runtime media.

## Explicit private configuration

Supply `region: "feishu" | "lark"`, `tenantKey`, `appId`, and an existing
`RedactedSecret` to the adapters. Choose the API region explicitly, not from the
installed desktop application's label. No secret is logged or stored in the
invitation journal; SDK logs are replaced with fixed codes. Keep all real IDs,
reservation metadata and the orchestration database private.

`references` is a bounded list of `OrganizerReferenceEntry` values. Each entry
has the same region/app/tenant plus a nine-digit `meetingNo` and exactly one:

- `{ kind: "reservation", reserveId }` obtained from actual creation metadata;
- `{ kind: "calendar_event", calendarId, eventId, occurrenceId,
  providerMeetingId, occurrenceStartedAt, vcOrganizerOpenId? }`, with explicit
  source-backed occurrence linkage. The optional VC organizer ID is only an
  additional equality check, never a fallback organizer.

The joining number selects a configured candidate; it proves no identity. For
reservations, the SDK reads the active meeting and checks exact ID/start/number
before reading reservation creator and Contact identity/display. Calendar lookup
uses the exact configured event and actual `event_organizer`; ambiguous recurrence
or conflicting VC identity blocks. All successful organizer IDs are app/tenant/
region-scoped `open_id`. Missing references, permissions or display names remain
`metadata_blocked`. Host, bot, inviter, attendees and titles are not substitutes.
No bot-join API is called to fetch metadata or acknowledge invitations.

## Composition and ownership

Create one shared `http = createFeishuSdkHttp()`. Pass it to metadata and ingress.
Create one `worker = createInviteDiscovery({ store, metadata })`. Pass
`accept: invite => { store.acceptInvite(invite, Date.now()); }` and
`stopWorker: () => worker.close()` to ingress. `await ingress.start()` waits for
the real SDK ready callback plus connected status, not merely resolved SDK
`start()`. Call `worker.runOnce()` from a separately owned scheduler only after
startup; each call handles at most one durable claim. Admission creates or
verifies a discovered session but never launches a bridge. Read/list persisted
admitted rows for recovery after a crash; terminal sessions must not rejoin.

On shutdown, stop scheduling new ticks, then await `ingress.close()`. It fences
new acceptances/socket creation synchronously, force-closes the SDK, aborts HTTP,
stops the worker and awaits owned work and actual socket closure. The public
Agent hook tracks upgraded sockets after `agentRemove`, not just the Agent pool.
Production uses HTTPS with ordinary TLS validation; injected HTTP agents are
only for controlled local tests. No global interceptors or SDK private state
are changed. On startup failure, the caller must still invoke close.

Only `clean: true` authorizes closing this component's database ownership.
`cleanup_timeout` is not clean: keep the store available while owned work may
still settle, fence the application, and report failure. Do not treat a repeated
cached close result, SDK idle status, or elapsed deadline as proof of settlement.
Other application database owners must also finish before closing a shared store.

## Bounds and replay

The journal uses migration020's two STRICT tables. One IMMEDIATE transaction
commits normalized invitation plus occurrence before the SDK ACK. Same event key
and hash replays; a changed hash rejects. Different events for the same occurrence
must match immutable scope/ID/start/number; the first title is retained.

Limits are 64KiB normalized UTF-8, identifiers1024 bytes, topic4096 bytes,
decimal times20 ASCII characters, 32 in-flight acceptance callbacks with no wait
queue, and256 unresolved occurrences including blocked/claimed rows. Oversize,
capacity, conflict and database errors produce failure ACKs, never ACK-and-drop.
Historical event audit disk growth is separate; no automatic deletion is added.

Metadata has one worker/one active HTTP request, a30s fenced claim, HTTP5s,
attempt20s including abort-settlement reserve, eight attempts per retry generation,
a10-minute durable horizon and jittered1s–60s retry delay. Startup15s, handshake5s,
close7s. Clock regressions block; counts stop at1,000,000. Smaller injectable
budgets support tests; larger values are rejected.

These are application bounds, NOT a whole-transport memory guarantee. The pinned
SDK1.74.0 logical-fragment DataCache and ACK buffers are outside these limits.
The ws8.21.3 security update does not fix that separate SDK cache limitation.
Local tests establish scoped behavior, not production hardening or live acceptance.

## Built operator commands

After `npm run build`, use an existing absolute private database path:

```sh
node dist/src/operator.js invite-metadata-status --db /private/path/orchestration.db --occurrence 'meeting-id@2026-09-02T14:00:00Z'
node dist/src/operator.js invite-metadata-retry --db /private/path/orchestration.db --occurrence 'meeting-id@2026-09-02T14:00:00Z' --operator operator-label
```

Retry only transitions a blocked occurrence with no session of any state and no
active claim. `pending` starts a fresh bounded generation; replay returns
`already_pending` without resetting a running claim. `counter_exhausted` leaves
the row blocked. Totals, old reasons, operator audit and event receipts remain.
These commands never load credentials, contact Feishu, inspect the desktop,
clear custody or launch anything. Status output contains private meeting metadata.

## Human prerequisites

Confirm selected-region long-connection entitlement, subscription to
`vc.bot.meeting_invited_v1`, actual app/tenant identity, and official API Explorer
permission/data ranges. Obtain the real reservation ID from creation metadata;
do not invent a meeting-number lookup. Separately provision an authorized Mac
desktop identity and measure how that identity receives/joins invitations.
The application bot is not a desktop login; API join does not supply raw audio.
Real invitation delivery, permissions and native participation remain untested.
