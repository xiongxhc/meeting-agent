import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  StdioGatewayTransport,
  type RuntimeTransport,
  type StdioGatewayCleanupOutcome,
  type StdioGatewayCleanupTimeouts,
  type StdioGatewayStartOptions,
} from "@conversation/runtime";

import { connectPostmeetingRuntime, type PostmeetingRuntime } from "../adapters/conversation-runtime-client.ts";
import type { MeetingIdentity } from "../domain/meeting.ts";
import { RECOGNITION_OUTAGE_WARNING } from "../domain/transcript.ts";
import type { OperatorWarningSink } from "../ports/operator-warning.ts";
import type {
  AlignmentAttempt,
  BackfillBuildFailure,
  BackfillDeliveryAuthority,
  BackfillJobClaim,
  BackfillSeedBuildClaim,
  SessionStore,
} from "../ports/session-store.ts";
import { RecordingAlignmentOwner } from "../sessions/recording-alignment.ts";
import {
  assertClosedTimedEvidence,
  readClosedTimedAttendance,
  reconcilePersistedTimedSpeakers,
} from "../sessions/speaker-reconciler.ts";
import { buildTimedTeamMemMeetingArtifactV2 } from "./artifact-builder.ts";
import { PARTIAL_AUDIO_WARNING, mergeGenerationAttendance, mergeGenerationTranscripts, publishedGaps } from "./generation-merge.ts";
import type { OutboxWorker } from "./outbox-worker.ts";

const DEFAULT_OPERATION_BUDGET_MS = 900_000;
const DEFAULT_CLEANUP_TIMEOUTS: StdioGatewayCleanupTimeouts = {
  eofGraceMs: 5_000,
  termGraceMs: 1_000,
  killGraceMs: 1_000,
};

type BackfillClaim =
  | ({ readonly kind: "initial" } & BackfillSeedBuildClaim)
  | ({ readonly kind: "retry" } & BackfillJobClaim);

type BackfillRuntime = PostmeetingRuntime & { readonly currentSessionId: bigint };

export type BackfillGatewayTransport = RuntimeTransport & {
  readonly cleanupOutcome: StdioGatewayCleanupOutcome | undefined;
  close(): Promise<void>;
};

export type BackfillPollResult =
  | { readonly kind: "idle" }
  | { readonly kind: "stopped"; readonly occurrenceId: string }
  | { readonly kind: "enqueued"; readonly occurrenceId: string; readonly revision: number; readonly bundlePath: string }
  | { readonly kind: "rescheduled"; readonly occurrenceId: string; readonly reason: BackfillBuildFailure["reason"];
      /** Set when the post-meeting Runtime reported a profile other than the
       * meeting's pinned one: a configuration fault no retry will clear. */
      readonly refusal?: "profile_mismatch" };

export type BackfillWorker = {
  pollOnce(): Promise<BackfillPollResult>;
  close(): Promise<void>;
};

export type BackfillWarningPollResult =
  | { readonly kind: "idle" }
  | { readonly kind: "accepted"; readonly occurrenceId: string; readonly key: string }
  | { readonly kind: "rescheduled"; readonly occurrenceId: string };

export type BackfillWarningWorker = {
  pollOnce(): Promise<BackfillWarningPollResult>;
  close(): Promise<void>;
};

export type BackfillWorkerOptions = {
  readonly store: SessionStore;
  readonly outbox: Pick<OutboxWorker, "enqueue">;
  readonly gatewayPath: string;
  readonly configPath: string;
  /** Exact replacement environment for the owned gateway child. */
  readonly env: Readonly<Record<string, string>>;
  readonly operationBudgetMs?: number;
  readonly cleanupTimeouts?: StdioGatewayCleanupTimeouts;
  readonly clock: { now(): number; monotonicNow(): number };
  readonly random: () => number;
  readonly proveExclusiveOwnership?: (attempt: AlignmentAttempt) => Promise<void>;
  /** Exact project names TeamMem has published, or null when unreadable. */
  readonly readKnownProjects: () => readonly string[] | null;
  /** Narrow deterministic test seam; production always uses Runtime's owner. */
  readonly startTransport?: (options: StdioGatewayStartOptions) => Promise<BackfillGatewayTransport>;
  readonly connectRuntime?: (transport: RuntimeTransport) => Promise<BackfillRuntime>;
};

