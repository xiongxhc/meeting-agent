/**
 * JSONL evidence recorder for bridge-session/v1.
 *
 * The clock is injected: nothing here calls Date.now(), so a fixed clock makes
 * the recorded bytes reproducible in tests and in replay. Nothing is recorded
 * until the session validator has accepted it, so a rejected message never
 * reaches the evidence file.
 */

import type {
  BridgeCommandMessage,
  BridgeEventMessage,
  BridgeResult,
  BridgeSessionValidator,
} from "./protocol.ts";

export interface BridgeClock {
  /** Current instant as a Z-suffixed UTC timestamp. */
  now(): string;
}

export type BridgeRecord =
  | { recordedAt: string; direction: "command"; message: EvidenceCommandMessage }
  | { recordedAt: string; direction: "event"; message: BridgeEventMessage };

/** A command shape safe to persist as evidence. Media credentials never leave memory. */
export type EvidenceCommandMessage =
  | Exclude<BridgeCommandMessage, { type: "connect_media" }>
  | Omit<Extract<BridgeCommandMessage, { type: "connect_media" }>, "sessionToken">;

export interface BridgeRecorder {
  recordCommand(input: unknown): BridgeResult<BridgeCommandMessage>;
  recordEvent(input: unknown): BridgeResult<BridgeEventMessage>;
  /** A snapshot copy; the internal evidence log is not exposed for mutation. */
  records(): readonly BridgeRecord[];
  /** One JSON object per line, trailing newline; "" when nothing was recorded. */
  toJsonl(): string;
}

export function createJsonlRecorder(options: {
  clock: BridgeClock;
  validator: BridgeSessionValidator;
}): BridgeRecorder {
  const { clock, validator } = options;
  const records: BridgeRecord[] = [];

  function snapshot<T>(value: T): T {
    return structuredClone(value);
  }

  function projectCommand(message: BridgeCommandMessage): EvidenceCommandMessage {
    if (message.type === "connect_media") {
      const redacted: Omit<Extract<BridgeCommandMessage, { type: "connect_media" }>, "sessionToken"> = {
        schema: message.schema,
        sessionId: message.sessionId,
        commandId: message.commandId,
        type: message.type,
        endpoint: message.endpoint,
        format: message.format,
        expiresAt: message.expiresAt,
      };
      return snapshot(redacted);
    }
    return snapshot(message);
  }

  return {
    recordCommand(input) {
      const result = validator.acceptCommand(input);
      if (result.ok) {
        records.push({
          recordedAt: clock.now(),
          direction: "command",
          message: projectCommand(result.value),
        });
      }
      return result;
    },

    recordEvent(input) {
      const result = validator.acceptEvent(input);
      if (result.ok) {
        records.push({
          recordedAt: clock.now(),
          direction: "event",
          message: snapshot(result.value),
        });
      }
      return result;
    },

    records() {
      return snapshot(records);
    },

    toJsonl() {
      return records.map((record) => `${JSON.stringify(record)}\n`).join("");
    },
  };
}
