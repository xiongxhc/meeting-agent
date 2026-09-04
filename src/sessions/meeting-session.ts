// The per-meeting session: the one place where the bridge control plane
// (bridge-session/v1) and the Conversation Runtime control plane meet.
//
// It owns four things and deliberately owns nothing else:
//   1. the join sequence -- one runtime session, pinned; the runtime-issued
//      media descriptor handed to the bridge as `connect_media`;
//   2. one bounded, serially-drained event queue over both planes;
//   3. the per-turn state machine, whose single writer guarantees exactly one
//      terminal event per turn;
//   4. finalization -- the recording handle, hash, duration and the gaps
//      exactly as the bridge observed them.
//
// It does NOT decide whether a segment invoked the agent (src/sessions/
// invocation-gate.ts does, and this module never second-guesses it), does not
// own the orchestration state machine (src/sessions/coordinator.ts does), and
// does not know what a wire byte looks like in either direction.
//
// -------------------------------------------------------------------------
// FOUR PROPERTIES THAT ARE STRUCTURAL HERE, NOT CONVENTIONS
// -------------------------------------------------------------------------
//
// AN AUDIO FRAME CANNOT REACH THE COORDINATOR. Inbound bridge traffic arrives
// as `unknown` and passes through the frozen contract's `acceptEvent` before
// anything else looks at it. That validator's type table is closed and holds
// twelve members, none of which carries bytes; a frame-shaped message is
// rejected as `unknown_type` and never becomes a routable value. Outbound, the
// only vocabulary is `BridgeCommand`, five members, likewise. Meeting Agent
// never relays a frame because there is no expression in either direction that
// could hold one -- the same way the Swift bridge made a frame inexpressible on
// its control plane. Media travels between the runtime and the bridge on the
// socket `connect_media` describes; this module handles the DESCRIPTOR only.
//
// NO BRANCH CAN SYNTHESIZE A SPOKEN DISCLOSURE. The disclosure path is a
// DisclosurePublisher from src/ports/bridge.ts, constructed with exactly one
// capability -- issue a BridgeCommand. That module imports nothing from the
// runtime port, so the runtime is not in scope for it to call. Disclosure is
// meeting-chat text, the bridge is the only thing that attempts it, and
// failing to disclose never blocks joining.
//
// A PROFILE OR STATUS MISMATCH ABORTS SPEAKING, NOT CAPTURE. The runtime
// ANSWERING with a profile is not the same as the runtime HONOURING one. On
// any disagreement the session stops being able to speak and goes on
// capturing, recording, and finalizing: losing the meeting's transcript
// because the agent could not talk would be a far worse failure than a silent
// agent.
//
// EXACTLY ONE TERMINAL EVENT PER TURN. `settle` is the single writer of the
// turn log, it is idempotent per segmentId, and it contains no `await`. On a
// single-threaded runtime that makes it atomic with respect to every other
// handler, so a flood of racing signals for one segment -- authorized, barge-in,
// skip, provider outage, redelivery -- produces one record, deterministically
// the first one dequeued.

import {
  BRIDGE_SESSION_SCHEMA,
  createBridgeSessionValidator,
  type BridgeEventMessage,
} from "../contracts/bridge-session-v1.ts";
import { createTeamVaultIndexOrDegraded } from "../adapters/team-vault-index.ts";
import type { MeetingIdentity } from "../domain/meeting.ts";
import type { ActiveSpeakerObservation } from "../domain/transcript.ts";
import {
  BridgeContractError,
  createDisclosurePublisher,
  type BridgeCommand,
  type BridgeCommandResult,
  type BridgeTransport,
  type DisclosureOutcome,
  type ObservedAudioGap,
} from "../ports/bridge.ts";
import type {
  ConversationRuntimePort,
  RecordingSummary,
  RuntimeEvent,
  TranscriptSegment,
} from "../ports/conversation-runtime.ts";
import type { TeamVaultIndexPort, TeamVaultSearchResult } from "../ports/knowledge.ts";
import type { Clock, RecordingInput, SessionCoordinator, TerminalOutcome } from "./coordinator.ts";
import {
  createInvocationDispatcher,
  decide,
  type InvocationGateIdentity,
  type InvocationSink,
} from "./invocation-gate.ts";
import {
  RetrievalAuthorizationCancelled,
  createRetrievalRouter,
  type RetrievalRouter,
} from "./retrieval-router.ts";

/** Used when the session was given neither `options.retrieval` nor
 * `options.teamVaultDir`: the router still answers from the current
 * meeting alone, and states plainly that historical team memory is
 * unavailable for anything the current meeting alone cannot cover -- the
 * same degraded path a broken checkout takes (see
 * createTeamVaultIndexOrDegraded), never a silently-empty vault. */
const UNCONFIGURED_VAULT: TeamVaultIndexPort = {
  search(): TeamVaultSearchResult {
    throw new Error(
      "no Team Vault checkout is configured for this session (neither options.retrieval " +
        "nor options.teamVaultDir was set)",
    );
  },
};

export { BridgeContractError } from "../ports/bridge.ts";

/** Meeting Agent v1 pins these two per session, explicitly, every time. A
 * runtime that answers with anything else is a mismatch, never a fallback. */
const PINNED_PROFILE = "online";
const PINNED_RESPONSE_MODE = "external_gate";

/**
 * How many un-drained events one session will hold.
 *
 * The bound is per session, not global: a session is one meeting, and the
 * traffic it can generate is bounded by that meeting's participants and
 * speech. 256 is roughly two orders of magnitude above what an hour-long
 * two-human meeting produces (a handful of participant events, one gap every
 * few minutes, one finalized segment every few seconds), so reaching it means
 * the drain has stopped keeping up, not that the meeting got busy.
 *
 * OVERFLOW IS NEVER A SILENT DROP. The newest arrival is dropped -- keeping
 * the oldest preserves the ordering the turn machine and the sequence
 * validator both depend on -- and two things happen that a reader can see:
 * the drop is appended to `state().overflows` with its source and the queue
 * depth, and SPEAKING IS ABORTED. The second is the point. A queue that
 * overflowed can no longer promise that the gate is deciding on the current
 * utterance, and speaking on a stale decision is the exact failure this whole
 * product is built to avoid. Capture continues, as with every other abort.
 * This mirrors the Swift bridge's jitter buffer, where overflow had to become
 * an observable `audio_gap` rather than vanishing.
 */
