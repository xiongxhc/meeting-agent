# Audio custody at the TeamMem handoff

The original encrypted Runtime recording and the outbox bundle's `audio.enc`
are separate files. TeamMem imports the inbox copy, archives its metadata,
and zeroes that copy's inode. Its publication receipt may arrive later.

Meeting treats an existing zero-byte, regular inbox audio file as a consumed
copy only when the bundle's exact canonical `meeting.json`, manifest and empty
`READY` still match the durable delivery journal. Every member and directory
must pass the existing path and file checks. The separate original recording
must still match its Runtime handle, byte count and hash. Meeting never
recreates a consumed inbox copy.

Consumption alone cannot publish a meeting or send a notification. A canonical
TeamMem receipt must match the occurrence, revision and artifact hash and name
a valid commit-specific Markdown URL. Publication and the organizer's durable
notification intent commit atomically. For consumed bundles, this transaction
also revalidates original-recording ownership and any immutable backfill seed.

The seeded delivery handoff atomically advances `finalizing` to
`awaiting_teammem` with its durable intent and lifecycle ownership transfer.
Verified replay repairs older intents that missed that edge. A receipt still
cannot publish from arbitrary session states.

A delivery previously marked `recovery_unavailable` can recover only with
that matching receipt and verified consumed-bundle state. Missing originals,
conflicting owners, altered metadata, symlinks and nonempty corrupt inbox audio
remain refused. Receipt delay is retryable; it does not create a terminal
recovery failure.

Retention is unchanged: complete-transcript publication authorizes the existing
cleanup path; an incomplete original remains until the existing deadline.
No new acknowledgement, consumer storage access or bundle schema is introduced.

A pending delivery does no I/O before its retry time. While it only waits for
a receipt, Meeting checks that the READY bundle still exists; the encrypted
recording is read and hashed again only to rebuild a missing bundle or to
accept a receipt. A transient read or store error (for example a permission,
descriptor or disk error) backs off for one to sixty seconds and never makes
the delivery terminal. Only parse, path and integrity failures do, and they
report `delivery_recovery_unavailable` to the maintenance lane. State changes
are logged as static `delivery_*` codes.

An unpublished `delivery_journal` row whose occurrence has a published row with
a higher revision is superseded: it stops polling, logs `delivery_superseded`
once per process start, and keeps its last `retry_reason` and
`next_retry_at_ms`, so a past retry time on such a row is expected rather than
a stalled delivery. Its recording and bundle keep their custody and are deleted
at `ended_at + 14 days`, or earlier when a complete revision of the same
occurrence publishes.

A recording that no delivery row, delivery recording owner, backfill seed or
unknown-end custody row covers still has a deadline. This happens when stop or
finalize fails, when the finalize transaction fails, or when the process stops
mid-meeting. The Runtime creates `<handle>.crsr` under its final name when the
recording starts and appends to it in place, so a crash leaves a partial file
under that name. At composition start and on every custody-lane tick, Meeting
records each such file in `recording_retention` with a fixed deadline of its
last write, never later than first detection, plus 14 days, and never less
than 72 hours after first detection. It deletes the file at that deadline
through the identity-checked tombstone operation.

The 72-hour floor matters on the first start after this table exists, and
after a long outage. Files whose window already ended are adopted, not
deleted, and the sweep reports one `retention_grace_applied` warning with
their count in the maintenance status. The operator has 72 hours to inspect
the recordings directory before they go. It never deletes while a live occurrence could still be writing or
reading the file, and a file a covering policy later claims is released to
that policy. The same sweep fails `joining`/`listening` sessions and closes
open capture generations that no live occurrence owns, so their evidence gets
its normal 14-day expiry.

A revision TeamMem refuses for good (its `<revision>.refused.json` record)
keeps its custody unchanged: the encrypted recording and bundle stay until
`ended_at + 14 days` or a later complete publication. The failure behaviour is:

| Failure | Required behaviour |
|---|---|
| TeamMem refuses a revision for good | Record the reason code and stop retrying it. A complete revision refused for quoting its own transcript is re-synthesised once into the next revision with a no-quotation instruction. Any other refusal, or a second one, raises one operator alert with the reason code. The organizer is notified only when a later revision publishes. |

Regression evidence for it lives in `test/publication-refusal.test.ts` and the
refusal cases of `test/application-maintenance.test.ts`.

Regression evidence lives in `test/outbox-worker.test.ts` (D033 cases) and
`test/backfill-journal-handoff.test.ts` (atomic handoff and legacy repair),
`test/outbox-retry-gate.test.ts` (retry gate and transient errors) and
`test/recording-retention.test.ts` (uncovered recordings and open captures).
The publishing `e2e/run.mjs` command exercises the real TeamMem importer and
the shipped Feishu sender against local scripted peers; it requires one sent
intent and one DM with the matching UUID, organizer and published note URL.
