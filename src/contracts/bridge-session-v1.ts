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
  | { type: "media_disconnected"; reason: string }
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
  | readonly string[];

/**
 * Ties the runtime field tables to the compile-time unions: one entry per member
 * type, and exactly the payload fields that member declares. A dropped variant,
 * an extra variant, or a renamed field is a type error rather than a silent
 * drift the `as` casts in the parsers would hide.
 */
type PayloadFieldSpecs<U extends { type: string }> = {
  [K in U["type"]]: Record<
    Exclude<keyof Extract<U, { type: K }>, "type">,
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
  if (spec === "positive_int") {
    if (!Number.isInteger(value) || (value as number) < 1) {
      return { code: "field_type", path, detail: "expected an integer >= 1" };
    }
    return null;
  }
  const unreachable: never = spec;
  throw new Error(`unhandled field spec: ${String(unreachable)}`);
}

function checkShape(
  input: unknown,
  envelope: Record<string, FieldSpec>,
  payloads: Record<string, Record<string, FieldSpec>>,
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

  for (const key of Object.keys(record)) {
    if (key === "schema" || key === "type") continue;
    if (Object.hasOwn(envelope, key) || Object.hasOwn(payload, key)) continue;
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
  const failure = checkShape(input, COMMAND_ENVELOPE, COMMAND_PAYLOADS);
  if (failure !== null) return { ok: false, rejection: failure };
  return { ok: true, value: input as BridgeCommandMessage };
}

/** Pure per-message shape check for a bridge-to-coordinator event. */
export function parseEventShape(input: unknown): BridgeResult<BridgeEventMessage> {
  const failure = checkShape(input, EVENT_ENVELOPE, EVENT_PAYLOADS);
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
