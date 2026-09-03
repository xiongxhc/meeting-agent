# Feishu bridge spike

This directory holds the platform-neutral half of the Feishu Mac bridge: the
frozen `bridge-session/v1` wire contract (`src/protocol.ts`, Task 1), a JSONL
evidence recorder (`src/recorder.ts`, Task 1), and — added in Task 2 — the
**observation reducer** (`src/reducer.ts`) and **deterministic replay
harness** (`src/replay.ts`) that turn raw Feishu-client UI observations into
that same `BridgeEvent` stream.

A Swift Mac bridge (`bridges/mac/`) that observes the real Feishu client
landed in Task 3. `src/reducer.ts` is the **reference
implementation of the ambiguity policy**: the Swift side will produce raw
observations in the `UiObservation` shape declared there and defer every
"is this speaker known or ambiguous" decision to the same rules verified
here against shared fixtures. Nothing in `src/reducer.ts` or `src/replay.ts`
is macOS-specific, and neither calls a real Feishu app, macOS accessibility
API, or the network — everything is driven by fixture files and injected
ports.

## Layout

```
spikes/feishu/
  src/
    protocol.ts   frozen bridge-session/v1 types + validator (Task 1)
    recorder.ts   JSONL evidence recorder (Task 1)
    reducer.ts    UI observation -> BridgeEvent reducer (Task 2)
    replay.ts     deterministic replay harness + CLI (Task 2)
  test/
    protocol.test.ts
    reducer.test.ts
    replay.test.ts
  fixtures/
    observations/   recorded UI *input* fixtures (this task)
```