class PostmeetingProfileMismatch extends Error {
  constructor() { super("postmeeting Runtime profile differs from the meeting's pinned profile"); }
}

export function createBackfillWorker(options: BackfillWorkerOptions): BackfillWorker {
  if (!path.isAbsolute(options.gatewayPath)) throw new Error("backfill worker requires an absolute gateway path");
  if (!path.isAbsolute(options.configPath)) throw new Error("backfill worker requires an absolute config path");
  const operationBudgetMs = options.operationBudgetMs ?? DEFAULT_OPERATION_BUDGET_MS;
  if (!Number.isInteger(operationBudgetMs) || operationBudgetMs < 1_000 || operationBudgetMs > 900_000) {
    throw new Error("backfill operation budget must be an integer from 1000 through 900000 ms");
  }
  const cleanupTimeouts = validateCleanupTimeouts(options.cleanupTimeouts ?? DEFAULT_CLEANUP_TIMEOUTS);
  const cleanupReserveMs = cleanupTimeouts.eofGraceMs + cleanupTimeouts.termGraceMs + cleanupTimeouts.killGraceMs;
  if (operationBudgetMs <= cleanupReserveMs) throw new Error("backfill operation budget must exceed its cleanup reserve");
  const env = validateEnvironment(options.env);
  const startTransport = options.startTransport ?? ((input: StdioGatewayStartOptions) => StdioGatewayTransport.start(input));
  const connectRuntime = options.connectRuntime ?? (async (transport: RuntimeTransport): Promise<BackfillRuntime> => {
    const connected = await connectPostmeetingRuntime(transport);
    if (typeof connected.currentSessionId !== "bigint") throw new Error("Postmeeting Runtime did not supply a control session identity");
    return connected as BackfillRuntime;
  });
  let inFlight: Promise<BackfillPollResult> | undefined;
  let closing = false;
  let cancelCurrent: (() => void) | undefined;
  let poison: AggregateError | undefined;

  async function pollOnce(): Promise<BackfillPollResult> {
    if (poison) throw poison;
    if (closing) throw new Error("backfill worker is closed");
    if (inFlight) throw new Error("backfill worker already has an in-flight attempt");
    const work = poll();
    inFlight = work;
    try { return await work; }
    finally { if (inFlight === work) inFlight = undefined; }
  }

  async function poll(): Promise<BackfillPollResult> {
    const nowMs = validClock(options.clock.now());
    const stopped = options.store.stopDueBackfill({ nowMs });
    if (stopped) return { kind: "stopped", occurrenceId: stopped.occurrenceId };
    const initialToken = claimToken();
    const initial = options.store.claimBackfillSeedBuild({ nowMs, claimToken: initialToken, operationBudgetMs });
    let claim: BackfillClaim | null = initial === null ? null : { kind: "initial", ...initial };
    if (claim === null) {
      const retryToken = claimToken();
      const retry = options.store.claimBackfillJob({ nowMs, claimToken: retryToken, operationBudgetMs });
      claim = retry === null ? null : { kind: "retry", ...retry };
    }
    if (claim === null) return { kind: "idle" };
    return runClaim(claim);
  }

  async function runClaim(claim: BackfillClaim): Promise<BackfillPollResult> {
    const allowanceMs = Math.min(operationBudgetMs,
      claim.seed.stopAtMs - claim.observedAtMs, claim.seed.expiresAtMs - claim.observedAtMs);
    const workMs = allowanceMs - cleanupReserveMs;
    if (!Number.isSafeInteger(allowanceMs) || workMs <= 0) {
      return reschedule(claim, "build_failed");
    }

    const startMono = validMonotonic(options.clock.monotonicNow());
    const abort = new AbortController();
    let transport: BackfillGatewayTransport | undefined;
    let runtime: BackfillRuntime | undefined;
    let alignment: RecordingAlignmentOwner | undefined;
    let closePromise: Promise<readonly unknown[]> | undefined;
    const lateCleanupFailures: unknown[] = [];
    let phase: BackfillBuildFailure["reason"] = "runtime_failed";

    const closeOwned = (): Promise<readonly unknown[]> => {
      if (closePromise) return closePromise;
      if (!alignment && !runtime && !transport) return Promise.resolve([]);
      closePromise = (async () => {
        const alignmentClose = alignment?.close() ?? Promise.resolve();
        // Normal completion preserves the alignment-before-Runtime dependency.
        // Cancellation starts Runtime close immediately so a blocked iterator
        // can actually terminate inside the reserved process-cleanup budget.
        const afterAlignment = alignmentClose.then(() => undefined, () => undefined);
        const runtimeClose = abort.signal.aborted
          ? (runtime?.close() ?? Promise.resolve())
          : afterAlignment.then(() => runtime?.close());
        const afterRuntime = runtimeClose.then(() => undefined, () => undefined);
        const transportClose = afterRuntime.then(() => transport?.close());
        const results = await Promise.allSettled([alignmentClose, runtimeClose, transportClose]);
        return results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      })();
      return closePromise;
    };
    const cancel = () => {
      abort.abort();
      void closeOwned();
    };
    const process = options.store.beginBackfillProcess(claim.kind === "initial"
      ? { kind: "initial", occurrenceId: claim.seed.occurrenceId, claimToken: claim.claimToken,
          nowMs: validClock(options.clock.now()) }
      : { kind: "retry", occurrenceId: claim.seed.occurrenceId, claimToken: claim.claimToken,
          targetRevision: claim.targetRevision, nowMs: validClock(options.clock.now()) });
    cancelCurrent = cancel;
    const timer = setTimeout(cancel, workMs);

    let built: Awaited<ReturnType<typeof buildTimedTeamMemMeetingArtifactV2>> | undefined;
    let bodyFailure: unknown;
    try {
      transport = await startTransport({ gatewayPath: options.gatewayPath, configPath: options.configPath,
        protocolVersion: 4, env, cleanupTimeouts, startupAbortSignal: abort.signal });
      if (abort.signal.aborted) {
        try { await transport.close(); } catch (error) { lateCleanupFailures.push(error); }
        throw new Error("backfill work cancelled during Runtime start");
      }
      const connected = await connectRuntime(transport);
      runtime = connected;
      if (abort.signal.aborted) {
        try { await connected.close(); } catch (error) { lateCleanupFailures.push(error); }
        throw new Error("backfill work cancelled during Runtime connect");
      }
      // The pinned profile binds post-meeting work too: a Runtime reporting
      // another profile is refused, so the artifact's profile, taken from the
      // Runtime that runs the synthesis, is always the meeting's.
      if (connected.runtimeProfile !== claim.seed.provenance.runtimeProfile) {
        throw new PostmeetingProfileMismatch();
      }
      alignment = new RecordingAlignmentOwner({ store: options.store, runtime: connected,
        ...(options.proveExclusiveOwnership ? { proveExclusiveOwnership: options.proveExclusiveOwnership } : {}) });
      phase = "alignment_failed";
      const recovery = options.store.getRecordingRecovery(claim.seed.occurrenceId,
        claim.seed.bridgeSessionId, claim.seed.capability.recordingHandle);
      if (!recovery || recovery.generationId !== claim.seed.generationId ||
          recovery.capability.sourceSessionId !== claim.seed.capability.sourceSessionId ||
          recovery.capability.recordingHandle !== claim.seed.capability.recordingHandle ||
          recovery.capability.sha256 !== claim.seed.capability.sha256 ||
          recovery.capability.keyId !== claim.seed.capability.keyId ||
          recovery.capability.authorization !== claim.seed.capability.authorization) {
        throw new Error("backfill recording recovery binding changed");
      }
      if (options.proveExclusiveOwnership) await alignment.recover(recovery.generationId);
      const selected = await alignment.stage(recovery);
      const closed = { occurrenceId: claim.seed.occurrenceId, bridgeSessionId: claim.seed.bridgeSessionId,
        recordingHandle: claim.seed.capability.recordingHandle, store: options.store,
        nowMs: () => options.clock.now(), signal: abort.signal };
      const attendance = await readClosedTimedAttendance(closed);
      const shippedTranscript = await reconcilePersistedTimedSpeakers({ ...closed, runtime: connected });
      // Every other generation of the occurrence, each reconciled with its own
      // stored recovery capability, joins the one transcript and attendance.
      const generations = options.store.listRecordingGenerations(claim.seed.occurrenceId);
      const others: { ordinal: number; transcript: Awaited<ReturnType<typeof reconcilePersistedTimedSpeakers>> }[] = [];
      const intervals = [...attendance.attendance];
      const otherGaps: { direction: "capture" | "playback"; startedAt: string; endedAt: string | null; closeAtEnd: boolean }[] = [];
      // A failed generation's gaps; the last one's open gaps run to the end
      // when no generation observed it (no successor closes them).
      const failedGaps = (attempt: number, last: boolean) => (options.store.getBridgeFailureRecording(claim.seed.occurrenceId, attempt)?.gaps ?? [])
        .map((gap) => ({ direction: gap.direction, startedAt: gap.startedAt, endedAt: gap.endedAt, closeAtEnd: last }));
      for (const [index, generation] of generations.entries()) {
        const last = index === generations.length - 1;
        if (generation.generationId === recovery.generationId) {
          if (claim.seed.bridgeGaps.length === 0 && generation.failureAttempt !== null) otherGaps.push(...failedGaps(generation.failureAttempt, last));
          continue;
        }
        if (options.proveExclusiveOwnership) await alignment.recover(generation.generationId);
        await alignment.stage(generation);
        const own = { ...closed, bridgeSessionId: generation.bridgeSessionId, recordingHandle: generation.recordingHandle };
        intervals.push(...(await readClosedTimedAttendance(own)).attendance);
        others.push({ ordinal: index + 1, transcript: await reconcilePersistedTimedSpeakers({ ...own, runtime: connected }) });
        if (generation.failureAttempt !== null) otherGaps.push(...failedGaps(generation.failureAttempt, last));
      }
      const reconciled = mergeGenerationTranscripts(shippedTranscript, others);
      const shippedOrdinal = generations.findIndex((generation) => generation.generationId === recovery.generationId) + 1;
      const generationWarnings = generations.length > 1
        ? [{ code: PARTIAL_AUDIO_WARNING, detail: `shipped_generation=${shippedOrdinal};generations=${generations.length}` }] : [];
      // A live recognition outage is covered only by final (recording) wording;
      // with none, the transcript is incomplete for that span. Publication proceeds.
      const outage = claim.seed.processingWarnings.some(({ code }) => code === RECOGNITION_OUTAGE_WARNING);
      const finalWords = reconciled.segments.some((segment) => segment.wording === "reconciled" && segment.text.trim() !== "");
      const transcript = outage && !finalWords ? { ...reconciled, transcriptComplete: false } : reconciled;
      phase = "build_failed";
      built = await buildTimedTeamMemMeetingArtifactV2({
        identity: { occurrenceId: claim.seed.occurrenceId as MeetingIdentity["occurrenceId"], providerMeetingId: claim.seed.providerMeetingId,
          meetingNo: claim.seed.meetingNo, occurrenceStartedAt: claim.seed.occurrenceStartedAt,
          title: claim.seed.title, organizer: claim.seed.organizer },
        provider: claim.seed.provider,
        revision: claim.targetRevision,
        endedAt: claim.seed.endedAt,
        attendance: mergeGenerationAttendance(intervals),
        transcript,
        selectedAlignment: selected,
        sessionId: connected.currentSessionId,
        runtime: connected,
        meetingEnded: true,
        recordingGaps: publishedGaps({ seedGaps: claim.seed.bridgeGaps, otherGaps,
          occurrenceStartedAt: claim.seed.occurrenceStartedAt, endedAt: claim.seed.endedAt }),
        processingWarnings: [...claim.seed.processingWarnings, ...generationWarnings],
        provenance: { ...claim.seed.provenance, runtimeProfile: connected.runtimeProfile,
          processedAt: new Date(validClock(options.clock.now())).toISOString() },
        knownProjects: options.readKnownProjects(),
        ...(claim.kind === "retry" && claim.noVerbatimQuotes === true ? { noVerbatimQuotes: true } : {}),
        audio: { format: claim.seed.recordingFormat, encryption: claim.seed.recordingEncryption,
          durationSeconds: claim.seed.recordingDurationMs / 1000, bytes: claim.seed.recordingBytes,
          sha256: `sha256:${claim.seed.recordingSha256}`, expiresAt: new Date(claim.seed.expiresAtMs).toISOString() },
      });
      const finishedMono = validMonotonic(options.clock.monotonicNow());
      if (finishedMono < startMono) throw new Error("backfill monotonic clock moved backwards");
      if (finishedMono - startMono >= workMs || abort.signal.aborted) {
        throw new Error("backfill work deadline elapsed");
      }
    } catch (error) {
      bodyFailure = error;
    }

    const cleanupFailures = [...await closeOwned(), ...lateCleanupFailures];
    clearTimeout(timer);
    cancelCurrent = undefined;
    const outcome = transport?.cleanupOutcome;
    const cleanupConfirmed = cleanupFailures.length === 0 && outcome !== undefined && outcome.status !== "failed";
    if (!cleanupConfirmed) {
      const errors = [...(bodyFailure === undefined ? [] : [bodyFailure]), ...cleanupFailures];
      if (outcome === undefined) errors.push(new Error("Runtime cleanup outcome is unavailable"));
      else if (outcome.status === "failed") errors.push(new Error(`Runtime cleanup failed: ${outcome.reason}`));
      try {
        options.store.settleBackfillProcess({ occurrenceId: claim.seed.occurrenceId,
          processOwnerToken: process.processOwnerToken, outcome: "failed", nowMs: validClock(options.clock.now()) });
      } catch (error) { errors.push(error); }
      poison = new AggregateError(errors, "backfill process cleanup was not confirmed");
      throw poison;
    }

    try {
      options.store.settleBackfillProcess({ occurrenceId: claim.seed.occurrenceId,
        processOwnerToken: process.processOwnerToken, outcome: "confirmed", nowMs: validClock(options.clock.now()) });
    } catch (error) {
      poison = new AggregateError([error], "confirmed backfill process cleanup could not be settled");
      throw poison;
    }
    if (bodyFailure instanceof PostmeetingProfileMismatch) {
      const result = reschedule(claim, phase, bodyFailure);
      return result.kind === "rescheduled" ? { ...result, refusal: "profile_mismatch" } : result;
    }
    if (bodyFailure !== undefined || built === undefined) return reschedule(claim, phase, bodyFailure);

    try {
      assertClosedTimedEvidence({ occurrenceId: claim.seed.occurrenceId, bridgeSessionId: claim.seed.bridgeSessionId,
        recordingHandle: claim.seed.capability.recordingHandle, store: options.store, nowMs: () => options.clock.now() });
      const nowMs = validClock(options.clock.now());
      const authority: BackfillDeliveryAuthority = claim.kind === "initial"
        ? { kind: "initial", claimToken: claim.claimToken, nowMs }
        : { kind: "retry", claimToken: claim.claimToken, targetRevision: claim.targetRevision, nowMs };
      const bundlePath = options.outbox.enqueue({ artifact: built.artifact, serializedArtifact: built.serialized,
        artifactHash: built.artifact_hash, recordingPath: claim.seed.recordingPath, backfillAuthority: authority });
      return { kind: "enqueued", occurrenceId: claim.seed.occurrenceId, revision: claim.targetRevision, bundlePath };
    } catch (error) {
      const canonical = options.store.pending().find((row) => row.occurrenceId === claim.seed.occurrenceId &&
        row.revision === claim.targetRevision && row.artifactHash === built.artifact_hash &&
        row.recoveryArtifact === built.serialized && row.deletedAtMs === null);
      if (canonical) return { kind: "enqueued", occurrenceId: claim.seed.occurrenceId,
        revision: claim.targetRevision, bundlePath: canonical.bundlePath };
      return reschedule(claim, "build_failed", error);
    }
  }

  function reschedule(claim: BackfillClaim, reason: BackfillBuildFailure["reason"], cause?: unknown): BackfillPollResult {
    const nowMs = validClock(options.clock.now());
    const sample = options.random();
    if (!Number.isFinite(sample) || sample < 0 || sample > 1) throw new Error("backfill retry random source is invalid");
    const retryDelayMs = 1_000 + Math.floor(sample * 59_000);
    try {
      const result = options.store.failBackfillBuild(claim.kind === "initial"
        ? { kind: "initial", occurrenceId: claim.seed.occurrenceId, claimToken: claim.claimToken,
            nowMs, retryDelayMs, reason }
        : { kind: "retry", occurrenceId: claim.seed.occurrenceId, claimToken: claim.claimToken,
            targetRevision: claim.targetRevision, nowMs, retryDelayMs, reason });
      if (result.kind === "stopped") return { kind: "stopped", occurrenceId: claim.seed.occurrenceId };
    } catch (persistFailure) {
      throw new AggregateError([...(cause === undefined ? [] : [cause]), persistFailure], "backfill failure could not be persisted");
    }
    return { kind: "rescheduled", occurrenceId: claim.seed.occurrenceId, reason };
  }

  async function close(): Promise<void> {
    closing = true;
    cancelCurrent?.();
    await inFlight;
    if (poison) throw poison;
  }

  return { pollOnce, close };
}

