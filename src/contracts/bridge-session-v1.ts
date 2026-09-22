/**
 * bridge-session/v1 — derived TypeScript view of the frozen bridge contract.
 *
 * The normative definition is `protocols/bridge-session-v1.schema.json` plus the
 * canonical bytes in `fixtures/contracts/bridge-session-v1.json`. This module and
 * the Swift bridge structs are two views of those same bytes; the tests validate
 * this view against the fixture read from disk and against the schema itself,
 * which is what keeps them aligned.
 *
 * Fail-closed rules encoded here:
 *   - an unrecognised `schema` value is rejected, never upgraded or ignored;
 *   - unknown fields are rejected, never passed through — including fields named
 *     after `Object.prototype` members;
 *   - `sequence` is strictly increasing per session (gaps allowed, repeats and
 *     regressions rejected);
 *   - speaker identity is never guessed: `ui_exact` requires a user id and
 *     `ambiguous` requires a null user id;
 *   - a `command_result` may only name a command this session actually issued.
 */

export const BRIDGE_SESSION_SCHEMA = "bridge-session/v1";

export type BridgeCommand =
  | { type: "join"; meetingOccurrenceId: string; meetingNo: string; leaseId: string }
  | { type: "connect_media"; endpoint: string; sessionToken: string; format: string; expiresAt: string }
  | { type: "post_disclosure"; text: string }
  | { type: "leave"; reason: "meeting_ended" | "coordinator_stop" }
  | { type: "release_lease"; leaseId: string };

/**
 * D029 §1: the producer's claim that the encrypted recorder drained every
 * ordered record through its declared boundary. Two shapes, not a struct with
 * three independent members: a boundary exists exactly when the drain is
 * confirmed, a reason exactly when it is not, so the combination the validator
 * rejects is unrepresentable here too.
 *
 * Integers travel as canonical decimal strings, the spelling the timed lease
 * already uses, because a capture epoch or output sample can exceed 2^53. An
 * absent final capture frame is spelled `"0"` in both frame members, exactly
 * the zero-frame body the media-v3 codec puts on the wire; a real frame
 * sequence is never 0.
 */
export type CaptureDrainBoundary = {
  captureEpoch: string;
  lastFrameSequence: string;
  outputEndSample: string;
  finalClockPairSequence: string;
};
export type CaptureDrain =
  | { drain: "confirmed"; reason: null; boundary: CaptureDrainBoundary }
  | { drain: "unconfirmed"; reason: string; boundary: null };

export type BridgeEvent =
  | { type: "joined"; meetingOccurrenceId: string }
  | { type: "left"; reason: "ended" | "removed" | "bridge_failure" }
  | { type: "participant_joined"; feishuUserId: string; displayName: string }
  | { type: "participant_left"; feishuUserId: string }
  // Split into the two legal shapes so the type cannot express the combination
  // the schema and the validator both reject: speaker identity is never guessed.
  | { type: "active_speaker"; feishuUserId: string; confidence: "ui_exact" }
  | { type: "active_speaker"; feishuUserId: null; confidence: "ambiguous" }
  | { type: "audio_gap"; direction: "capture" | "playback"; startedAt: string; endedAt: string | null }
  | { type: "chat_disclosure"; outcome: "sent" | "unavailable" | "failed" }
  | { type: "media_connected"; endpoint: string }
  | { type: "media_disconnected"; reason: string; captureDrain?: CaptureDrain }
  | { type: "command_result"; commandId: string; outcome: "ok" | "rejected" | "failed"; detail: string | null }
  | { type: "reconnecting"; attempt: number }
  | { type: "reconnected"; attempt: number };

/** A command as it appears on the wire: envelope fields plus one payload. */
export type BridgeCommandMessage = {
  schema: typeof BRIDGE_SESSION_SCHEMA;
  sessionId: string;
  commandId: string;
} & BridgeCommand;

/** An event as it appears on the wire: envelope fields plus one payload. */
export type BridgeEventMessage = {
  schema: typeof BRIDGE_SESSION_SCHEMA;
  sessionId: string;
  sequence: number;
  observedAt: string;
} & BridgeEvent;

/** Machine-readable rejection reasons. Consumers classify on `code`, not on prose. */
export type BridgeRejectionCode =
  | "not_an_object"
  | "schema_unknown"
  | "unknown_type"
  | "missing_field"
  | "unknown_field"
  | "field_type"
  | "enum_value"
  | "timestamp_format"
  | "media_format"
  | "speaker_identity_required"
  | "speaker_identity_forbidden"
  | "session_mismatch"
  | "sequence_duplicate"
  | "sequence_out_of_order"
  | "unknown_command_id";