const DEFAULT_MAX_QUEUED_EVENTS = 256;

export type MeetingSessionPhase = "created" | "joining" | "listening" | "ended";
export type SpeakingState = "enabled" | "aborted";

/** The four ways a turn can end. Exactly one is recorded per segment. */
export type TurnOutcome = "skipped" | "spoken" | "barged_in" | "failed";

export type TurnRecord = {
  readonly segmentId: string;
  readonly outcome: TurnOutcome;
  /** The gate's reason, the runtime's reason, or the failure -- never
   * transcript text. */
  readonly detail: string | null;
  readonly atMs: number;
};

export type QueueOverflow = {
  readonly source: "bridge" | "runtime";
  readonly queueDepth: number;
  readonly atMs: number;
  /** `dropped` for every ordinary event. `admitted` only for this session's
   * own terminal `left`, which is let through over the bound rather than
   * dropped -- see enqueue. Either way the arrival over the bound is on the
   * record; the disposition says what happened to it. */
  readonly disposition: "dropped" | "admitted";
};

export type InboundRejection = {
  readonly code: string;
  readonly path: string;
};

export type RuntimeCallFailure = {
  readonly segmentId: string;
  readonly error: unknown;
};

/** One event's handler threw. Recorded rather than propagated: every handler
 * shares one pump, and the coordinator throws by design on any transition its
 * graph does not allow, so letting a throw escape would end the drain for
 * every later event -- one duplicate `joined` would cost the meeting. */
export type RoutingFailure = {
  readonly source: "bridge" | "runtime" | "join_cleanup";
  readonly error: unknown;
};

/** Runtime gaps are its own media timeline; bridge observations are retained
 * independently and are never rewritten through an invented SDK method. */
export type GapReconciliation = "not_needed";

export type MeetingSessionState = {
  readonly phase: MeetingSessionPhase;
  readonly speaking: SpeakingState;
  readonly speakingAbortReason: string | null;
  readonly runtimeSessionId: bigint | null;
  readonly bridgeConnected: boolean;
  readonly mediaConnected: boolean;
  readonly reconnectAttempts: number;
  readonly disclosure: "pending" | DisclosureOutcome;
  readonly observedGaps: readonly ObservedAudioGap[];
  readonly recording: RecordingSummary | null;
  /** Why there is no recording, when there is none. `recording === null` alone
   * cannot distinguish "the session never finalized" from "finalization was
   * attempted and threw", and those need different operator responses. */
  readonly finalizationError: unknown;
  readonly gapReconciliation: GapReconciliation;
  readonly terminalReason: string | null;
  readonly commandResults: readonly BridgeCommandResult[];
  readonly overflows: readonly QueueOverflow[];
  readonly maxQueuedEvents: number;
  /** Events queued but not yet drained, right now. Never exceeds
   * `maxQueuedEvents`; the one terminal `left` admitted over the bound is
   * admitted at most once per session. */
  readonly queuedEvents: number;
  /** Every contract type this session actually routed, in order. The evidence
   * for "an audio frame never reached the coordinator": every entry is a
   * declared bridge-session/v1 event type, because nothing else can get past
   * the validator. */
  readonly routedEventTypes: readonly string[];
  readonly rejectedInbound: readonly InboundRejection[];
  /** Messages discarded because the session was already terminal. A `left` is
   * final -- bridge-session/v1 has no re-open -- so these are counted rather
   * than acted on. */
  readonly ignoredAfterTerminal: number;
  readonly runtimeErrors: readonly RuntimeCallFailure[];
  readonly routingErrors: readonly RoutingFailure[];
  /** The bridge's active-speaker observations, verbatim and in order, with
   * the bridge's own observedAt. PROVISIONAL EVIDENCE, not attribution: no
   * segment here carries a speaker, and nothing in this module correlates
   * the two. src/sessions/speaker-reconciler.ts consumes both after the
   * meeting, together with the persisted recording handle. */
  readonly speakerEvidence: readonly ActiveSpeakerObservation[];
  /** Every FINAL transcript segment, in arrival order -- the live wording the
   * reconciler falls back to when the diarization backend supplies none
   * (ruling R55). The same final segments are durably retained in the local
   * reconciliation ledger only; they never enter Team Vault or output paths. */
  readonly liveTranscript: readonly TranscriptSegment[];
};

export type MeetingSession = {
  readonly bridgeSessionId: string;
  /** Takes the bridge lease, subscribes to both planes, and issues join /
   * connect_media / post_disclosure in the contract's canonical order.
   * Rejects if the session is already joined or already terminal. */
  join(): Promise<void>;
  /** Asks the bridge to leave. The session ends when the bridge answers with
   * `left`, never at the moment of asking. */
  leave(reason: "meeting_ended" | "coordinator_stop"): Promise<void>;
  state(): MeetingSessionState;
  turns(): readonly TurnRecord[];
  /** Resolves once the event queue is drained. Every test awaits this rather
   * than a timer; nothing in this module sleeps. */
  settled(): Promise<void>;
  /** Per-session cancellation. Resolves only after the ordered best-effort
   * leave/finalize/close/release/unsubscribe cleanup is complete; idempotent
   * and safe before join. */
  dispose(): Promise<void>;
};