export function createBackfillWarningWorker(options: {
  readonly store: Pick<SessionStore, "claimBackfillWarning" | "acceptBackfillWarning" | "failBackfillWarning">;
  readonly sink: OperatorWarningSink;
  readonly clock: { now(): number };
  readonly random: () => number;
}): BackfillWarningWorker {
  let inFlight: Promise<BackfillWarningPollResult> | undefined;
  let closing = false;

  async function pollOnce(): Promise<BackfillWarningPollResult> {
    if (closing) throw new Error("backfill warning worker is closed");
    if (inFlight) throw new Error("backfill warning worker already has an in-flight attempt");
    const work = poll();
    inFlight = work;
    try { return await work; }
    finally { if (inFlight === work) inFlight = undefined; }
  }

  async function poll(): Promise<BackfillWarningPollResult> {
    const claim = options.store.claimBackfillWarning({ nowMs: validClock(options.clock.now()), claimToken: claimToken() });
    if (claim === null) return { kind: "idle" };
    try {
      const receipt = await options.sink.accept({ key: claim.key, payload: claim.payload });
      if (receipt.key !== claim.key) throw new Error("operator warning receipt key mismatch");
      options.store.acceptBackfillWarning({ occurrenceId: claim.occurrenceId, claimToken: claim.claimToken,
        key: receipt.key, nowMs: validClock(options.clock.now()) });
      return { kind: "accepted", occurrenceId: claim.occurrenceId, key: receipt.key };
    } catch {
      const nowMs = validClock(options.clock.now());
      const sample = options.random();
      if (!Number.isFinite(sample) || sample < 0 || sample > 1) throw new Error("backfill warning retry random source is invalid");
      const retryDelayMs = 1_000 + Math.floor(sample * 59_000);
      options.store.failBackfillWarning({ occurrenceId: claim.occurrenceId, claimToken: claim.claimToken,
        nowMs, retryDelayMs, reason: "sink_failed" });
      return { kind: "rescheduled", occurrenceId: claim.occurrenceId };
    }
  }

  async function close(): Promise<void> {
    closing = true;
    await inFlight;
  }

  return { pollOnce, close };
}

function validateCleanupTimeouts(value: StdioGatewayCleanupTimeouts): StdioGatewayCleanupTimeouts {
  const values = [value.eofGraceMs, value.termGraceMs, value.killGraceMs];
  if (values.some((entry) => !Number.isInteger(entry) || entry < 1 || entry > 30_000) ||
      values.reduce((sum, entry) => sum + entry, 0) > 60_000) {
    throw new Error("backfill gateway cleanup timeouts are invalid");
  }
  return Object.freeze({ ...value });
}

function validateEnvironment(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, entry] of Object.entries(value)) {
    if (name.length === 0 || name.includes("=") || name.includes("\0") || typeof entry !== "string" || entry.includes("\0")) {
      throw new Error("backfill gateway environment is invalid");
    }
    result[name] = entry;
  }
  return Object.freeze(result);
}

function validClock(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("backfill wall clock is invalid");
  return value;
}

function validMonotonic(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("backfill monotonic clock is invalid");
  return value;
}

function claimToken(): string {
  return randomUUID().replaceAll("-", "");
}
