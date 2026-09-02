import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

import type {
  BridgeRejection,
  BridgeRejectionCode,
  BridgeResult,
  BridgeSessionValidator,
} from "../src/protocol.ts";
import {
  BRIDGE_COMMAND_TYPES,
  BRIDGE_EVENT_TYPES,
  BRIDGE_SESSION_SCHEMA,
  createBridgeSessionValidator,
} from "../src/protocol.ts";
import { createJsonlRecorder } from "../src/recorder.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const FIXTURE_PATH = path.join(
  REPO_ROOT,
  "fixtures/contracts/bridge-session-v1.json",
);
const SCHEMA_PATH = path.join(
  REPO_ROOT,
  "protocols/bridge-session-v1.schema.json",
);

type WireMessage = Record<string, unknown>;

type FixtureDoc = {
  schema: string;
  sessionId: string;
  commands: WireMessage[];
  events: WireMessage[];
};

type SchemaVariant = {
  required: string[];
  properties: { type: { const: string } };
};

type SchemaDoc = {
  $id: string;
  $defs: {
    command: { oneOf: SchemaVariant[] };
    event: { oneOf: SchemaVariant[] };
  };
};

// The fixture bytes and the schema bytes on disk are the frozen contract. Every
// assertion below derives from those bytes, never from an in-memory literal, so
// that breaking either one breaks the suite.
const fixtureSource = readFileSync(FIXTURE_PATH, "utf8");
const schemaSource = readFileSync(SCHEMA_PATH, "utf8");
const fixture = JSON.parse(fixtureSource) as FixtureDoc;
const schemaDoc = JSON.parse(schemaSource) as SchemaDoc;

// The normative document is executed as a schema, not merely inspected: a
// regression in a pattern, a minimum, an additionalProperties or the never-guess
// if/then block has to fail here rather than pass silently.
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(JSON.parse(schemaSource) as object);
const validateDocument = ajv.getSchema(schemaDoc.$id);
if (validateDocument === undefined) {
  throw new Error(`schema did not register under its $id: ${schemaDoc.$id}`);
}
const validateCommand = ajv.compile({ $ref: `${schemaDoc.$id}#/$defs/command` });
const validateEvent = ajv.compile({ $ref: `${schemaDoc.$id}#/$defs/event` });

function commandOfType(type: string, nth = 0): WireMessage {
  const found = fixture.commands.filter((c) => c["type"] === type)[nth];
  if (found === undefined) {
    throw new Error(`fixture is missing a "${type}" command (#${nth})`);
  }
  return structuredClone(found);
}

function eventOfType(type: string, nth = 0): WireMessage {
  const found = fixture.events.filter((e) => e["type"] === type)[nth];
  if (found === undefined) {
    throw new Error(`fixture is missing a "${type}" event (#${nth})`);
  }
  return structuredClone(found);
}

/** A validator that has already seen every command the fixture issues. */
function primedValidator(): BridgeSessionValidator {
  const validator = createBridgeSessionValidator(fixture.sessionId);
  for (const command of fixture.commands) {
    const result = validator.acceptCommand(structuredClone(command));
    if (!result.ok) {
      throw new Error(
        `fixture command rejected: ${result.rejection.code} at ${result.rejection.path}`,
      );
    }
  }
  return validator;
}

function rejectionOf(result: BridgeResult<unknown>): BridgeRejection {
  if (result.ok) {
    throw new Error("expected a rejection, got ok");
  }
  return result.rejection;
}

// ---------------------------------------------------------------------------
// The contract's shape: union, schema and fixture agree
// ---------------------------------------------------------------------------

// The fixture is ordered as a session actually unfolds and carries more than one
// instance of the types whose wire shape varies, so coverage is asserted as
// "every declared type appears at least once, and no undeclared type appears".
test("bridge fixture covers every command type and every event type", () => {
  deepStrictEqual(
    [...new Set(fixture.commands.map((c) => c["type"]))].sort(),
    [...BRIDGE_COMMAND_TYPES].sort(),
  );
  deepStrictEqual(
    [...new Set(fixture.events.map((e) => e["type"]))].sort(),
    [...BRIDGE_EVENT_TYPES].sort(),
  );
  strictEqual(fixture.schema, BRIDGE_SESSION_SCHEMA);
});