export type BridgeRejection = {
  code: BridgeRejectionCode;
  /** JSON pointer to the offending member; "" when the whole message is wrong. */
  path: string;
  detail: string;
};

export type BridgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; rejection: BridgeRejection };

type FieldSpec =
  | "string"
  | "nullable_string"
  | "utc_timestamp"
  | "nullable_utc_timestamp"
  | "positive_int"
  | "media_format"
  | "capture_drain"
  | readonly string[];

/**
 * Ties the runtime field tables to the compile-time unions: one entry per member
 * type, and exactly the payload fields that member declares. A dropped variant,
 * an extra variant, or a renamed field is a type error rather than a silent
 * drift the `as` casts in the parsers would hide.
 */
type RequiredPayloadKeys<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? never : K;
}[keyof T];
type OptionalPayloadKeys<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? K : never;
}[keyof T];
type PayloadFieldSpecs<U extends { type: string }> = {
  [K in U["type"]]: Record<
    Exclude<RequiredPayloadKeys<Extract<U, { type: K }>>, "type">,
    FieldSpec
  >;
};
/** The same tie for members a variant declares optional: a payload that omits
 * one is complete, but a payload that carries one is still checked, and an
 * undeclared optional member is a type error rather than a silently ignored
 * field. */
type OptionalPayloadFieldSpecs<U extends { type: string }> = {
  [K in U["type"]]: Record<
    Exclude<OptionalPayloadKeys<Extract<U, { type: K }>>, "type">,
    FieldSpec
  >;
};

// Declaration order here is the contract's canonical order and must match the
// oneOf order in protocols/bridge-session-v1.schema.json.
const COMMAND_PAYLOADS = {
  join: {
    meetingOccurrenceId: "string",
    meetingNo: "string",
    leaseId: "string",
  },
  connect_media: {
    endpoint: "string",
    sessionToken: "string",
    format: "media_format",
    expiresAt: "utc_timestamp",
  },
  post_disclosure: { text: "string" },
  leave: { reason: ["meeting_ended", "coordinator_stop"] },
  release_lease: { leaseId: "string" },
} as const satisfies PayloadFieldSpecs<BridgeCommand>;

const EVENT_PAYLOADS = {
  joined: { meetingOccurrenceId: "string" },
  left: { reason: ["ended", "removed", "bridge_failure"] },
  participant_joined: { feishuUserId: "string", displayName: "string" },
  participant_left: { feishuUserId: "string" },
  active_speaker: {
    feishuUserId: "nullable_string",
    confidence: ["ui_exact", "ambiguous"],
  },
  audio_gap: {
    direction: ["capture", "playback"],
    startedAt: "utc_timestamp",
    endedAt: "nullable_utc_timestamp",
  },
  chat_disclosure: { outcome: ["sent", "unavailable", "failed"] },
  media_connected: { endpoint: "string" },
  media_disconnected: { reason: "string" },
  command_result: {
    commandId: "string",
    outcome: ["ok", "rejected", "failed"],
    detail: "nullable_string",
  },
  reconnecting: { attempt: "positive_int" },
  reconnected: { attempt: "positive_int" },
} as const satisfies PayloadFieldSpecs<BridgeEvent>;

// D029 §1: additive and optional. A media-v2 producer omits the member and its
// bytes stay exactly the frozen fixtures/contracts/bridge-session-v1.json shape;
// an explicit null is a different wire shape and is not admitted.
const EVENT_OPTIONAL_PAYLOADS = {
  joined: {}, left: {}, participant_joined: {}, participant_left: {},
  active_speaker: {}, audio_gap: {}, chat_disclosure: {}, media_connected: {},
  media_disconnected: { captureDrain: "capture_drain" },
  command_result: {}, reconnecting: {}, reconnected: {},
} as const satisfies OptionalPayloadFieldSpecs<BridgeEvent>;

const COMMAND_OPTIONAL_PAYLOADS = {
  join: {}, connect_media: {}, post_disclosure: {}, leave: {}, release_lease: {},
} as const satisfies OptionalPayloadFieldSpecs<BridgeCommand>;

const COMMAND_ENVELOPE = {
  sessionId: "string",
  commandId: "string",
} as const satisfies Record<string, FieldSpec>;