`fixtures/observations/*.json` are a different thing from
`fixtures/contracts/bridge-session-v1.json` at the repo root: the latter is
the frozen *wire* contract (Task 1's normative bytes); the former are
recorded *UI observation* frames — inputs to the reducer, not part of the
contract.

## Permission setup

Running anything in this directory — tests, typecheck, lint, build, or the
replay CLI — needs no permissions at all: no Feishu app, no macOS
Accessibility/Screen Recording grants, no network access, no API keys. That
is the point of the reducer/replay split — permission-gated observation
(reading the real Feishu client) is entirely the Swift bridge's job in a
later task; everything here operates on recorded JSON frames.

The Swift bridge needs the macOS Accessibility permission (to read UI
element state) and possibly Screen Recording (if any observation turns out to
be OCR-based rather than accessibility-based). That is documented alongside
the Swift code, in `bridges/mac/README.md`, not here.

## Observation fixtures and redaction rules

Each file under `fixtures/observations/` is one `ObservationFixture`:

```json
{
  "sessionId": "sess_replay_0000000000000001",
  "tileIdentities": { "tile-1": { "feishuUserId": "ou_00000000000000000000000000000a" } },
  "chatControl": { "available": true },
  "observations": [
    { "kind": "speaker_highlight", "observedAt": "2026-09-02T14:00:10.000Z", "highlightedTileIds": ["tile-1"] }
  ]
}
```

- `sessionId` — a synthetic `sess_replay_...` id, unique per fixture file.
- `tileIdentities` — the fake image-recognition port's answer table: which
  opaque tile id resolves to which synthetic `feishuUserId`, or is left
  unresolvable by omission.
- `chatControl.available` — the fake chat-control port's behaviour: whether
  attempting to post a disclosure finds the chat box.
- `observations` — the ordered `UiObservation` frames themselves (see
  `src/reducer.ts` for the four kinds: `speaker_highlight`, `roster_snapshot`,
  `meeting_ended`, `disclosure_attempt`).

Redaction rules for every fixture in this directory (and any added later):

- No real Feishu user ids, display names, meeting numbers, or tenant data.
  User ids follow the synthetic `ou_0000000000000000000000000000000a`-style
  pattern already used by `fixtures/contracts/bridge-session-v1.json`; names
  are `Test Participant One`, `Test Participant Two`, etc.
- No real timestamps tied to an actual meeting — dates are obviously
  synthetic (`2026-09-02`, matching the frozen contract fixture's date).
- Tile ids (`tile-1`, `tile-2`, ...) are opaque placeholders, not real
  accessibility identifiers from any client build.

The seven required scenarios, one fixture file each:

| Fixture | Scenario | Emits |
|---|---|---|
| `one-active-speaker.json` | single highlighted tile, identity resolved | `active_speaker` (`ui_exact`) |
| `speaker-switch.json` | highlight moves from one tile to another (with a duplicate frame in between) | two `active_speaker` events, no duplicate for the repeat |
| `two-highlighted-tiles.json` | two tiles highlighted at once, both individually resolvable | `active_speaker` (`ambiguous`, `feishuUserId: null`) — **never** a chosen participant |
| `participant-join.json` | roster grows by one | `participant_joined` |
| `participant-leave.json` | roster shrinks by one (after two joins) | `participant_joined` × 2, then `participant_left` |
| `meeting-ended.json` | UI shows the meeting ended | `left` (`reason: "ended"`), and nothing after it — a session is terminal once it has left |
| `missing-chat-control.json` | disclosure attempted, no chat control found | `chat_disclosure` (`outcome: "unavailable"`) |

## Evidence fields

`replayFixtureToEvidence()` (in `src/replay.ts`) runs a fixture's events
through the frozen session validator and the Task 1 JSONL recorder, so the
replay CLI's output is exactly the recorder's `BridgeRecord` shape, one JSON
object per line:

```json
{"recordedAt":"...","direction":"event","message":{"schema":"bridge-session/v1","sessionId":"...","sequence":1,"observedAt":"...","type":"active_speaker","feishuUserId":null,"confidence":"ambiguous"}}
```

- `recordedAt` — when the harness's injected clock recorded the event
  (`createSequentialClock`, never `Date.now()` — see below).
- `direction` — always `"event"` here; the harness only replays
  bridge-to-coordinator events, never commands.
- `message` — the full `BridgeEventMessage`: envelope (`schema`, `sessionId`,
  `sequence`, `observedAt`) plus the event payload (`type` and its fields),
  identical in shape to what the frozen `bridge-session/v1` validator
  accepts on the real wire.

`observedAt` on each event comes straight from the observation frame that
produced it (when the UI was seen in that state); `recordedAt` comes from the
harness's clock (when the evidence line was written). The CLI's clock is
`createSequentialClock("2026-09-02T00:00:00Z")`, ticking forward one second
per event — deterministic and reproducible, never a wall-clock read.

## One-command replay run

From the repo root:

```
node spikes/feishu/src/replay.ts spikes/feishu/fixtures/observations/two-highlighted-tiles.json
```

This prints the evidence JSONL for that fixture to stdout. Swap in any of
the seven fixture files under `fixtures/observations/` to replay that
scenario. No build step, no flags, no environment variables — Node 22+'s
built-in TypeScript stripping runs the file directly, the same way `npm
test` runs the `*.test.ts` files.

## Running the tests

```
npm test
```

runs every `*.test.ts` under `spikes/`, `bridges/`, `src/` and `test/`,
including `spikes/feishu/test/reducer.test.ts`
(unit-level ambiguity-policy and sequencing tests against hand-built fake
ports) and `spikes/feishu/test/replay.test.ts` (the seven fixture scenarios,
each asserting the full ordered `BridgeEvent` list, plus stream-validator and
determinism checks on the replay evidence).

```
npm run typecheck   # tsc --noEmit
npm run lint         # eslint .
npm run build         # tsc
```

## What is proven here, and what is not

Everything in this directory — the frozen wire contract, the reducer's
ambiguity policy, and the replay harness — is proven only against the fixture
files under `fixtures/observations/` and synthetic ports. Nothing here has
ever been driven by a real Feishu client, a real accessibility tree, or a
real meeting.

A reader landing on this page who wants to know what the whole Feishu Mac
bridge effort has actually shown, rather than what this one directory shows
in isolation, should go to three places:

- `docs/feasibility/feishu-client-matrix.md` — the feasibility verdict: which
  join paths, permissions, and degraded behaviours are proven in unit tests
  versus never measured against a real client, and why Linux standalone is
  `not tested` rather than `failed`.
- `docs/HUMAN-CHECKLIST.md` — every step that needs a real Feishu client, a
  real tenant, or agent-box access, with the exact procedure and evidence to
  capture, none of it attempted yet.
- `docs/feasibility/mac-bridge-decision.md` — the open Swift-versus-Rust
  decision for `bridges/mac/`; every one of its seven criteria is still
  unmeasured, so no language has been selected.