test("bridge fixture carries canonical bytes for both never-guess shapes", () => {
  const exact = eventOfType("active_speaker", 0);
  strictEqual(exact["confidence"], "ui_exact");
  ok(typeof exact["feishuUserId"] === "string" && exact["feishuUserId"] !== "");

  const anonymous = eventOfType("active_speaker", 1);
  strictEqual(anonymous["confidence"], "ambiguous");
  strictEqual(anonymous["feishuUserId"], null);

  const closedGap = eventOfType("audio_gap", 0);
  ok(typeof closedGap["endedAt"] === "string");
  const openGap = eventOfType("audio_gap", 1);
  strictEqual(openGap["endedAt"], null);
});

test("bridge schema file and validator agree on the type sets", () => {
  deepStrictEqual(
    schemaDoc.$defs.command.oneOf.map((v) => v.properties.type.const),
    [...BRIDGE_COMMAND_TYPES],
  );
  deepStrictEqual(
    schemaDoc.$defs.event.oneOf.map((v) => v.properties.type.const),
    [...BRIDGE_EVENT_TYPES],
  );
});

test("bridge schema required fields match the fixture message shape", () => {
  const variantFor = (variants: SchemaVariant[], type: unknown): SchemaVariant => {
    const found = variants.find((v) => v.properties.type.const === type);
    if (found === undefined) {
      throw new Error(`schema has no variant for "${String(type)}"`);
    }
    return found;
  };

  for (const command of fixture.commands) {
    deepStrictEqual(
      [...variantFor(schemaDoc.$defs.command.oneOf, command["type"]).required].sort(),
      Object.keys(command).sort(),
    );
  }
  for (const event of fixture.events) {
    deepStrictEqual(
      [...variantFor(schemaDoc.$defs.event.oneOf, event["type"]).required].sort(),
      Object.keys(event).sort(),
    );
  }
});

// ---------------------------------------------------------------------------
// The normative schema, executed
// ---------------------------------------------------------------------------

test("bridge fixture document validates against the normative schema", () => {
  const valid = validateDocument(JSON.parse(fixtureSource));
  strictEqual(valid, true, JSON.stringify(validateDocument.errors));
});

test("bridge every fixture message validates against the normative schema", () => {
  for (const command of fixture.commands) {
    strictEqual(
      validateCommand(structuredClone(command)),
      true,
      JSON.stringify(validateCommand.errors),
    );
  }
  for (const event of fixture.events) {
    strictEqual(
      validateEvent(structuredClone(event)),
      true,
      JSON.stringify(validateEvent.errors),
    );
  }
});

test("bridge fixture replays clean through the session validator", () => {
  const validator = createBridgeSessionValidator(fixture.sessionId);
  for (const command of fixture.commands) {
    const result = validator.acceptCommand(structuredClone(command));
    strictEqual(result.ok, true, JSON.stringify(result));
  }
  let previous = 0;
  for (const event of fixture.events) {
    const result = validator.acceptEvent(structuredClone(event));
    strictEqual(result.ok, true, JSON.stringify(result));
    const sequence = event["sequence"];
    ok(typeof sequence === "number" && sequence > previous);
    previous = sequence;
  }
});

// ---------------------------------------------------------------------------
// Shape-level rejections: the validator AND the normative schema must reject
// ---------------------------------------------------------------------------

type ShapeCase = {
  name: string;
  kind: "command" | "event";
  code: BridgeRejectionCode;
  path: string;
  build: () => WireMessage;
};