const EVENT_ENVELOPE = {
  sessionId: "string",
  sequence: "positive_int",
  observedAt: "utc_timestamp",
} as const satisfies Record<string, FieldSpec>;

export const BRIDGE_COMMAND_TYPES: readonly string[] =
  Object.keys(COMMAND_PAYLOADS);
export const BRIDGE_EVENT_TYPES: readonly string[] = Object.keys(EVENT_PAYLOADS);

const UTC_TIMESTAMP =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$/;

// The four-part PCM stream shape <encoding>/<sampleRate>/<channels>/<frameMs>ms,
// character for character the `mediaFormat` pattern in
// protocols/bridge-session-v1.schema.json. It lives here because this validator,
// not the schema, is what runs: Ajv is a test-only dependency, so a format only
// the schema refuses is a format that still reaches the bridge — and
// AudioFormat.parse in bridges/mac/Sources/FeishuBridgeSpike/AudioBridge.swift
// refuses anything outside this grammar rather than substituting a default,
// so the coordinator would be opening a session the bridge can only reject.
// The obsolete three-part form "opus/48000/2" is the concrete value this
// rejects; it was in the frozen bytes before the fixture was re-cut.
const MEDIA_FORMAT = /^[^/]+\/[1-9][0-9]*\/[1-9][0-9]*\/[1-9][0-9]*ms$/;

function reject(
  code: BridgeRejectionCode,
  path: string,
  detail: string,
): { ok: false; rejection: BridgeRejection } {
  return { ok: false, rejection: { code, path, detail } };
}

function checkField(
  spec: FieldSpec,
  value: unknown,
  path: string,
): BridgeRejection | null {
  if (typeof spec !== "string") {
    if (typeof value !== "string") {
      return { code: "field_type", path, detail: "expected a string" };
    }
    if (!spec.includes(value)) {
      return {
        code: "enum_value",
        path,
        detail: `expected one of: ${spec.join(", ")}`,
      };
    }
    return null;
  }
  if (spec === "string" || spec === "nullable_string") {
    if (value === null && spec === "nullable_string") return null;
    if (typeof value !== "string" || value === "") {
      return { code: "field_type", path, detail: "expected a non-empty string" };
    }
    return null;
  }
  if (spec === "utc_timestamp" || spec === "nullable_utc_timestamp") {
    if (value === null && spec === "nullable_utc_timestamp") return null;
    if (typeof value !== "string") {
      return { code: "field_type", path, detail: "expected a string" };
    }
    if (!UTC_TIMESTAMP.test(value)) {
      return {
        code: "timestamp_format",
        path,
        detail: "expected a Z-suffixed UTC timestamp",
      };
    }
    return null;
  }
  if (spec === "media_format") {
    if (typeof value !== "string") {
      return { code: "field_type", path, detail: "expected a string" };
    }
    if (!MEDIA_FORMAT.test(value)) {
      return {
        code: "media_format",
        path,
        detail: "expected <encoding>/<sampleRate>/<channels>/<frameMs>ms",
      };
    }
    return null;
  }
  if (spec === "capture_drain") return checkCaptureDrain(value, path);
  if (spec === "positive_int") {
    if (!Number.isInteger(value) || (value as number) < 1) {
      return { code: "field_type", path, detail: "expected an integer >= 1" };
    }
    return null;
  }
  const unreachable: never = spec;
  throw new Error(`unhandled field spec: ${String(unreachable)}`);
}

/** A canonical decimal u64 as a string: the timed lease's own spelling. A JSON
 * number is refused outright rather than range-checked, because above 2^53 it
 * is already lossy by the time this sees it. */
const CANONICAL_UINT64 = /^(0|[1-9][0-9]*)$/;
function boundaryInteger(value: unknown): bigint | null {
  if (typeof value !== "string" || !CANONICAL_UINT64.test(value) || value.length > 20) return null;
  const parsed = BigInt(value);
  return parsed > 18_446_744_073_709_551_615n ? null : parsed;
}

