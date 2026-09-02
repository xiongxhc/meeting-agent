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
  | { recordedAt: string; direction: "command"; message: BridgeCommandMessage }
  | { recordedAt: string; direction: "event"; message: BridgeEventMessage };

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

  return {
    recordCommand(input) {
      const result = validator.acceptCommand(input);
      if (result.ok) {
        records.push({
          recordedAt: clock.now(),
          direction: "command",
          message: result.value,
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
          message: result.value,
        });
      }
      return result;
    },

    records() {
      return [...records];
    },

    toJsonl() {
      return records.map((record) => `${JSON.stringify(record)}\n`).join("");
    },
  };
}
