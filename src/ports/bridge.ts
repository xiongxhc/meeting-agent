// The bridge control plane: a PORT over the frozen bridge-session/v1 contract.
//
// THE STRUCTURAL PROPERTY THIS FILE EXISTS FOR: an audio frame cannot reach the
// coordinator by any path.
//
// The Swift bridge made a frame inexpressible on its control plane -- frames
// travel on the media socket the runtime opens, and the command/event enum
// simply has no member that could carry one. This port makes the same property
// true on the TypeScript side, and it does it by REUSING the frozen contract
// rather than restating it:
//
//   - outbound, the only thing a caller may send is a `BridgeCommand` from
//     src/contracts/bridge-session-v1.ts. That union has five members (join,
//     connect_media, post_disclosure, leave, release_lease) and no member with
//     a bytes-shaped field. A frame is a type error, not a convention.
//   - inbound, the transport hands over RAW `unknown`. Nothing typed crosses
//     into the session until it has passed the frozen validator's
//     `acceptEvent`, whose type table is closed: a frame-shaped message is
//     rejected as `unknown_type` at the boundary and never becomes a value the
//     session can route.
//
// So the guarantee does not rest on this module being careful. It rests on the
// contract's two closed unions being the only vocabulary in either direction.
//
// This module deliberately imports NOTHING from the Conversation Runtime port.
// That is what makes "only the bridge may attempt chat" structural: a
// disclosure publisher built here is handed one capability -- issue a
// BridgeCommand -- and the runtime is not in its scope to call, so no branch
// of the disclosure path can synthesize a spoken disclosure. See
// createDisclosurePublisher.

import type {
  BridgeCommand,
  BridgeCommandMessage,
  BridgeEventMessage,
} from "../contracts/bridge-session-v1.ts";

export type {
  BridgeCommand,
  BridgeCommandMessage,
  BridgeEvent,
  BridgeEventMessage,
  BridgeRejection,
  BridgeRejectionCode,
} from "../contracts/bridge-session-v1.ts";

/**
 * The wire transport to one bridge session. Envelope construction, contract
 * validation and sequence checking all live ABOVE this port (in the meeting
 * session) so that a transport implementation -- a websocket, a child process,
 * a test fake -- cannot skip them.
 *
 * `send` takes an already-validated command message. `subscribe` delivers raw
 * inbound bytes-as-parsed-JSON: deliberately `unknown`, never a typed event,
 * so that the frozen validator is the only door into the session.
 */
export type BridgeTransport = {
  send(message: BridgeCommandMessage): Promise<void>;
  /** Returns an unsubscribe function. Calling it must stop delivery. */
  subscribe(listener: (raw: unknown) => void): () => void;
  /** Called once when the bridge can no longer deliver anything (its process
   * ended), after every message it did deliver. Returns an unsubscribe. */
  onClosed?(listener: () => void): () => void;
};

/** Raised when a message the coordinator was about to send, or a message the
 * bridge sent, does not satisfy bridge-session/v1. Carries the contract's own
 * machine-readable rejection code; never carries transcript text or audio. */
export class BridgeContractError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(direction: "command" | "event", code: string, path: string, detail: string) {
    super(`bridge-session/v1 rejected an outgoing ${direction} [${code}] at "${path}": ${detail}`);
    this.name = "BridgeContractError";
    this.code = code;
    this.path = path;
  }
}

/** The three outcomes bridge-session/v1 defines for a disclosure attempt. */
export type DisclosureOutcome = "sent" | "unavailable" | "failed";

/**
 * Publishes the meeting-chat disclosure, and nothing else.
 *
 * Constructed with ONE capability: a function that issues a BridgeCommand.
 * The Conversation Runtime is not a parameter, is not imported by this module,
 * and is therefore not reachable from any branch here -- which is how "only the
 * bridge may attempt chat, and no branch may synthesize a spoken disclosure"
 * is enforced structurally rather than by review. The outcome is not returned:
 * it arrives later as a `chat_disclosure` event, and failing to disclose never
 * blocks joining, so there is nothing here for a caller to await or retry on.
 */
export type DisclosurePublisher = {
  publish(text: string): Promise<void>;
};

export function createDisclosurePublisher(
  issue: (command: BridgeCommand) => Promise<void>,
): DisclosurePublisher {
  return {
    async publish(text: string): Promise<void> {
      await issue({ type: "post_disclosure", text });
    },
  };
}

/** A `command_result` correlated back to the command that provoked it. */
export type BridgeCommandResult = {
  readonly commandId: string;
  readonly commandType: BridgeCommand["type"] | null;
  readonly outcome: "ok" | "rejected" | "failed";
  readonly detail: string | null;
};

/** An `audio_gap` exactly as the bridge observed it. Never rounded, merged, or
 * re-derived -- see the meeting session's gap handling. */
export type ObservedAudioGap = {
  readonly direction: "capture" | "playback";
  readonly startedAt: string;
  readonly endedAt: string | null;
};

/** Narrowing helper for a routed event; `BridgeEventMessage` is a union whose
 * members share the envelope. */
export type BridgeEventOf<T extends BridgeEventMessage["type"]> = Extract<
  BridgeEventMessage,
  { type: T }
>;