function checkCaptureDrain(value: unknown, path: string): BridgeRejection | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { code: "field_type", path, detail: "expected a JSON object" };
  }
  const drain = value as Record<string, unknown>;
  for (const key of ["drain", "reason", "boundary"]) {
    if (!Object.hasOwn(drain, key)) {
      return { code: "missing_field", path: `${path}/${key}`, detail: `${key} is required` };
    }
  }
  for (const key of Object.keys(drain)) {
    if (key !== "drain" && key !== "reason" && key !== "boundary") {
      return { code: "unknown_field", path: `${path}/${key}`, detail: "unknown fields are rejected, not ignored" };
    }
  }
  if (drain["drain"] !== "confirmed" && drain["drain"] !== "unconfirmed") {
    return { code: "enum_value", path: `${path}/drain`, detail: "expected one of: confirmed, unconfirmed" };
  }
  const confirmed = drain["drain"] === "confirmed";
  // Boundary non-null iff confirmed, reason non-null iff not: the persisted row
  // is then unambiguous, and no producer can report a half-confirmed drain.
  if (confirmed !== (drain["boundary"] !== null)) {
    return { code: "field_type", path: `${path}/boundary`, detail: "boundary is present exactly when the drain is confirmed" };
  }
  if (confirmed !== (drain["reason"] === null)) {
    return { code: "field_type", path: `${path}/reason`, detail: "reason is present exactly when the drain is unconfirmed" };
  }
  if (!confirmed) {
    return typeof drain["reason"] === "string" && drain["reason"] !== ""
      ? null
      : { code: "field_type", path: `${path}/reason`, detail: "expected a non-empty string" };
  }
  const boundary = drain["boundary"];
  if (typeof boundary !== "object" || boundary === null || Array.isArray(boundary)) {
    return { code: "field_type", path: `${path}/boundary`, detail: "expected a JSON object" };
  }
  const members = boundary as Record<string, unknown>;
  const declared = ["captureEpoch", "lastFrameSequence", "outputEndSample", "finalClockPairSequence"] as const;
  for (const key of Object.keys(members)) {
    if (!(declared as readonly string[]).includes(key)) {
      return { code: "unknown_field", path: `${path}/boundary/${key}`, detail: "unknown fields are rejected, not ignored" };
    }
  }
  const parsed: Record<string, bigint> = {};
  for (const key of declared) {
    if (!Object.hasOwn(members, key)) {
      return { code: "missing_field", path: `${path}/boundary/${key}`, detail: `${key} is required` };
    }
    const number = boundaryInteger(members[key]);
    if (number === null) {
      return { code: "field_type", path: `${path}/boundary/${key}`, detail: "expected a canonical decimal unsigned integer as a string" };
    }
    parsed[key] = number;
  }
  if (parsed["captureEpoch"] === 0n || parsed["finalClockPairSequence"] === 0n) {
    return { code: "field_type", path: `${path}/boundary`, detail: "the capture epoch and final clock pair are >= 1" };
  }
  // Either the whole final frame or neither half of it; "0" is the codec's own
  // zero-frame spelling, never a partially observed frame.
  if ((parsed["lastFrameSequence"] === 0n) !== (parsed["outputEndSample"] === 0n)) {
    return { code: "field_type", path: `${path}/boundary/lastFrameSequence`, detail: "the final frame is either wholly present or spelled 0" };
  }
  return null;
}

