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
import { createRuntimeInvocationSink } from "../adapters/conversation-runtime-client.ts";
import type { MeetingIdentity } from "../domain/meeting.ts";
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
  RecordingGap,
  RecordingHandle,
  RuntimeEvent,
} from "../ports/conversation-runtime.ts";
import type { Clock, SessionCoordinator, TerminalOutcome } from "./coordinator.ts";
import {
  createInvocationDispatcher,
  decide,
  type InvocationGateIdentity,
} from "./invocation-gate.ts";

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
  readonly source: "bridge" | "runtime";
  readonly error: unknown;
};

/** Whether the finalized recording's own gap accounting matched what the
 * bridge observed. `unreconciled` is the case that must never pass silently:
 * the runtime was asked to reconcile and still disagreed. */
export type GapReconciliation = "not_needed" | "reconciled" | "unreconciled";

export type MeetingSessionState = {
  readonly phase: MeetingSessionPhase;
  readonly speaking: SpeakingState;
  readonly speakingAbortReason: string | null;
  readonly runtimeSessionId: string | null;
  readonly bridgeConnected: boolean;
  readonly mediaConnected: boolean;
  readonly reconnectAttempts: number;
  readonly disclosure: "pending" | DisclosureOutcome;
  readonly observedGaps: readonly ObservedAudioGap[];
  readonly recording: RecordingHandle | null;
  /** Why there is no recording, when there is none. `recording === null` alone
   * cannot distinguish "the session never finalized" from "finalization was
   * attempted and threw", and those need different operator responses. */
  readonly finalizationError: unknown;
  readonly gapReconciliation: GapReconciliation;
  readonly terminalReason: string | null;
  readonly commandResults: readonly BridgeCommandResult[];
  readonly overflows: readonly QueueOverflow[];
  readonly maxQueuedEvents: number;
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
  /** Per-session cancellation: unsubscribes both planes and discards anything
   * still queued. Idempotent, and safe before join. */
  dispose(): void;
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
  /** Injected so command ids are deterministic under test. Defaults to a
   * per-session counter, which is already deterministic. */
  readonly nextCommandId?: () => string;
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
  let runtimeSessionId: string | null = null;
  let bridgeConnected = true;
  let mediaConnected = false;
  let reconnectAttempts = 0;
  let disclosure: "pending" | DisclosureOutcome = "pending";
  let recording: RecordingHandle | null = null;
  let finalizationError: unknown = null;
  let gapReconciliation: GapReconciliation = "not_needed";
  let terminalReason: string | null = null;
  let ignoredAfterTerminal = 0;
  let leaseId: string | null = null;
  let finalized = false;
  let disposed = false;

  const observedGaps: ObservedAudioGap[] = [];
  const commandResults: BridgeCommandResult[] = [];
  const overflows: QueueOverflow[] = [];
  const routedEventTypes: string[] = [];
  const rejectedInbound: InboundRejection[] = [];
  const runtimeErrors: RuntimeCallFailure[] = [];
  const routingErrors: RoutingFailure[] = [];
  const turns: TurnRecord[] = [];
  const settledTurns = new Set<string>();
  const openTurns = new Set<string>();

  let unsubscribeBridge: (() => void) | null = null;
  let unsubscribeRuntime: (() => void) | null = null;

  // The gate's sink and dispatcher. The dispatcher owns "one decision applied
  // per segmentId"; this module never re-derives a decision.
  const sink = createRuntimeInvocationSink(runtime, (segmentId, error) => {
    runtimeErrors.push({ segmentId, error });
  });
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
    turns.push({ segmentId, outcome, detail, atMs: clock.now() });
  }

  function abortSpeaking(reason: string): void {
    if (speaking === "aborted") return; // The first reason is the true one.
    speaking = "aborted";
    speakingAbortReason = reason;
  }

  // ---- bounded queue ----------------------------------------------------

  const queue: QueueItem[] = [];
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
      if (item.source === "bridge" && looksLikeTerminalLeft(item.raw)) {
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
   * or malformed message is rejected there exactly as before -- the worst a
   * lie can buy is one queue slot. */
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
        coordinator.advance(identity.occurrenceId, "listening");
        return;

      case "left":
        await terminate(event.reason);
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

      // Attendance is reduced by src/domain/participants.ts and speaker
      // identity is reconciled in a later task. Routed and counted here so the
      // "every routed type is a declared contract type" evidence is complete.
      case "participant_joined":
      case "participant_left":
      case "active_speaker":
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

        if (speaking === "aborted") {
          // Higher priority than the gate: the runtime is still TOLD to stay
          // silent -- silence is a decision it is informed of, not an absence
          // of one -- but no branch here can authorize.
          await runtime.skipVoiceResponse(segmentId, "speaking_aborted").catch((error: unknown) => {
            runtimeErrors.push({ segmentId, error });
          });
          settle(segmentId, "skipped", "speaking_aborted");
          return;
        }

        const decision = decide(event.segment, agentIdentity);
        dispatcher.apply(decision);
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
  async function terminate(reason: "ended" | "removed" | "bridge_failure"): Promise<void> {
    if (terminalReason !== null) return;
    terminalReason = reason;
    phase = "ended";

    try {
      for (const segmentId of [...openTurns]) {
        settle(segmentId, "failed", "session_ended");
      }

      if (leaseId !== null) {
        coordinator.releaseBridgeLease(
          identity.occurrenceId,
          leaseId,
          reason === "bridge_failure" ? "bridge_failure" : "left",
        );
        leaseId = null;
      }

      // Finalization runs BEFORE the terminal transition, deliberately: the
      // recording handle does not exist until the runtime returns it, and the
      // two have to be written together. See applyTerminalTransition.
      await finalizeRecording();
      applyTerminalTransition(reason);
    } finally {
      // In a `finally`, because a finalization that throws must not leave the
      // session subscribed to two planes it has already declared itself
      // terminal for. The failure itself is on `state().finalizationError`;
      // losing the subscriptions on top of it would make the session
      // "structurally deaf after a left" false in exactly the branch where it
      // matters most.
      unsubscribe();
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
  function applyTerminalTransition(reason: "ended" | "removed" | "bridge_failure"): void {
    const state = coordinator.get(identity.occurrenceId)?.state ?? null;
    if (state === null || state === "notified" || state === "failed") return;

    const outcome: TerminalOutcome =
      reason === "bridge_failure"
        ? { kind: "fail", terminalReason: "bridge_failure" }
        : state === "listening"
          ? { kind: "advance", toState: "finalizing" }
          : { kind: "fail", terminalReason: reason };

    if (recording !== null) {
      coordinator.finalizeWithRecording(identity.occurrenceId, outcome, recording);
      return;
    }
    if (outcome.kind === "fail") {
      coordinator.fail(identity.occurrenceId, outcome.terminalReason);
    } else {
      coordinator.advance(identity.occurrenceId, outcome.toState);
    }
  }

  async function finalizeRecording(): Promise<void> {
    if (finalized) return;
    finalized = true;

    const observed: RecordingGap[] = observedGaps.map((gap) => ({ ...gap }));
    let handle: RecordingHandle;
    try {
      handle = await runtime.finalizeRecording({ observedGaps: observed });
    } catch (error) {
      // Recorded as its own typed fact rather than a generic routing error:
      // "there is no recording" and "finalization was attempted and failed"
      // need different operator responses, and `recording === null` alone
      // cannot tell them apart. There is no retry -- runtime finalization is
      // not known to be idempotent, and re-running it is not this session's
      // call to make.
      finalizationError = error;
      return;
    }

    // "Exact gap recording": the stored gaps must be the gaps the bridge
    // actually observed. If the runtime's own accounting disagrees, the bridge
    // is authoritative -- it is the thing that watched the media socket -- so
    // the runtime is asked to reconcile against it rather than the difference
    // being averaged away or silently preferred.
    if (!gapsEqual(handle.gaps, observed)) {
      handle = await runtime.reconcileRecording({ gaps: observed });
      gapReconciliation = gapsEqual(handle.gaps, observed) ? "reconciled" : "unreconciled";
    }
    recording = handle;
  }

  /** Releases everything join() had already taken, and makes the session
   * terminal for `reason`. Terminal, not merely "already joined": a retry
   * means a NEW session against a NEW lease, exactly as after a `left`. */
  function failJoin(reason: string): void {
    if (terminalReason !== null) return;
    terminalReason = reason;
    phase = "ended";
    abortSpeaking(reason);
    if (leaseId !== null) {
      coordinator.releaseBridgeLease(identity.occurrenceId, leaseId, "bridge_failure");
      leaseId = null;
    }
    const state = coordinator.get(identity.occurrenceId)?.state ?? null;
    if (state !== null && state !== "notified" && state !== "failed") {
      coordinator.fail(identity.occurrenceId, reason);
    }
    unsubscribe();
  }

  function unsubscribe(): void {
    unsubscribeBridge?.();
    unsubscribeRuntime?.();
    unsubscribeBridge = null;
    unsubscribeRuntime = null;
  }

  // ---- public surface ---------------------------------------------------

  return {
    bridgeSessionId,

    async join(): Promise<void> {
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
      coordinator.advance(identity.occurrenceId, "joining");
      const lease = coordinator.acquireBridgeLease(identity.occurrenceId, {
        bridgeId,
        bridgeSessionId,
      });
      leaseId = lease.leaseId;

      unsubscribeBridge = bridge.subscribe((raw) => {
        enqueue({ source: "bridge", raw });
      });
      unsubscribeRuntime = runtime.subscribe((event) => {
        enqueue({ source: "runtime", event });
      });

      // ONE cleanup for every way the rest of join can fail. The lease is
      // already taken by this point, and nothing sweeps an abandoned one: the
      // coordinator recovers a stale lease only inside a subsequent
      // acquireBridgeLease for the SAME occurrence, which for a join that
      // failed will never come. A runtime outage or a transport failure here
      // would otherwise strand the occurrence permanently -- lease live, both
      // planes subscribed, the row sitting in "joining" with no terminal
      // reason and no way to retry.
      try {
        await issue({
          type: "join",
          meetingOccurrenceId: identity.occurrenceId,
          meetingNo: identity.meetingNo,
          leaseId: lease.leaseId,
        });

        // Exactly one runtime session, with both values pinned explicitly. The
        // runtime's own default profile stays "offline"; nothing here switches
        // it silently, and nothing accepts a substitute.
        const handle = await runtime.startVoiceSession({
          occurrenceId: identity.occurrenceId,
          profile: PINNED_PROFILE,
          responseMode: PINNED_RESPONSE_MODE,
        });
        runtimeSessionId = handle.runtimeSessionId;

        if (handle.profile !== PINNED_PROFILE) {
          abortSpeaking("profile_mismatch");
        } else if (handle.responseMode !== PINNED_RESPONSE_MODE) {
          abortSpeaking("response_mode_mismatch");
        } else if (handle.status !== "ready") {
          abortSpeaking(`runtime_${handle.status}`);
        }

        await issue({ type: "connect_media", ...handle.media });
      } catch (error) {
        // A descriptor the contract refuses is one the bridge would refuse
        // too, and it keeps its own, more specific reason so an operator can
        // tell a bad media format from a runtime outage at a glance. Everything
        // else is a plain failed join.
        failJoin(error instanceof BridgeContractError ? "media_format_rejected" : "join_failed");
        throw error;
      }

      // Disclosure is meeting-chat TEXT, attempted by the bridge alone, and
      // failing to disclose never blocks joining -- which is why it sits
      // OUTSIDE the cleanup above and can never trigger it.
      try {
        await disclosurePublisher.publish(disclosureText);
      } catch {
        disclosure = "failed";
      }
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
        routedEventTypes: [...routedEventTypes],
        rejectedInbound: [...rejectedInbound],
        ignoredAfterTerminal,
        runtimeErrors: [...runtimeErrors],
        routingErrors: [...routingErrors],
      };
    },

    turns(): readonly TurnRecord[] {
      return [...turns];
    },

    settled(): Promise<void> {
      if (!pumping && queue.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      queue.length = 0;
      unsubscribe();
    },
  };
}

/** Field-for-field, order-sensitive gap comparison. Deliberately not a set or
 * a subset test: "exact" means the same gaps in the same order, and two gaps
 * that merged into one are a different recording. */
function gapsEqual(a: readonly RecordingGap[], b: readonly RecordingGap[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((gap, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      gap.direction === other.direction &&
      gap.startedAt === other.startedAt &&
      gap.endedAt === other.endedAt
    );
  });
}
