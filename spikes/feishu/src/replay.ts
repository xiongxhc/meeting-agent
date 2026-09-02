/**
 * Deterministic replay harness for bridge-session/v1 UI observations.
 *
 * Feeds a fixture's ordered `UiObservation` frames through the observation
 * reducer (./reducer.ts) and returns the resulting ordered `BridgeEvent`
 * stream — the same output whether driven by `npm test` or by the CLI entry
 * point below, since neither path touches a live Feishu client, a wall clock,
 * or the network. The fixture itself supplies fake image-recognition
 * (`tileIdentities`) and chat-control (`chatControl`) behaviour, so the ports
 * the reducer depends on stay injected all the way out to this harness.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BridgeEventMessage } from "./protocol.ts";
import { createBridgeSessionValidator } from "./protocol.ts";
import type { BridgeClock } from "./recorder.ts";
import { createJsonlRecorder } from "./recorder.ts";
import type { ChatControlPort, SpeakerIdentityPort, UiObservation } from "./reducer.ts";
import { createObservationReducer } from "./reducer.ts";

/** Static per-tile identity table a fixture supplies for its fake image-recognition port. */
export type TileIdentityTable = Readonly<Record<string, { feishuUserId: string } | null>>;

export interface ObservationFixture {
  readonly sessionId: string;
  readonly tileIdentities: TileIdentityTable;
  readonly chatControl: { readonly available: boolean };
  readonly observations: readonly UiObservation[];
}

/** Reads and parses a recorded UI observation fixture from disk. */
export function loadObservationFixture(filePath: string): ObservationFixture {
  return JSON.parse(readFileSync(filePath, "utf8")) as ObservationFixture;
}

function fakeSpeakerIdentityPort(table: TileIdentityTable): SpeakerIdentityPort {
  return {
    identifyTile(tileId) {
      return table[tileId] ?? null;
    },
  };
}

function fakeChatControlPort(available: boolean): ChatControlPort {
  return {
    postDisclosure() {
      return available
        ? { outcome: "sent", detail: null }
        : { outcome: "unavailable", detail: "chat control not found in the meeting UI" };
    },
  };
}

/** Runs one fixture's observations through a fresh reducer; returns the ordered events. */
export function replayFixture(fixture: ObservationFixture): readonly BridgeEventMessage[] {
  const reducer = createObservationReducer({
    sessionId: fixture.sessionId,
    speakerIdentity: fakeSpeakerIdentityPort(fixture.tileIdentities),
    chatControl: fakeChatControlPort(fixture.chatControl.available),
  });
  const events: BridgeEventMessage[] = [];
  for (const observation of fixture.observations) {
    events.push(...reducer.reduce(observation));
  }
  return events;
}

/**
 * Replays a fixture and re-validates the output through the session-scoped
 * bridge-session/v1 validator before handing it to the JSONL recorder, so a
 * replay run proves the events are not just internally self-consistent but
 * pass the same fail-closed checks used on the wire. Evidence is
 * byte-identical for the same fixture and clock.
 */
export function replayFixtureToEvidence(fixture: ObservationFixture, clock: BridgeClock): string {
  const validator = createBridgeSessionValidator(fixture.sessionId);
  const recorder = createJsonlRecorder({ clock, validator });
  for (const event of replayFixture(fixture)) {
    const result = recorder.recordEvent(event);
    if (!result.ok) {
      throw new Error(
        `replay produced an event the session validator rejected: ` +
          `${result.rejection.code} at ${result.rejection.path} (${result.rejection.detail})`,
      );
    }
  }
  return recorder.toJsonl();
}

/**
 * A clock that never reads the wall clock: it starts at `startIso` and
 * advances by `stepMs` on every call after the first. Used by the CLI below
 * and by tests so replay evidence stays reproducible byte-for-byte.
 */
export function createSequentialClock(startIso: string, stepMs = 1000): BridgeClock {
  let current = Date.parse(startIso);
  let calls = 0;
  return {
    now() {
      if (calls > 0) current += stepMs;
      calls += 1;
      return new Date(current).toISOString();
    },
  };
}

// ---------------------------------------------------------------------------
// CLI: one-command replay run.
//   node spikes/feishu/src/replay.ts <observation-fixture.json>
// Prints the recorded evidence JSONL to stdout. See spikes/feishu/README.md.
// ---------------------------------------------------------------------------

function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  return fileURLToPath(import.meta.url) === path.resolve(invoked);
}

function main(): void {
  const fixtureArg = process.argv[2];
  if (fixtureArg === undefined) {
    console.error("usage: node spikes/feishu/src/replay.ts <observation-fixture.json>");
    process.exitCode = 1;
    return;
  }
  const fixture = loadObservationFixture(path.resolve(fixtureArg));
  const clock = createSequentialClock("2026-09-02T00:00:00Z");
  process.stdout.write(replayFixtureToEvidence(fixture, clock));
}

if (isMainModule()) {
  main();
}