const shapeCases: ShapeCase[] = [
  {
    name: "an unknown schema version",
    kind: "event",
    code: "schema_unknown",
    path: "/schema",
    build: () => ({ ...eventOfType("joined"), schema: "bridge-session/v2" }),
  },
  {
    name: "a joined event with a missing meetingOccurrenceId",
    kind: "event",
    code: "missing_field",
    path: "/meetingOccurrenceId",
    build: () => {
      const event = eventOfType("joined");
      delete event["meetingOccurrenceId"];
      return event;
    },
  },
  {
    name: "a join command with a missing meetingOccurrenceId",
    kind: "command",
    code: "missing_field",
    path: "/meetingOccurrenceId",
    build: () => {
      const command = commandOfType("join");
      delete command["meetingOccurrenceId"];
      return command;
    },
  },
  {
    name: "active_speaker ui_exact without a user id",
    kind: "event",
    code: "speaker_identity_required",
    path: "/feishuUserId",
    build: () => ({ ...eventOfType("active_speaker", 0), feishuUserId: null }),
  },
  {
    name: "active_speaker ambiguous carrying a guessed user id",
    kind: "event",
    code: "speaker_identity_forbidden",
    path: "/feishuUserId",
    build: () => ({
      ...eventOfType("active_speaker", 1),
      feishuUserId: "ou_000000000000000000000000000001",
    }),
  },
  {
    name: "connect_media without a session token",
    kind: "command",
    code: "missing_field",
    path: "/sessionToken",
    build: () => {
      const command = commandOfType("connect_media");
      delete command["sessionToken"];
      return command;
    },
  },
  {
    name: "connect_media with an empty session token",
    kind: "command",
    code: "field_type",
    path: "/sessionToken",
    build: () => ({ ...commandOfType("connect_media"), sessionToken: "" }),
  },
  {
    name: "an unknown event field",
    kind: "event",
    code: "unknown_field",
    path: "/speakerGuess",
    build: () => ({ ...eventOfType("joined"), speakerGuess: "someone" }),
  },
  {
    name: "an unknown command field",
    kind: "command",
    code: "unknown_field",
    path: "/force",
    build: () => ({ ...commandOfType("leave"), force: true }),
  },
  {
    // `in` walks the prototype chain; Object.hasOwn does not. Without the fix a
    // field named after an Object.prototype member smuggles itself through.
    name: "an event field named toString",
    kind: "event",
    code: "unknown_field",
    path: "/toString",
    build: () => ({ ...eventOfType("joined"), toString: "smuggled" }),
  },
  {
    name: "a command field named constructor",
    kind: "command",
    code: "unknown_field",
    path: "/constructor",
    build: () => ({ ...commandOfType("leave"), constructor: "smuggled" }),
  },
  {
    name: "an unknown event type",
    kind: "event",
    code: "unknown_type",
    path: "/type",
    build: () => ({ ...eventOfType("joined"), type: "speaker_guessed" }),
  },
  {
    name: "a non-UTC observedAt",
    kind: "event",
    code: "timestamp_format",
    path: "/observedAt",
    build: () => ({
      ...eventOfType("joined"),
      observedAt: "2026-09-02T14:00:00+08:00",
    }),
  },
  {
    name: "a reconnecting attempt below one",
    kind: "event",
    code: "field_type",
    path: "/attempt",
    build: () => ({ ...eventOfType("reconnecting"), attempt: 0 }),
  },
];

for (const shapeCase of shapeCases) {
  test(`bridge rejects ${shapeCase.name} (validator and schema)`, () => {
    const validator = primedValidator();
    const message = shapeCase.build();
    const result =
      shapeCase.kind === "command"
        ? validator.acceptCommand(message)
        : validator.acceptEvent(message);
    const rejection = rejectionOf(result);
    strictEqual(rejection.code, shapeCase.code);
    strictEqual(rejection.path, shapeCase.path);

    const schemaAccepts =
      shapeCase.kind === "command"
        ? validateCommand(shapeCase.build())
        : validateEvent(shapeCase.build());
    strictEqual(
      schemaAccepts,
      false,
      "the normative schema must reject it too, or the two views disagree",
    );
  });
}

test("bridge accepts active_speaker ambiguous with a null user id", () => {
  const validator = createBridgeSessionValidator(fixture.sessionId);
  const event = eventOfType("active_speaker", 1);
  strictEqual(event["feishuUserId"], null);
  strictEqual(validator.acceptEvent(event).ok, true);
  strictEqual(validateEvent(eventOfType("active_speaker", 1)), true);
});

// ---------------------------------------------------------------------------
// Stream-level rejections: valid JSON, rejected only by per-session state
// ---------------------------------------------------------------------------

test("bridge rejects a duplicate sequence (schema-valid, stream-invalid)", () => {
  const validator = createBridgeSessionValidator(fixture.sessionId);
  strictEqual(validator.acceptEvent(eventOfType("joined")).ok, true);
  const repeat = eventOfType("joined");
  strictEqual(validateEvent(structuredClone(repeat)), true);
  const rejection = rejectionOf(validator.acceptEvent(repeat));
  strictEqual(rejection.code, "sequence_duplicate");
  strictEqual(rejection.path, "/sequence");
});