function checkShape(
  input: unknown,
  envelope: Record<string, FieldSpec>,
  payloads: Record<string, Record<string, FieldSpec>>,
  optionals: Record<string, Record<string, FieldSpec>>,
): BridgeRejection | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { code: "not_an_object", path: "", detail: "expected a JSON object" };
  }
  const record = input as Record<string, unknown>;

  if (!Object.hasOwn(record, "schema")) {
    return { code: "missing_field", path: "/schema", detail: "schema is required" };
  }
  if (record["schema"] !== BRIDGE_SESSION_SCHEMA) {
    return {
      code: "schema_unknown",
      path: "/schema",
      detail: `expected ${BRIDGE_SESSION_SCHEMA}`,
    };
  }

  if (!Object.hasOwn(record, "type")) {
    return { code: "missing_field", path: "/type", detail: "type is required" };
  }
  const type = record["type"];
  if (typeof type !== "string" || !Object.hasOwn(payloads, type)) {
    return {
      code: "unknown_type",
      path: "/type",
      detail: `unrecognised type: ${String(type)}`,
    };
  }
  const payload = payloads[type] as Record<string, FieldSpec>;
  const optional = (optionals[type] ?? {}) as Record<string, FieldSpec>;

  // Object.hasOwn throughout: `in` walks the prototype chain, which would let a
  // field named toString, constructor or __proto__ pass as a declared one.
  for (const [key, spec] of [
    ...Object.entries(envelope),
    ...Object.entries(payload),
  ]) {
    if (!Object.hasOwn(record, key)) {
      return { code: "missing_field", path: `/${key}`, detail: `${key} is required` };
    }
    const failure = checkField(spec, record[key], `/${key}`);
    if (failure !== null) return failure;
  }

  // Optional members are checked when present. An omitted member is a producer
  // making no claim; an explicitly null one is a claim this grammar has no
  // spelling for, so it is refused by the member's own check.
  for (const [key, spec] of Object.entries(optional)) {
    if (!Object.hasOwn(record, key)) continue;
    const failure = checkField(spec, record[key], `/${key}`);
    if (failure !== null) return failure;
  }

  for (const key of Object.keys(record)) {
    if (key === "schema" || key === "type") continue;
    if (Object.hasOwn(envelope, key) || Object.hasOwn(payload, key) || Object.hasOwn(optional, key)) continue;
    return {
      code: "unknown_field",
      path: `/${key}`,
      detail: "unknown fields are rejected, not ignored",
    };
  }

  if (type === "active_speaker") {
    const speaker = record["feishuUserId"];
    if (record["confidence"] === "ui_exact" && speaker === null) {
      return {
        code: "speaker_identity_required",
        path: "/feishuUserId",
        detail: "ui_exact requires an observed user id",
      };
    }
    if (record["confidence"] === "ambiguous" && speaker !== null) {
      return {
        code: "speaker_identity_forbidden",
        path: "/feishuUserId",
        detail: "ambiguous must stay anonymous; speaker identity is never guessed",
      };
    }
  }

  return null;
}

/** Pure per-message shape check for a coordinator-to-bridge command. */
export function parseCommandShape(
  input: unknown,
): BridgeResult<BridgeCommandMessage> {
  const failure = checkShape(input, COMMAND_ENVELOPE, COMMAND_PAYLOADS, COMMAND_OPTIONAL_PAYLOADS);
  if (failure !== null) return { ok: false, rejection: failure };
  return { ok: true, value: input as BridgeCommandMessage };
}

/** Pure per-message shape check for a bridge-to-coordinator event. */
export function parseEventShape(input: unknown): BridgeResult<BridgeEventMessage> {
  const failure = checkShape(input, EVENT_ENVELOPE, EVENT_PAYLOADS, EVENT_OPTIONAL_PAYLOADS);
  if (failure !== null) return { ok: false, rejection: failure };
  return { ok: true, value: input as BridgeEventMessage };
}

/**
 * Session-scoped stream validator. Shape checks alone cannot catch duplicate
 * sequences or a command_result for a command nobody issued, so the stream
 * rules live here over per-session state.
 */
export interface BridgeSessionValidator {
  readonly sessionId: string;
  acceptCommand(input: unknown): BridgeResult<BridgeCommandMessage>;
  acceptEvent(input: unknown): BridgeResult<BridgeEventMessage>;
}

export function createBridgeSessionValidator(
  sessionId: string,
): BridgeSessionValidator {
  const issued = new Set<string>();
  let lastSequence = 0;

  return {
    sessionId,

    acceptCommand(input) {
      const parsed = parseCommandShape(input);
      if (!parsed.ok) return parsed;
      if (parsed.value.sessionId !== sessionId) {
        return reject(
          "session_mismatch",
          "/sessionId",
          `expected session ${sessionId}`,
        );
      }
      issued.add(parsed.value.commandId);
      return parsed;
    },

    acceptEvent(input) {
      const parsed = parseEventShape(input);
      if (!parsed.ok) return parsed;
      const event = parsed.value;

      if (event.sessionId !== sessionId) {
        return reject(
          "session_mismatch",
          "/sessionId",
          `expected session ${sessionId}`,
        );
      }
      if (event.sequence === lastSequence) {
        return reject(
          "sequence_duplicate",
          "/sequence",
          `sequence ${event.sequence} was already observed`,
        );
      }
      if (event.sequence < lastSequence) {
        return reject(
          "sequence_out_of_order",
          "/sequence",
          `sequence ${event.sequence} is behind ${lastSequence}`,
        );
      }
      if (event.type === "command_result" && !issued.has(event.commandId)) {
        return reject(
          "unknown_command_id",
          "/commandId",
          `no command ${event.commandId} was issued in this session`,
        );
      }

      lastSequence = event.sequence;
      return parsed;
    },
  };
}
