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

Regression evidence lives in `test/outbox-worker.test.ts` (D033 cases) and
`test/backfill-journal-handoff.test.ts` (atomic handoff and legacy repair).
The publishing `e2e/run.mjs` command exercises the real TeamMem importer and
the shipped Feishu sender against local scripted peers; it requires one sent
intent and one DM with the matching UUID, organizer and published note URL.