test("bridge rejects an out-of-order sequence (schema-valid, stream-invalid)", () => {
  const validator = createBridgeSessionValidator(fixture.sessionId);
  strictEqual(validator.acceptEvent(eventOfType("participant_joined")).ok, true);
  const behind = eventOfType("joined");
  strictEqual(validateEvent(structuredClone(behind)), true);
  const rejection = rejectionOf(validator.acceptEvent(behind));
  strictEqual(rejection.code, "sequence_out_of_order");
  strictEqual(rejection.path, "/sequence");
});

test("bridge rejects an event belonging to another session", () => {
  const validator = createBridgeSessionValidator(fixture.sessionId);
  const event = { ...eventOfType("joined"), sessionId: "sess_0000000000000002" };
  strictEqual(validateEvent(structuredClone(event)), true);
  const rejection = rejectionOf(validator.acceptEvent(event));
  strictEqual(rejection.code, "session_mismatch");
  strictEqual(rejection.path, "/sessionId");
});

test("bridge rejects a command_result for an unknown commandId", () => {
  const validator = primedValidator();
  const event = { ...eventOfType("command_result"), commandId: "cmd_9999" };
  strictEqual(validateEvent(structuredClone(event)), true);
  const rejection = rejectionOf(validator.acceptEvent(event));
  strictEqual(rejection.code, "unknown_command_id");
  strictEqual(rejection.path, "/commandId");
});

test("bridge accepts a command_result for a commandId it saw issued", () => {
  const validator = primedValidator();
  strictEqual(validator.acceptEvent(eventOfType("command_result")).ok, true);
});

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

test("bridge recorder emits byte-identical JSONL under a fixed clock", () => {
  const stamp = "2026-09-02T14:00:00.000Z";
  const render = (): string => {
    const recorder = createJsonlRecorder({
      clock: { now: () => stamp },
      validator: createBridgeSessionValidator(fixture.sessionId),
    });
    for (const command of fixture.commands) {
      strictEqual(recorder.recordCommand(structuredClone(command)).ok, true);
    }
    for (const event of fixture.events) {
      strictEqual(recorder.recordEvent(structuredClone(event)).ok, true);
    }
    return recorder.toJsonl();
  };

  const first = render();
  strictEqual(first, render());

  const lines = first.split("\n").filter((line) => line !== "");
  strictEqual(lines.length, fixture.commands.length + fixture.events.length);
  strictEqual(
    lines[0],
    JSON.stringify({
      recordedAt: stamp,
      direction: "command",
      message: fixture.commands[0],
    }),
  );
  strictEqual(
    lines[fixture.commands.length],
    JSON.stringify({
      recordedAt: stamp,
      direction: "event",
      message: fixture.events[0],
    }),
  );
  ok(first.endsWith("\n"));
});

test("bridge recorder records nothing for a rejected message", () => {
  const recorder = createJsonlRecorder({
    clock: { now: () => "2026-09-02T14:00:00.000Z" },
    validator: createBridgeSessionValidator(fixture.sessionId),
  });
  const event = { ...eventOfType("joined"), schema: "bridge-session/v2" };
  strictEqual(rejectionOf(recorder.recordEvent(event)).code, "schema_unknown");
  strictEqual(recorder.toJsonl(), "");
});

test("bridge recorder keeps prototype-named fields out of the evidence", () => {
  const recorder = createJsonlRecorder({
    clock: { now: () => "2026-09-02T14:00:00.000Z" },
    validator: createBridgeSessionValidator(fixture.sessionId),
  });
  const event = { ...eventOfType("joined"), toString: "smuggled" };
  strictEqual(rejectionOf(recorder.recordEvent(event)).code, "unknown_field");
  strictEqual(recorder.toJsonl(), "");
  ok(!recorder.toJsonl().includes("smuggled"));
});

test("bridge recorder does not expose its evidence log for mutation", () => {
  const recorder = createJsonlRecorder({
    clock: { now: () => "2026-09-02T14:00:00.000Z" },
    validator: createBridgeSessionValidator(fixture.sessionId),
  });
  strictEqual(recorder.recordEvent(eventOfType("joined")).ok, true);
  const before = recorder.toJsonl();

  const snapshot = recorder.records() as unknown[];
  snapshot.push({ forged: true });

  strictEqual(recorder.records().length, 1);
  strictEqual(recorder.toJsonl(), before);
  ok(!recorder.toJsonl().includes("forged"));
});
