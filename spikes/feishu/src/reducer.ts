/**
 * Platform-neutral observation reducer for bridge-session/v1.
 *
 * Turns raw Feishu-client UI observations into the frozen `BridgeEvent` stream
 * declared in ./protocol.ts. This module is the reference implementation of the
 * ambiguity policy: a future Swift Mac bridge observes the real Feishu client
 * and maps its own accessibility/OCR output into the `UiObservation` shape
 * declared here, then defers every "is this speaker known or ambiguous"
 * decision to the same rules coded below. Nothing here is macOS-specific, and
 * nothing here reads a wall clock — every timestamp on an emitted event comes
 * from the observation that produced it.
 *
 * Ambiguity policy (the load-bearing part of this file):
 *   - exactly one highlighted tile, identity resolved   -> active_speaker ui_exact
 *   - exactly one highlighted tile, identity unresolved -> active_speaker ambiguous
 *   - two or more highlighted tiles (overlapping speech) -> active_speaker
 *     ambiguous, even when every tile's identity is individually resolvable —
 *     speaker identity is never guessed, and overlap means the UI cannot say
 *     who is speaking, not merely who is on screen.
 *   - a resolved speaker state is only re-emitted when it changes from the
 *     last one emitted, mirroring a UI whose highlight glow persists across
 *     frames until a different tile lights up.
 */

import type { BridgeEvent, BridgeEventMessage } from "./protocol.ts";
import { BRIDGE_SESSION_SCHEMA, parseEventShape } from "./protocol.ts";

/** One participant as the roster panel would show them at an instant. */
export interface RosterEntry {
  readonly feishuUserId: string;
  readonly displayName: string;
}

/**
 * A single instant of what the Feishu client UI showed: platform-neutral, no
 * accessibility node ids, no window handles, no pixel coordinates. A Mac
 * bridge maps its own observations into this shape before handing them to the
 * reducer — the reducer never maps the other way round.
 */
export type UiObservation =
  | {
      readonly kind: "speaker_highlight";
      readonly observedAt: string;
      /** Opaque tile identifiers currently showing the active-speaking highlight. */
      readonly highlightedTileIds: readonly string[];
    }
  | {
      readonly kind: "roster_snapshot";
      readonly observedAt: string;
      /** Every participant currently listed, independent of who spoke last. */
      readonly participants: readonly RosterEntry[];
    }
  | { readonly kind: "meeting_ended"; readonly observedAt: string }
  | {
      readonly kind: "disclosure_attempt";
      readonly observedAt: string;
      readonly text: string;
    };

/**
 * Resolves a highlighted tile to a participant identity. Stands in for image
 * recognition / OCR on the real client: a fake in tests and replay, a
 * Swift-backed adapter in the live bridge. Returning null means "could not
 * resolve" — a legal, expected answer, never a cue to guess.
 */
export interface SpeakerIdentityPort {
  identifyTile(tileId: string): { feishuUserId: string } | null;
}

/**
 * Attempts to post the disclosure text into the meeting chat. Stands in for
 * driving the real client's chat control: a fake in tests and replay, a
 * Swift-backed adapter in the live bridge. A missing or unreachable control
 * is a normal outcome ("unavailable"), never an exception, and the bridge
 * never blocks on it or speaks the disclosure instead.
 */
export interface ChatControlPort {
  postDisclosure(text: string): {
    outcome: "sent" | "unavailable" | "failed";
    detail: string | null;
  };
}

export interface ObservationReducer {
  readonly sessionId: string;
  /** Folds one observation into zero or more validated events, in order. */
  reduce(observation: UiObservation): readonly BridgeEventMessage[];
}

type ActiveSpeakerState =
  | { readonly feishuUserId: string; readonly confidence: "ui_exact" }
  | { readonly feishuUserId: null; readonly confidence: "ambiguous" };

function sameActiveSpeaker(
  previous: ActiveSpeakerState | null,
  next: ActiveSpeakerState,
): boolean {
  return (
    previous !== null &&
    previous.confidence === next.confidence &&
    previous.feishuUserId === next.feishuUserId
  );
}

