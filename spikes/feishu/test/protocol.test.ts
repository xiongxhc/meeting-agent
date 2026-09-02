import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import type {
  BridgeRejection,
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

type SchemaVariant = { properties: { type: { const: string } } };

type SchemaDoc = {
  $defs: {
    command: { oneOf: SchemaVariant[] };
    event: { oneOf: SchemaVariant[] };
  };
};

// The fixture bytes on disk are the frozen contract. Every assertion below
// derives from these bytes, never from an in-memory literal, so that breaking
// the fixture breaks the suite.
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as FixtureDoc;
const schemaDoc = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as SchemaDoc;

function commandOfType(type: string): WireMessage {
  const found = fixture.commands.find((c) => c["type"] === type);
  if (found === undefined) {
    throw new Error(`fixture is missing a "${type}" command`);
  }
  return structuredClone(found);
}

function eventOfType(type: string): WireMessage {
  const found = fixture.events.find((e) => e["type"] === type);
  if (found === undefined) {
    throw new Error(`fixture is missing a "${type}" event`);
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

function rejectionOf<T>(result: BridgeResult<T>): BridgeRejection {
  if (result.ok) {
    throw new Error("expected a rejection, got ok");
  }
  return result.rejection;
}

// The fixture is ordered as a session actually unfolds, not in declaration
// order, so coverage is compared as a sorted set: every declared type appears
// exactly once and no undeclared type sneaks in.
test("bridge fixture covers every command type and every event type", () => {
  deepStrictEqual(
    fixture.commands.map((c) => c["type"]).sort(),
    [...BRIDGE_COMMAND_TYPES].sort(),
  );
  deepStrictEqual(
    fixture.events.map((e) => e["type"]).sort(),
    [...BRIDGE_EVENT_TYPES].sort(),
  );
  strictEqual(fixture.schema, BRIDGE_SESSION_SCHEMA);
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

// Closes the loop between the three artefacts: the schema's required list must
// equal the fixture message's own keys, and the validator is separately proven
// (below) to accept exactly the fixture and to reject any added or missing key.
test("bridge schema required fields match the fixture message shape", () => {
  const variantFor = (
    variants: SchemaVariant[],
    type: unknown,
  ): SchemaVariant & { required: string[] } => {
    const found = variants.find((v) => v.properties.type.const === type);
    if (found === undefined) {
      throw new Error(`schema has no variant for "${String(type)}"`);
    }
    return found as SchemaVariant & { required: string[] };
  };

  for (const command of fixture.commands) {
    deepStrictEqual(
      variantFor(schemaDoc.$defs.command.oneOf, command["type"]).required.sort(),
      Object.keys(command).sort(),
    );
  }
  for (const event of fixture.events) {
    deepStrictEqual(
      variantFor(schemaDoc.$defs.event.oneOf, event["type"]).required.sort(),
      Object.keys(event).sort(),
    );
  }
});

test("bridge rejects an unknown schema version", () => {
  const validator = createBridgeSessionValidator(fixture.sessionId);
  const event = eventOfType("joined");
  event["schema"] = "bridge-session/v2";
  const rejection = rejectionOf(validator.acceptEvent(event));
  strictEqual(rejection.code, "schema_unknown");
  strictEqual(rejection.path, "/schema");
});

test("bridge rejects a duplicate sequence", () => {
  const validator = createBridgeSessionValidator(fixture.sessionId);
  strictEqual(validator.acceptEvent(eventOfType("joined")).ok, true);
  const rejection = rejectionOf(validator.acceptEvent(eventOfType("joined")));
  strictEqual(rejection.code, "sequence_duplicate");
  strictEqual(rejection.path, "/sequence");
});

test("bridge rejects an out-of-order sequence", () => {
  const validator = createBridgeSessionValidator(fixture.sessionId);
  strictEqual(
    validator.acceptEvent(eventOfType("participant_joined")).ok,
    true,
  );
  const rejection = rejectionOf(validator.acceptEvent(eventOfType("joined")));
  strictEqual(rejection.code, "sequence_out_of_order");
  strictEqual(rejection.path, "/sequence");
});

test("bridge rejects a joined event with a missing meetingOccurrenceId", () => {
  const validator = createBridgeSessionValidator(fixture.sessionId);
  const event = eventOfType("joined");
  delete event["meetingOccurrenceId"];
  const rejection = rejectionOf(validator.acceptEvent(event));
  strictEqual(rejection.code, "missing_field");
  strictEqual(rejection.path, "/meetingOccurrenceId");
});

test("bridge rejects a join command with a missing meetingOccurrenceId", () => {
  const validator = createBridgeSessionValidator(fixture.sessionId);
  const command = commandOfType("join");
  delete command["meetingOccurrenceId"];
  const rejection = rejectionOf(validator.acceptCommand(command));
  strictEqual(rejection.code, "missing_field");
  strictEqual(rejection.path, "/meetingOccurrenceId");
});

test("bridge rejects active_speaker ui_exact without a user id", () => {
  const validator = createBridgeSessionValidator(fixture.sessionId);
  const event = eventOfType("active_speaker");
  strictEqual(event["confidence"], "ui_exact");
  event["feishuUserId"] = null;
  const rejection = rejectionOf(validator.acceptEvent(event));
  strictEqual(rejection.code, "speaker_identity_required");
  strictEqual(rejection.path, "/feishuUserId");
});

test("bridge accepts active_speaker ambiguous with a null user id", () => {
  const validator = createBridgeSessionValidator(fixture.sessionId);
  const event = eventOfType("active_speaker");
  event["confidence"] = "ambiguous";
  event["feishuUserId"] = null;
  strictEqual(validator.acceptEvent(event).ok, true);
});

test("bridge rejects active_speaker ambiguous carrying a guessed user id", () => {
  const validator = createBridgeSessionValidator(fixture.sessionId);
  const event = eventOfType("active_speaker");
  event["confidence"] = "ambiguous";
  const rejection = rejectionOf(validator.acceptEvent(event));
  strictEqual(rejection.code, "speaker_identity_forbidden");
  strictEqual(rejection.path, "/feishuUserId");
});

test("bridge rejects connect_media without a session token", () => {
  const missing = commandOfType("connect_media");
  delete missing["sessionToken"];
  strictEqual(
    rejectionOf(
      createBridgeSessionValidator(fixture.sessionId).acceptCommand(missing),
    ).code,
    "missing_field",
  );

  const empty = commandOfType("connect_media");
  empty["sessionToken"] = "";
  const rejection = rejectionOf(
    createBridgeSessionValidator(fixture.sessionId).acceptCommand(empty),
  );
  strictEqual(rejection.code, "field_type");
  strictEqual(rejection.path, "/sessionToken");
});

test("bridge rejects a command_result for an unknown commandId", () => {
  const validator = primedValidator();
  const event = eventOfType("command_result");
  event["commandId"] = "cmd_never_issued";
  const rejection = rejectionOf(validator.acceptEvent(event));
  strictEqual(rejection.code, "unknown_command_id");
  strictEqual(rejection.path, "/commandId");
});

test("bridge accepts a command_result for a commandId it saw issued", () => {
  const validator = primedValidator();
  strictEqual(validator.acceptEvent(eventOfType("command_result")).ok, true);
});

test("bridge rejects an unknown event field rather than passing it through", () => {
  const validator = createBridgeSessionValidator(fixture.sessionId);
  const event = eventOfType("joined");
  event["speakerGuess"] = "someone";
  const rejection = rejectionOf(validator.acceptEvent(event));
  strictEqual(rejection.code, "unknown_field");
  strictEqual(rejection.path, "/speakerGuess");
});

test("bridge rejects an unknown command field rather than passing it through", () => {
  const validator = createBridgeSessionValidator(fixture.sessionId);
  const command = commandOfType("leave");
  command["force"] = true;
  const rejection = rejectionOf(validator.acceptCommand(command));
  strictEqual(rejection.code, "unknown_field");
  strictEqual(rejection.path, "/force");
});

test("bridge rejects an unknown event type", () => {
  const validator = createBridgeSessionValidator(fixture.sessionId);
  const event = eventOfType("joined");
  event["type"] = "speaker_guessed";
  const rejection = rejectionOf(validator.acceptEvent(event));
  strictEqual(rejection.code, "unknown_type");
  strictEqual(rejection.path, "/type");
});

test("bridge rejects an event belonging to another session", () => {
  const validator = createBridgeSessionValidator(fixture.sessionId);
  const event = eventOfType("joined");
  event["sessionId"] = "sess_0000000000000002";
  const rejection = rejectionOf(validator.acceptEvent(event));
  strictEqual(rejection.code, "session_mismatch");
  strictEqual(rejection.path, "/sessionId");
});

test("bridge rejects a non-UTC observedAt", () => {
  const validator = createBridgeSessionValidator(fixture.sessionId);
  const event = eventOfType("joined");
  event["observedAt"] = "2026-09-02T14:00:00+08:00";
  const rejection = rejectionOf(validator.acceptEvent(event));
  strictEqual(rejection.code, "timestamp_format");
  strictEqual(rejection.path, "/observedAt");
});

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
  const event = eventOfType("joined");
  event["schema"] = "bridge-session/v2";
  strictEqual(rejectionOf(recorder.recordEvent(event)).code, "schema_unknown");
  strictEqual(recorder.toJsonl(), "");
});