export type CreateMeetingSessionOptions = {
  readonly identity: MeetingIdentity;
  readonly bridge: BridgeTransport;
  readonly runtime: ConversationRuntimePort;
  readonly coordinator: SessionCoordinator;
  readonly clock: Clock;
  readonly agentIdentity: InvocationGateIdentity;
  readonly bridgeId: string;
  readonly bridgeSessionId: string;
  readonly disclosureText: string;
  readonly maxQueuedEvents?: number;
  readonly bridgeFailureRetryLimit?: number;
  /** Injected so command ids are deterministic under test. Defaults to a
   * per-session counter, which is already deterministic. */
  readonly nextCommandId?: () => string;
  /** The published Team Vault checkout this session's retrieval router
   * reads (`config.dataPaths.teamVaultDir`). The session never opens it
   * directly -- it builds a read-only index once via
   * `createTeamVaultIndexOrDegraded`, which never throws: a missing or
   * broken checkout degrades to an always-"vault unavailable" index rather
   * than failing the session (see src/adapters/team-vault-index.ts).
   * Ignored when `retrieval` is provided. Omitting both leaves retrieval
   * permanently in the same degraded state, answering from the current
   * meeting alone. */
  readonly teamVaultDir?: string;
  /** Test/advanced-caller override: an already-built retrieval router
   * (e.g. wired to a fake Team Vault index), used instead of the session
   * building one from `teamVaultDir`. */
  readonly retrieval?: RetrievalRouter;
  /** Composition lifecycle hook. Called once, only after terminal/disposal
   * cleanup has finished, so applications can stop retaining sensitive
   * session state without reopening shutdown races. */
  readonly onInactive?: () => void;
};

type QueueItem =
  | { readonly source: "bridge"; readonly raw: unknown }
  | { readonly source: "runtime"; readonly event: RuntimeEvent };