/**
 * Builds a stateful reducer for one bridge session. State (last active
 * speaker, last known roster, next sequence number) lives in this closure —
 * it is what lets the reducer detect a speaker *switch* rather than just a
 * speaker *sighting*, and what lets sequence numbers come out monotonic.
 */
export function createObservationReducer(options: {
  sessionId: string;
  speakerIdentity: SpeakerIdentityPort;
  chatControl: ChatControlPort;
}): ObservationReducer {
  const { sessionId, speakerIdentity, chatControl } = options;
  let sequence = 0;
  let activeSpeaker: ActiveSpeakerState | null = null;
  let roster = new Map<string, string>();

  function emit(observedAt: string, payload: BridgeEvent): BridgeEventMessage {
    sequence += 1;
    const candidate: unknown = {
      schema: BRIDGE_SESSION_SCHEMA,
      sessionId,
      sequence,
      observedAt,
      ...payload,
    };
    const checked = parseEventShape(candidate);
    if (!checked.ok) {
      throw new Error(
        `reducer produced an event that fails its own contract: ` +
          `${checked.rejection.code} at ${checked.rejection.path} (${checked.rejection.detail})`,
      );
    }
    return checked.value;
  }

  function reduceSpeakerHighlight(
    observation: Extract<UiObservation, { kind: "speaker_highlight" }>,
  ): BridgeEventMessage[] {
    const { highlightedTileIds, observedAt } = observation;
    let next: ActiveSpeakerState | null = null;

    if (highlightedTileIds.length === 1) {
      const [tileId] = highlightedTileIds;
      if (tileId !== undefined) {
        const resolved = speakerIdentity.identifyTile(tileId);
        next =
          resolved === null
            ? { feishuUserId: null, confidence: "ambiguous" }
            : { feishuUserId: resolved.feishuUserId, confidence: "ui_exact" };
      }
    } else if (highlightedTileIds.length > 1) {
      // Overlapping highlights: never guess which of several known people is
      // speaking. This branch fires regardless of whether every tile resolves.
      next = { feishuUserId: null, confidence: "ambiguous" };
    }

    if (next === null || sameActiveSpeaker(activeSpeaker, next)) return [];
    activeSpeaker = next;
    return [emit(observedAt, { type: "active_speaker", ...next })];
  }

  function reduceRosterSnapshot(
    observation: Extract<UiObservation, { kind: "roster_snapshot" }>,
  ): BridgeEventMessage[] {
    const { participants, observedAt } = observation;
    const nextRoster = new Map(participants.map((p) => [p.feishuUserId, p.displayName] as const));
    const events: BridgeEventMessage[] = [];

    const leftIds = [...roster.keys()].filter((id) => !nextRoster.has(id)).sort();
    for (const feishuUserId of leftIds) {
      events.push(emit(observedAt, { type: "participant_left", feishuUserId }));
    }

    const joinedIds = [...nextRoster.keys()].filter((id) => !roster.has(id)).sort();
    for (const feishuUserId of joinedIds) {
      const displayName = nextRoster.get(feishuUserId);
      if (displayName === undefined) continue; // unreachable: id came from nextRoster's own keys
      events.push(emit(observedAt, { type: "participant_joined", feishuUserId, displayName }));
    }

    roster = nextRoster;
    return events;
  }

  function reduceMeetingEnded(
    observation: Extract<UiObservation, { kind: "meeting_ended" }>,
  ): BridgeEventMessage[] {
    return [emit(observation.observedAt, { type: "left", reason: "ended" })];
  }

  function reduceDisclosureAttempt(
    observation: Extract<UiObservation, { kind: "disclosure_attempt" }>,
  ): BridgeEventMessage[] {
    const result = chatControl.postDisclosure(observation.text);
    return [
      emit(observation.observedAt, { type: "chat_disclosure", outcome: result.outcome }),
    ];
  }

  return {
    sessionId,
    reduce(observation) {
      switch (observation.kind) {
        case "speaker_highlight":
          return reduceSpeakerHighlight(observation);
        case "roster_snapshot":
          return reduceRosterSnapshot(observation);
        case "meeting_ended":
          return reduceMeetingEnded(observation);
        case "disclosure_attempt":
          return reduceDisclosureAttempt(observation);
      }
    },
  };
}
