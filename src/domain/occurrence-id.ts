// Occurrence identity: the single most load-bearing module in the Meeting
// Agent core, because session rows, artifact identity, outbox directory
// names, receipt filenames, and the organizer-notification idempotency key
// all key off it.
//
// This module must match TeamMem's Python implementation byte for byte. The
// frozen cross-repository schema is
// <notes>/teammem-meeting-v1/teammem-meeting-v1.md,
// "Occurrence identity" section:
//
//   logical (JSON):  <meeting-id>@<UTC start>
//   path / URL:      <encoded meeting-id>_<compact>
//
//   f"{urllib.parse.quote(meeting_id, safe='')}_{start.strftime('%Y%m%dT%H%M%SZ')}"
//
// encodeURIComponent is NOT equivalent to urllib.parse.quote(safe=''):
// Python additionally escapes `!`, `*`, `'`, `(`, `)`, which encodeURIComponent
// leaves unescaped. TeamMem's bundle loader rejects a bundle whose directory
// segment does not equal the segment derived from occurrence_id, so drifting
// from Python here silently quarantines every artifact for an affected
// meeting -- see the parity test in test/occurrence-id.test.ts.

import { createHash } from "node:crypto";

/** Logical occurrence identity: `<provider meeting id>@<UTC occurrence start>`. */
export type OccurrenceId = `${string}@${string}`;

// Whole-second UTC instant with a literal "Z", no fractional seconds and no
// offset -- matches the schema's rule that started_at (and therefore the
// instant inside occurrence_id) always carries whole seconds, because it is
// the source of the compact path spelling.
const WHOLE_SECOND_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// Matches the logical form greedily from the left, so a meeting id that
// itself happens to contain "@" still splits correctly: the match only
// succeeds when what follows the LAST "@" is a valid whole-second UTC
// instant.
const OCCURRENCE_ID_PATTERN = /^(.+)@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/;

const COMPACT_INSTANT_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

// No control characters, per the schema's occurrence_id rule ("no control
// characters in the meeting id"): C0 controls (0x00-0x1F) and DEL (0x7F).
// Checked by char code rather than a regex control-character range, which
// eslint's no-control-regex (rightly) flags.
function containsControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Builds a validated OccurrenceId from a provider meeting id and a
 * whole-second UTC occurrence start instant (e.g. "2026-09-02T14:00:00Z").
 */
export function makeOccurrenceId(meetingId: string, startedAt: string): OccurrenceId {
  if (meetingId.length === 0) {
    throw new Error("occurrence id: meeting id must not be blank");
  }
  if (containsControlCharacter(meetingId)) {
    throw new Error("occurrence id: meeting id must not contain control characters");
  }
  if (!WHOLE_SECOND_UTC_INSTANT.test(startedAt)) {
    throw new Error(
      `occurrence id: startedAt must be a whole-second UTC instant like "2026-09-02T14:00:00Z", got "${startedAt}"`,
    );
  }
  // Date.parse normalizes impossible calendar fields (for example April 31)
  // on some engines. Construct from fields and require the canonical UTC
  // spelling to round-trip, so every accepted occurrence names a real instant.
  const parsedMs = Date.parse(startedAt);
  if (
    !Number.isFinite(parsedMs) ||
    new Date(parsedMs).toISOString().replace(".000Z", "Z") !== startedAt
  ) {
    throw new Error(`occurrence id: startedAt is not a real UTC instant: "${startedAt}"`);
  }
  return `${meetingId}@${startedAt}` as OccurrenceId;
}

function splitOccurrenceId(id: OccurrenceId): { meetingId: string; startedAt: string } {
  const match = OCCURRENCE_ID_PATTERN.exec(id);
  if (!match) {
    throw new Error(`invalid occurrence id: "${id}"`);
  }
  return { meetingId: match[1]!, startedAt: match[2]! };
}

/**
 * Percent-encodes a meeting id exactly as Python's
 * `urllib.parse.quote(meeting_id, safe='')` does. encodeURIComponent leaves
 * `! * ' ( )` unescaped; Python does not, so those five characters are
 * escaped again here, uppercase hex, to match byte for byte.
 */
function encodeMeetingIdSegment(meetingId: string): string {
  return encodeURIComponent(meetingId).replace(
    /[!*'()]/g,
    (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function toCompactInstant(startedAt: string): string {
  // "2026-09-02T14:00:00Z" -> "20260902T140000Z". startedAt is already
  // validated as whole-second UTC by makeOccurrenceId, so a plain
  // punctuation strip is exact and matches strftime('%Y%m%dT%H%M%SZ').
  return startedAt.replace(/[-:]/g, "");
}

function fromCompactInstant(compact: string): string {
  const match = COMPACT_INSTANT_PATTERN.exec(compact);
  if (!match) {
    throw new Error(`invalid compact instant: "${compact}"`);
  }
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}

/**
 * The filesystem/URL-safe form used for every path segment: TeamMem
 * inbox directory names, outbox directory names, receipt filenames, and the
 * short occurrence id. Round-trips exactly through parseOccurrencePathSegment.
 */
export function occurrencePathSegment(id: OccurrenceId): string {
  const { meetingId, startedAt } = splitOccurrenceId(id);
  return `${encodeMeetingIdSegment(meetingId)}_${toCompactInstant(startedAt)}`;
}

/**
 * Inverse of occurrencePathSegment. The separator is "_", but an encoded
 * meeting id can itself contain "_" (both encodeURIComponent and Python's
 * quote leave it unescaped) -- so this splits from the RIGHT, on the last
 * "_", since the compact instant suffix never itself contains "_".
 */
export function parseOccurrencePathSegment(segment: string): OccurrenceId {
  const lastUnderscore = segment.lastIndexOf("_");
  if (lastUnderscore === -1) {
    throw new Error(`invalid occurrence path segment (no "_" separator): "${segment}"`);
  }
  const encodedMeetingId = segment.slice(0, lastUnderscore);
  const compact = segment.slice(lastUnderscore + 1);
  if (encodedMeetingId.length === 0) {
    throw new Error(`invalid occurrence path segment (empty meeting id): "${segment}"`);
  }
  const startedAt = fromCompactInstant(compact);
  let meetingId: string;
  try {
    meetingId = decodeURIComponent(encodedMeetingId);
  } catch {
    throw new Error(`invalid occurrence path segment (bad percent encoding): "${segment}"`);
  }
  const occurrenceId = makeOccurrenceId(meetingId, startedAt);
  if (occurrencePathSegment(occurrenceId) !== segment) {
    throw new Error(`invalid occurrence path segment (noncanonical spelling): "${segment}"`);
  }
  return occurrenceId;
}

/**
 * The first 8 lowercase hex characters of sha256(<occurrence path segment>),
 * used in rendered note filenames and publication receipts. Hashes the
 * ENCODED segment, not the raw occurrence id, so it stays stable under the
 * encoding rule (per the schema document).
 */
export function shortOccurrenceId(id: OccurrenceId): string {
  const segment = occurrencePathSegment(id);
  return createHash("sha256").update(segment, "utf8").digest("hex").slice(0, 8);
}