export function createMeetingSession(options: CreateMeetingSessionOptions): MeetingSession {
  const {
    identity,
    bridge,
    runtime,
    coordinator,
    clock,
    agentIdentity,
    bridgeId,
    bridgeSessionId,
    disclosureText,
  } = options;
  const maxQueuedEvents = options.maxQueuedEvents ?? DEFAULT_MAX_QUEUED_EVENTS;
  const bridgeFailureRetryLimit = options.bridgeFailureRetryLimit ?? 2;
  // A freshly constructed session is either the occurrence's first bridge
  // generation (discovered) or a recovery generation after bridge_failure.
  // This is captured before join so a duplicate `joined` on one generation is
  // still a protocol error rather than being mistaken for recovery.
  const isRecoveryGeneration = coordinator.get(identity.occurrenceId)?.state === "listening";
  // A bridge session is the immutable generation boundary. Runtime IDs arrive
  // later and recordings are atomically associated at finalization.

  const validator = createBridgeSessionValidator(bridgeSessionId);
  const issuedCommandTypes = new Map<string, BridgeCommand["type"]>();
  let commandSeq = 0;
  const nextCommandId =
    options.nextCommandId ??
    (() => {
      commandSeq += 1;
      return `cmd_${String(commandSeq).padStart(4, "0")}`;
    });

  // ---- mutable session state -------------------------------------------
  let phase: MeetingSessionPhase = "created";
  let speaking: SpeakingState = "enabled";
  let speakingAbortReason: string | null = null;
  let runtimeSessionId: bigint | null = null;
  let reconciliationGenerationStarted = false;
  let bridgeConnected = true;
  let mediaConnected = false;
  let reconnectAttempts = 0;
  let disclosure: "pending" | DisclosureOutcome = "pending";
  let recording: RecordingSummary | null = null;
  let finalizationError: unknown = null;
  const gapReconciliation: GapReconciliation = "not_needed";
  let terminalReason: string | null = null;
  let ignoredAfterTerminal = 0;
  let leaseId: string | null = null;
  let finalized = false;
  let disposed = false;
  let cancellationGeneration = 0;
  let runtimeStartAttempted = false;
  let runtimeClosed = false;
  let joinCommandSent = false;
  let disposePromise: Promise<void> | null = null;
  let activeJoinPromise: Promise<void> | null = null;
  let inactiveRequested = false;
  let inactiveNotified = false;

  const observedGaps: ObservedAudioGap[] = [];
  const commandResults: BridgeCommandResult[] = [];
  const overflows: QueueOverflow[] = [];
  const routedEventTypes: string[] = [];
  const rejectedInbound: InboundRejection[] = [];
  const runtimeErrors: RuntimeCallFailure[] = [];
  const routingErrors: RoutingFailure[] = [];
  const speakerEvidence: ActiveSpeakerObservation[] = [];
  const liveTranscript: TranscriptSegment[] = [];
  const turns: TurnRecord[] = [];
  const settledTurns = new Set<string>();
  const openTurns = new Set<string>();

  let unsubscribeBridge: (() => void) | null = null;
  let unsubscribeRuntime: (() => void) | null = null;

  // What the agent knows when it answers: current-meeting memory first,
  // this session's Team Vault index second -- see
  // src/sessions/retrieval-router.ts, the ordering's owner. `options.retrieval`
  // (tests, advanced callers) wins outright; otherwise a router is built
  // from `options.teamVaultDir` via the non-throwing constructor, so a
  // missing or broken checkout degrades retrieval instead of failing the
  // session (see createTeamVaultIndexOrDegraded and UNCONFIGURED_VAULT
  // above).
  const runtimeContextSink = {
    get sessionId(): bigint {
      if (runtimeSessionId === null) {
        throw new Error("runtime session ID is unavailable before the local start handle resolves");
      }
      return runtimeSessionId;
    },
    seedConversationContext: runtime.seedConversationContext.bind(runtime),
    authorizeVoiceResponse: runtime.authorizeVoiceResponse.bind(runtime),
  };

  const retrievalRouter: RetrievalRouter =
    options.retrieval ??
    createRetrievalRouter({
      vault:
        options.teamVaultDir === undefined
          ? UNCONFIGURED_VAULT
          : createTeamVaultIndexOrDegraded({ teamVaultDir: options.teamVaultDir }),
      sink: runtimeContextSink,
    });

  // A transcript_final segment's text, captured just long enough for the
  // sink's authorizeVoiceResponse (below) to hand it to the retrieval
  // router -- the gate's own sink contract (InvocationSink, src/sessions/
  // invocation-gate.ts) carries segmentId and matchedAlias only, never the
  // segment text, so this is what supplies the router something to search
  // for. Removed the moment it is consumed either way (skip or authorize).
  const pendingQueryText = new Map<string, string>();
  const turnGenerations = new Map<string, number>();
  // In-flight retrieval-then-authorize work the sink kicks off without the
  // pump loop awaiting it (see the "not awaited here, deliberately" note
  // below) -- tracked so settled() can still wait for it. Without this, a
  // caller awaiting settled() could observe the queue as idle before the
  // runtime actually received seedContext/authorizeVoiceResponse, since
  // seeding context adds a real await the runtime call alone did not have.
  const pendingSinkWork = new Set<Promise<void>>();

  // The gate's sink and dispatcher. The dispatcher owns "one decision applied
  // per segmentId"; this module never re-derives a decision. The retrieval
  // router slots in HERE, between the gate's positive decision and the
  // runtime actually being told to speak: authorizeVoiceResponse searches
  // current-meeting memory first, the Team Vault only if that was
  // insufficient, seeds the bounded result through the runtime's context
  // API, and only THEN authorizes.
  const sink: InvocationSink = {
    skipVoiceResponse(segmentId: string, reason): void {
      pendingQueryText.delete(segmentId);
      runtime.skipVoiceResponse({ sessionId: requireRuntimeSessionId(), segmentId, reason }).catch((error: unknown) => {
        runtimeErrors.push({ segmentId, error });
      });
    },
    authorizeVoiceResponse(segmentId: string, matchedAlias: string): void {
      const queryText = pendingQueryText.get(segmentId) ?? "";
      pendingQueryText.delete(segmentId);
      const turnGeneration = turnGenerations.get(segmentId);
      // Not awaited here, deliberately -- matching every other runtime call
      // in this module (see skipVoiceResponse above, and finalizeRecording
      // below): the pump never blocks on a runtime round-trip. Tracked in
      // pendingSinkWork instead, so settled() still waits for it.
      const work = retrievalRouter
        .answer({ segmentId, authorize: true, matchedAlias }, queryText, {
          mayAuthorize: () =>
            turnGeneration !== undefined &&
            cancellationGeneration === turnGeneration &&
            terminalReason === null &&
            phase === "listening" &&
            speaking === "enabled" &&
            openTurns.has(segmentId),
        })
        .then(() => {})
        .catch((error: unknown) => {
          if (!(error instanceof RetrievalAuthorizationCancelled)) {
            runtimeErrors.push({ segmentId, error });
          }
          failClosedTurn(segmentId, error instanceof RetrievalAuthorizationCancelled ? "authorization_cancelled" : "retrieval_failed");
        });
      pendingSinkWork.add(work);
      void work.finally(() => {
        pendingSinkWork.delete(work);
      });
    },
  };
  const dispatcher = createInvocationDispatcher(sink);

  // ---- outbound ---------------------------------------------------------

  async function issue(command: BridgeCommand): Promise<void> {
    const commandId = nextCommandId();
    const accepted = validator.acceptCommand({
      schema: BRIDGE_SESSION_SCHEMA,
      sessionId: bridgeSessionId,
      commandId,
      ...command,
    });
    if (!accepted.ok) {
      throw new BridgeContractError(
        "command",
        accepted.rejection.code,
        accepted.rejection.path,
        accepted.rejection.detail,
      );
    }
    issuedCommandTypes.set(commandId, command.type);
    await bridge.send(accepted.value);
    if (command.type === "join") joinCommandSent = true;
  }

  // Handed ONE capability. src/ports/bridge.ts imports nothing from the
  // runtime port, so no branch reachable from here can speak.
  const disclosurePublisher = createDisclosurePublisher(issue);

  // ---- turn machine -----------------------------------------------------

  /** The single writer of the turn log. Idempotent per segmentId and free of
   * `await`, which is what makes "exactly one terminal event per turn" hold
   * under any interleaving rather than only on the happy path. */
  function settle(segmentId: string, outcome: TurnOutcome, detail: string | null): void {
    if (settledTurns.has(segmentId)) return;
    settledTurns.add(segmentId);
    openTurns.delete(segmentId);
    turnGenerations.delete(segmentId);
    turns.push({ segmentId, outcome, detail, atMs: clock.now() });
  }

  function abortSpeaking(reason: string): void {
    if (speaking === "aborted") return; // The first reason is the true one.
    speaking = "aborted";
    speakingAbortReason = reason;
    cancellationGeneration += 1;
  }

  function requireRuntimeSessionId(): bigint {
    if (runtimeSessionId === null) {
      throw new Error("runtime session ID is unavailable for a session-bound control request");
    }
    return runtimeSessionId;
  }

  function failClosedTurn(segmentId: string, reason: string): void {
    if (!settledTurns.has(segmentId)) settle(segmentId, "failed", reason);
    runtime.skipVoiceResponse({ sessionId: requireRuntimeSessionId(), segmentId, reason }).catch((error: unknown) => {
      runtimeErrors.push({ segmentId, error });
    });
  }

  // ---- bounded queue ----------------------------------------------------

  const queue: QueueItem[] = [];
  let terminalLeftAdmitted = false;
  let pumping = false;
  let idleWaiters: Array<() => void> = [];

  function enqueue(item: QueueItem): void {
    if (disposed) return;

    if (queue.length >= maxQueuedEvents) {
      // Dropping the newest arrival costs one event for every ordinary type.
      // For this session's own terminal `left` it would cost the SESSION:
      // no finalizeRecording, no lease release, and the coordinator row stuck
      // in "listening" forever, with nothing that ever sweeps it. So a
      // terminal `left` is admitted over the bound. The admission is recorded
      // like any other over-bound arrival, and it does not abort speaking --
      // nothing was lost, and the session is ending anyway.
      //
      // ONCE per session, which is what makes the bound a bound. The
      // over-bound test is re-evaluated per message, so while terminate() is
      // awaiting something slow -- and the queue is therefore not draining --
      // every further `left`-shaped message would otherwise be independently
      // judged over-bound and pushed, without limit. One is enough: the
      // session is terminal after the first, and bridge-session/v1 has no
      // re-open, so every later `left` is redundant by the contract's own
      // rule. The rest fall through to the ordinary drop path below.
      if (item.source === "bridge" && !terminalLeftAdmitted && looksLikeTerminalLeft(item.raw)) {
        terminalLeftAdmitted = true;
        overflows.push({
          source: item.source,
          queueDepth: queue.length,
          atMs: clock.now(),
          disposition: "admitted",
        });
        queue.push(item);
        void pump();
        return;
      }

      overflows.push({
        source: item.source,
        queueDepth: queue.length,
        atMs: clock.now(),
        disposition: "dropped",
      });
      abortSpeaking("queue_overflow");
      return;
    }

    queue.push(item);
    void pump();
  }

  /** A deliberately cheap PRE-FILTER, not a second validator: is this raw
   * message plausibly this session's own terminal `left`? It decides only
   * whether one message may occupy a queue slot over the bound. Whatever it
   * admits still passes through `acceptEvent` when it is handled, so a forged
   * or malformed message is rejected there exactly as before. Combined with
   * the once-per-session cap in enqueue, the worst a lie can buy is ONE queue
   * slot for the whole session -- a cap, not a per-message allowance. */
  function looksLikeTerminalLeft(raw: unknown): boolean {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
    const record = raw as Record<string, unknown>;
    return (
      record["schema"] === BRIDGE_SESSION_SCHEMA &&
      record["type"] === "left" &&
      record["sessionId"] === bridgeSessionId
    );
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0) {
        if (disposed) {
          queue.length = 0;
          break;
        }
        const item = queue.shift();
        if (item === undefined) break;
        try {
          await handle(item);
        } catch (error) {
          // One event's failure costs that event, never the drain.
          routingErrors.push({ source: item.source, error });
        }
      }
    } finally {
      pumping = false;
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  async function handle(item: QueueItem): Promise<void> {
    if (item.source === "bridge") {
      await handleBridgeMessage(item.raw);
      return;
    }
    await handleRuntimeEvent(item.event);
  }

  /**
   * Resolves once BOTH the local event queue is drained AND every
   * retrieval-then-authorize call the queue's own synchronous dispatch
   * kicked off (see sink.authorizeVoiceResponse) has settled.
   *
   * Those two are different things: the queue can go idle -- `pumping`
   * false, nothing left to shift -- while a `pendingSinkWork` entry it
   * started is still awaiting `seedContext`/`authorizeVoiceResponse`
   * against the runtime, because that work is deliberately NOT awaited
   * inline (the pump never blocks on a runtime round-trip; see the sink's
   * own comment). Looping rather than checking once matters here: while
   * this function awaits the current sink work, the queue could receive
   * (and finish draining) a new item, so a single check could return before
   * everything genuinely in flight has settled.
   */
  async function whenIdle(): Promise<void> {
    for (;;) {
      if (pumping || queue.length > 0) {
        await new Promise<void>((resolve) => {
          idleWaiters.push(resolve);
        });
        continue;
      }
      if (pendingSinkWork.size > 0) {
        await Promise.allSettled([...pendingSinkWork]);
        continue;
      }
      return;
    }
  }

  // ---- inbound: bridge --------------------------------------------------

  async function handleBridgeMessage(raw: unknown): Promise<void> {
    if (terminalReason !== null) {
      ignoredAfterTerminal += 1;
      return;
    }
    // The ONLY door in. A frame-shaped message dies here as `unknown_type`.
    const parsed = validator.acceptEvent(raw);
    if (!parsed.ok) {
      rejectedInbound.push({ code: parsed.rejection.code, path: parsed.rejection.path });
      return;
    }
    const event: BridgeEventMessage = parsed.value;
    routedEventTypes.push(event.type);

    switch (event.type) {
      case "joined":
        phase = "listening";
        if (coordinator.get(identity.occurrenceId)?.state === "joining") {
          coordinator.advance(identity.occurrenceId, "listening");
        } else if (!isRecoveryGeneration) {
          throw new Error("duplicate joined event for an already-listening bridge generation");
        }
        return;

      case "left":
        await terminate(event.reason, Date.parse(event.observedAt), "bridge_observed");
        return;

      case "media_connected":
        mediaConnected = true;
        return;

      case "media_disconnected":
        mediaConnected = false;
        return;

      case "chat_disclosure":
        disclosure = event.outcome;
        return;

      case "audio_gap":
        // Stored exactly as observed: same order, no merging, no rounding,
        // `endedAt: null` (a gap still open) preserved as null.
        observedGaps.push({
          direction: event.direction,
          startedAt: event.startedAt,
          endedAt: event.endedAt,
        });
        return;

      case "command_result": {
        const commandType = issuedCommandTypes.get(event.commandId) ?? null;
        commandResults.push({
          commandId: event.commandId,
          commandType,
          outcome: event.outcome,
          detail: event.detail,
        });
        if (commandType === "connect_media" && event.outcome !== "ok") {
          // No media path means nothing to speak over. Capture stays as it is;
          // only speaking stops.
          mediaConnected = false;
          abortSpeaking(`media_command_${event.outcome}`);
        }
        return;
      }

      case "reconnecting":
        bridgeConnected = false;
        reconnectAttempts = event.attempt;
        return;

      case "reconnected":
        bridgeConnected = true;
        reconnectAttempts = event.attempt;
        return;

      case "active_speaker":
        // Retained as provisional evidence -- the observation, its two legal
        // shapes intact, and the bridge's own timestamp. Not correlated with
        // any segment here: attribution is src/sessions/speaker-reconciler.ts's
        // job, after the meeting, and it is allowed to say "cannot say".
        speakerEvidence.push(
          event.confidence === "ui_exact"
            ? { bridgeSessionId: event.sessionId, sequence: event.sequence, observedAt: event.observedAt, confidence: "ui_exact", feishuUserId: event.feishuUserId }
            : { bridgeSessionId: event.sessionId, sequence: event.sequence, observedAt: event.observedAt, confidence: "ambiguous", feishuUserId: null },
        );
        coordinator.appendReconciliationBridgeEvent(identity.occurrenceId, {
          bridgeSessionId: event.sessionId, sequence: event.sequence, schema: event.schema, observedAt: event.observedAt,
          type: "active_speaker", feishuUserId: event.feishuUserId, displayName: null, confidence: event.confidence,
        });
        return;

      // Attendance is reduced by src/domain/participants.ts. Routed and
      // counted here so the "every routed type is a declared contract type"
      // evidence is complete.
      case "participant_joined":
        coordinator.appendReconciliationBridgeEvent(identity.occurrenceId, {
          bridgeSessionId: event.sessionId, sequence: event.sequence, schema: event.schema, observedAt: event.observedAt,
          type: "participant_joined", feishuUserId: event.feishuUserId, displayName: event.displayName, confidence: null,
        });
        return;
      case "participant_left":
        coordinator.appendReconciliationBridgeEvent(identity.occurrenceId, {
          bridgeSessionId: event.sessionId, sequence: event.sequence, schema: event.schema, observedAt: event.observedAt,
          type: "participant_left", feishuUserId: event.feishuUserId, displayName: null, confidence: null,
        });
        return;
    }
  }

  // ---- inbound: runtime -------------------------------------------------

  async function handleRuntimeEvent(event: RuntimeEvent): Promise<void> {
    if (terminalReason !== null) {
      ignoredAfterTerminal += 1;
      return;
    }

    switch (event.type) {
      case "transcript_final": {
        const segmentId = event.segment.segmentId;
        if (settledTurns.has(segmentId) || openTurns.has(segmentId)) return; // redelivery

        // Final segments only: a partial is neither transcript nor evidence.
        if (event.segment.final) {
          liveTranscript.push(event.segment);
          coordinator.appendReconciliationLiveSegment(identity.occurrenceId, {
            bridgeSessionId, segmentId: event.segment.segmentId, text: event.segment.text,
            startedAt: event.segment.startedAt, endedAt: event.segment.endedAt,
          });
        }

        const meetingSegment = {
          segmentId,
          text: event.segment.text,
          final: event.segment.final,
        };

        if (speaking === "aborted") {
          // Higher priority than the gate: the runtime is still TOLD to stay
          // silent -- silence is a decision it is informed of, not an absence
          // of one -- but no branch here can authorize. Meeting knowledge
          // still accrues: capture is not gated on the ability to speak.
          retrievalRouter.prepare(meetingSegment);
          await runtime.skipVoiceResponse({
            sessionId: requireRuntimeSessionId(),
            segmentId,
            reason: "speaking_aborted",
          }).catch((error: unknown) => {
            runtimeErrors.push({ segmentId, error });
          });
          settle(segmentId, "skipped", "speaking_aborted");
          return;
        }

        // Read by sink.authorizeVoiceResponse if the gate authorizes this
        // segment below; discarded either way once consumed there or in
        // sink.skipVoiceResponse.
        pendingQueryText.set(segmentId, event.segment.text);
        turnGenerations.set(segmentId, cancellationGeneration);
        const decision = decide(event.segment, agentIdentity);
        dispatcher.apply(decision);

        // Recorded into current-meeting memory AFTER dispatching the
        // decision, deliberately: sink.authorizeVoiceResponse (above) runs
        // its retrieval search SYNCHRONOUSLY up to its first await, inside
        // dispatcher.apply's own call stack -- so recording this segment
        // before that point would let a question answer ITSELF (its own
        // text trivially "covers" its own query terms, which would make
        // every current-meeting search look sufficient and the Team Vault
        // never get reached). Recording here means this segment becomes
        // available to LATER questions without ever being retrievable by
        // its own.
        retrievalRouter.prepare(meetingSegment);

        if (decision.authorize) {
          openTurns.add(segmentId);
        } else {
          settle(segmentId, "skipped", decision.reason);
        }
        return;
      }

      case "response_authorized":
        settle(event.segmentId, "spoken", null);
        return;

      case "response_skipped":
        settle(event.segmentId, "skipped", event.reason);
        return;

      case "barge_in":
        settle(event.segmentId, "barged_in", null);
        return;

      case "provider_unavailable":
        abortSpeaking("provider_unavailable");
        for (const segmentId of [...openTurns]) {
          settle(segmentId, "failed", "provider_unavailable");
        }
        return;
    }
  }

  // ---- termination ------------------------------------------------------

  /** A `left` is terminal for the session, for every reason the contract
   * declares -- `bridge_failure` included. bridge-session/v1 has no re-open,
   * so resuming a meeting means a NEW session against a NEW lease, which is
   * the coordinator's business, not this session's. */
  async function terminate(
    reason: "ended" | "removed" | "bridge_failure",
    terminalAtMs?: number,
    terminalSource: "bridge_observed" | "local_clock" = "local_clock",
  ): Promise<void> {
    if (terminalReason !== null) return;
    terminalReason = reason;
    phase = "ended";

    try {
      for (const segmentId of [...openTurns]) {
        settle(segmentId, "failed", "session_ended");
      }

      // Finalization runs BEFORE the terminal transition, deliberately: the
      // recording handle does not exist until the runtime returns it, and the
      // two have to be written together. See applyTerminalTransition.
      await finalizeRecording();
      if (reason === "bridge_failure") {
        const persistedRecording = recording === null ? null : recordingInput(recording, observedGaps);
        coordinator.recordBridgeFailure(
          identity.occurrenceId,
          bridgeFailureRetryLimit,
          observedGaps.map((gap) => ({ ...gap })),
          persistedRecording,
        );
        // This bridge generation is over even when recovery will create a
        // fresh one; its local wording must not remain a live generation.
        coordinator.completeReconciliationGeneration(identity.occurrenceId, bridgeSessionId, terminalAtMs, terminalSource);
      } else {
        applyTerminalTransition(reason, terminalAtMs, terminalSource);
      }
    } finally {
      // In a `finally`, because a finalization that throws must not leave the
      // session subscribed to two planes it has already declared itself
      // terminal for. The failure itself is on `state().finalizationError`;
      // losing the subscriptions on top of it would make the session
      // "structurally deaf after a left" false in exactly the branch where it
      // matters most.
      if (reconciliationGenerationStarted) {
        try {
          coordinator.completeReconciliationGeneration(identity.occurrenceId, bridgeSessionId, terminalAtMs, terminalSource);
        } catch (error) {
          routingErrors.push({ source: "join_cleanup", error });
        }
      }
      await closeRuntime();
      releaseLease(reason === "bridge_failure" ? "bridge_failure" : "left");
      unsubscribe();
      markInactive();
    }
  }

  /** Applies the session's terminal edge, WITH the finalized recording in the
   * same store transaction when there is one.
   *
   * "listening" -> "finalizing" is the only forward edge a `left` can take. A
   * session that never reached "listening" (a bridge that left mid-join) has
   * no such edge, and leaving the row stranded in "joining" forever is worse
   * than recording the truth: it failed, for the reason the bridge gave.
   *
   * When finalization failed there is no handle to write, so the transition
   * goes in alone -- the session really did end, and refusing to record that
   * because the recording was lost would strand the occurrence on top of
   * losing the audio. */
  function applyTerminalTransition(
    reason: "ended" | "removed" | "bridge_failure",
    terminalAtMs?: number,
    terminalSource: "bridge_observed" | "local_clock" = "local_clock",
  ): void {
    try {
      const state = coordinator.get(identity.occurrenceId)?.state ?? null;
      if (state === null || state === "notified" || state === "failed") return;

      const outcome: TerminalOutcome =
        reason === "bridge_failure"
          ? { kind: "fail", terminalReason: "bridge_failure" }
          : state === "listening"
            ? { kind: "advance", toState: "finalizing" }
            : { kind: "fail", terminalReason: reason };

      if (recording !== null) {
        coordinator.finalizeWithRecording(identity.occurrenceId, outcome, recordingInput(recording, observedGaps), bridgeSessionId, terminalAtMs, terminalSource);
        return;
      }
      if (outcome.kind === "fail") {
        coordinator.fail(identity.occurrenceId, outcome.terminalReason);
      } else {
        coordinator.advance(identity.occurrenceId, outcome.toState);
      }
    } finally {
      coordinator.completeReconciliationGeneration(identity.occurrenceId, bridgeSessionId, terminalAtMs, terminalSource);
    }
  }

  /**
   * Closes the recording. NEVER THROWS -- every failure lands on
   * `finalizationError` instead, so terminate() can always go on to apply the
   * session's terminal transition.
   *
   * The bridge's exact observed gaps stay in `observedGaps`; the SDK has no
   * gap-rewrite method, so its own bigint media-timeline gaps are retained in
   * the returned RecordingSummary without being compared or mutated.
   */
  async function finalizeRecording(): Promise<void> {
    if (finalized) return;
    finalized = true;

    if (runtimeSessionId === null) return;
    try {
      recording = await runtime.finalizeRecording({ sessionId: runtimeSessionId });
    } catch (error) {
      // Recorded as its own typed fact rather than a generic routing error:
      // "there is no recording" and "finalization was attempted and failed"
      // need different operator responses, and `recording === null` alone
      // cannot tell them apart. Read it together with `recording`:
      //   recording null + error set     -> nothing was finalized;
      //   recording set  + error set     -> the handle is safe, the gap
      //                                     reconciliation is not (see
      //                                     gapReconciliation).
      // There is no retry -- runtime finalization is not known to be
      // idempotent, and re-running it is not this session's call to make.
      finalizationError = error;
    }
  }

  /** Releases everything join() had already taken, and makes the session
   * terminal for `reason`. Terminal, not merely "already joined": a retry
   * means a NEW session against a NEW lease, exactly as after a `left`. */
  async function closeRuntime(): Promise<void> {
    if (!runtimeStartAttempted || runtimeClosed) return;
    runtimeClosed = true;
    try {
      await runtime.close();
    } catch (error) {
      routingErrors.push({ source: "join_cleanup", error });
    }
  }

  /** Cleanup must never replace the operation failure that triggered it. The
   * coordinator's lease release is synchronous, so isolate its possible store
   * error here just as closeRuntime isolates the remote close failure. */
  function releaseLease(reason: "left" | "bridge_failure"): void {
    if (leaseId === null) return;
    const activeLeaseId = leaseId;
    leaseId = null;
    try {
      coordinator.releaseBridgeLease(identity.occurrenceId, activeLeaseId, reason);
    } catch (error) {
      routingErrors.push({ source: "join_cleanup", error });
    }
  }

  async function failJoin(reason: string): Promise<void> {
    if (terminalReason !== null) return;
    terminalReason = reason;
    phase = "ended";
    abortSpeaking(reason);
    try {
      if (joinCommandSent) {
        try {
          await issue({ type: "leave", reason: "coordinator_stop" });
        } catch (error) {
          routingErrors.push({ source: "join_cleanup", error });
        }
      }
      if (runtimeStartAttempted) await finalizeRecording();
      await closeRuntime();
      releaseLease("bridge_failure");
      const state = coordinator.get(identity.occurrenceId)?.state ?? null;
      if (state !== null && state !== "notified" && state !== "failed") {
        coordinator.fail(identity.occurrenceId, reason);
      }
    } catch (error) {
      // A store failure while cleaning up must NOT replace the error that
      // actually failed the join: join()'s caller needs to know why the join
      // failed, not that the tidy-up afterwards also failed. Recorded, and
      // swallowed here so the original error is what join() rethrows.
      routingErrors.push({ source: "join_cleanup", error });
    } finally {
      if (reconciliationGenerationStarted) {
        try {
          coordinator.completeReconciliationGeneration(identity.occurrenceId, bridgeSessionId);
        } catch (error) {
          routingErrors.push({ source: "join_cleanup", error });
        }
      }
      // Same reason as terminate()'s finally: a cleanup that throws must not
      // leave the session subscribed to two planes it has already declared
      // itself terminal for.
      unsubscribe();
      markInactive();
    }
  }

  function unsubscribe(): void {
    const bridgeUnsubscribe = unsubscribeBridge;
    const runtimeUnsubscribe = unsubscribeRuntime;
    unsubscribeBridge = null;
    unsubscribeRuntime = null;
    for (const cleanup of [bridgeUnsubscribe, runtimeUnsubscribe]) {
      if (cleanup === null) continue;
      try {
        cleanup();
      } catch (error) {
        routingErrors.push({ source: "join_cleanup", error });
      }
    }
  }

  function markInactive(): void {
    inactiveRequested = true;
    if (inactiveNotified || activeJoinPromise !== null) return;
    inactiveNotified = true;
    options.onInactive?.();
  }

  function assertJoinCanContinue(): void {
    if (disposed || terminalReason !== null) {
      throw new Error("meeting session join was cancelled because the session was disposed or became terminal");
    }
  }

  async function performJoin(): Promise<void> {
    if (disposed) throw new Error("meeting session was disposed and cannot join");
    if (terminalReason !== null) {
      throw new Error(
        `meeting session is terminal ("${terminalReason}"); bridge-session/v1 has no re-open, so resuming means a new session against a new lease`,
      );
    }
    if (phase !== "created") {
      throw new Error(`meeting session has already joined (phase "${phase}")`);
    }

    phase = "joining";
    const existing = coordinator.get(identity.occurrenceId);
    if (existing?.state === "discovered") coordinator.advance(identity.occurrenceId, "joining");
    else if (existing?.state !== "listening") {
      throw new Error(`occurrence cannot start a bridge generation from state "${existing?.state ?? "missing"}"`);
    }
    try {
      const lease = coordinator.acquireBridgeLease(identity.occurrenceId, {
        bridgeId,
        bridgeSessionId,
      });
      leaseId = lease.leaseId;
      coordinator.beginReconciliationGeneration(identity.occurrenceId, bridgeSessionId);
      reconciliationGenerationStarted = true;

      unsubscribeBridge = bridge.subscribe((raw) => {
        enqueue({ source: "bridge", raw });
      });
      unsubscribeRuntime = runtime.subscribe((event) => {
        enqueue({ source: "runtime", event });
      });

      await issue({
        type: "join",
        meetingOccurrenceId: identity.occurrenceId,
        meetingNo: identity.meetingNo,
        leaseId: lease.leaseId,
      });
      assertJoinCanContinue();

      runtimeStartAttempted = true;
      const handle = await runtime.startVoiceSession({
        profile: PINNED_PROFILE,
        responseMode: PINNED_RESPONSE_MODE,
      });
      runtimeSessionId = handle.sessionId;
      coordinator.setReconciliationRuntimeSession(identity.occurrenceId, bridgeSessionId, handle.sessionId);
      assertJoinCanContinue();
      if (handle.profile !== PINNED_PROFILE) {
        abortSpeaking("profile_mismatch");
      } else if (handle.responseMode !== PINNED_RESPONSE_MODE) {
        abortSpeaking("response_mode_mismatch");
      } else if (handle.status !== "ready") {
        abortSpeaking(`runtime_${handle.status}`);
      }

      await issue({ type: "connect_media", ...handle.media });
      assertJoinCanContinue();

      try {
        await disclosurePublisher.publish(disclosureText);
      } catch {
        disclosure = "failed";
      }
      assertJoinCanContinue();
    } catch (error) {
      await failJoin(error instanceof BridgeContractError ? "media_format_rejected" : "join_failed");
      throw error;
    }
  }

  // ---- public surface ---------------------------------------------------

  return {
    bridgeSessionId,

    join(): Promise<void> {
      if (activeJoinPromise !== null) {
        return Promise.reject(new Error(`meeting session has already joined (phase "${phase}")`));
      }
      const operation = performJoin();
      activeJoinPromise = operation;
      void operation.finally(() => {
        if (activeJoinPromise === operation) activeJoinPromise = null;
        if (inactiveRequested) markInactive();
      }).catch(() => {});
      return operation;
    },

    async leave(reason: "meeting_ended" | "coordinator_stop"): Promise<void> {
      if (terminalReason !== null) return;
      await issue({ type: "leave", reason });
    },

    state(): MeetingSessionState {
      return {
        phase,
        speaking,
        speakingAbortReason,
        runtimeSessionId,
        bridgeConnected,
        mediaConnected,
        reconnectAttempts,
        disclosure,
        observedGaps: [...observedGaps],
        recording,
        finalizationError,
        gapReconciliation,
        terminalReason,
        commandResults: [...commandResults],
        overflows: [...overflows],
        maxQueuedEvents,
        queuedEvents: queue.length,
        routedEventTypes: [...routedEventTypes],
        rejectedInbound: [...rejectedInbound],
        ignoredAfterTerminal,
        runtimeErrors: [...runtimeErrors],
        routingErrors: [...routingErrors],
        speakerEvidence: [...speakerEvidence],
        liveTranscript: [...liveTranscript],
      };
    },

    turns(): readonly TurnRecord[] {
      return [...turns];
    },

    settled(): Promise<void> {
      return whenIdle();
    },

    dispose(): Promise<void> {
      if (disposePromise !== null) return disposePromise;
      if (disposed) return Promise.resolve();
      disposed = true;
      cancellationGeneration += 1;
      queue.length = 0;
      disposePromise = (async () => {
        try {
          const join = activeJoinPromise;
          if (join !== null) await Promise.allSettled([join]);
          await whenIdle();
          if (terminalReason === null && phase !== "created") {
            if (joinCommandSent) {
              try { await issue({ type: "leave", reason: "coordinator_stop" }); }
              catch (error) { routingErrors.push({ source: "join_cleanup", error }); }
            }
            await terminate("removed");
          } else {
            await closeRuntime();
            unsubscribe();
          }
        } catch (error) {
          routingErrors.push({ source: "join_cleanup", error });
        } finally {
          markInactive();
        }
      })();
      return disposePromise;
    },
  };
}

/** The orchestration schema currently stores a SQLite number. Refuse a value
 * outside JavaScript's exact integer range rather than silently truncating an
 * SDK bigint; the complete bigint remains in MeetingSessionState regardless. */
function recordingInput(summary: RecordingSummary, bridgeGaps: readonly ObservedAudioGap[]): RecordingInput {
  if (summary.durationMs > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("runtime recording duration exceeds SQLite's exact numeric representation");
  }
  return {
    handle: summary.recordingHandle,
    encryptedPath: summary.encryptedPath,
    sha256: summary.sha256,
    durationMs: Number(summary.durationMs),
    format: summary.format,
    keyId: summary.keyId,
    // These are bridge-observed control-plane gaps, deliberately independent
    // from RecordingSummary.gaps' runtime media timeline and reason tokens.
    gaps: bridgeGaps.map((gap) => ({ ...gap })),
    runtimeGaps: summary.gaps.map((gap) => ({ ...gap })),
  };
}
