import { setImmediate as yieldTurn } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import type { VersionFourVoiceTranscriptFinalEvent } from "@conversation/runtime";
import { parseEventV2, type BridgeEventMessageV2, type UiSnapshot } from "../contracts/bridge-session-v2.ts";
import type { ProvisionalResult, SessionStore, TimedAppendResult, TimedEvidenceBinding, TimedEvidenceOwner } from "../ports/session-store.ts";
import { decodeLiveEvidence, encodeLiveEvidence } from "./live-evidence-codec.ts";
import { mintLiveRecoveryPermit } from "../ports/live-evidence-authority.ts";

export type ProvisionalResolution = { readonly segmentId: string; readonly result: ProvisionalResult };
export type LiveCatchupClock = { now(): number; schedule(callback: () => void, delayMs: number): () => void };
const realCatchupClock: LiveCatchupClock = { now: () => performance.now(), schedule(callback, delayMs) {
  const timer = setTimeout(callback, delayMs); return () => clearTimeout(timer);
} };
type Pending = { event: VersionFourVoiceTranscriptFinalEvent; deadline: number; cancel(): void };
type Options = { store: SessionStore; binding: TimedEvidenceBinding; nowMs(): number;
  catchupClock?: LiveCatchupClock; onResult?(resolution: ProvisionalResolution): void };
type Run = { id: string; start: bigint; end: bigint; activation: bigint | null };
const TWO_SECONDS_NS = 2_000_000_000n;

/** Observed UI coverage only: these snapshots cannot prove physical continuity
 * between polls. A coverage envelope is never an utterance timestamp/duration. */
function coverage(events: readonly BridgeEventMessageV2[], final: VersionFourVoiceTranscriptFinalEvent): ProvisionalResult | null {
  const envelope = final.liveCoverage;
  if (!final.capture || !envelope) return { kind: "anonymous", reason: "timing_unavailable" };
  const attendance = new Map<string, bigint>(); // At most the bounded observation count.
  let previous: UiSnapshot | null = null;
  const state: { run: Run | null } = { run: null };
  let watermark: bigint | null = null;
  let failure: Extract<ProvisionalResult, { kind: "anonymous" }>["reason"] = "coverage_missing";
  for (const event of events) {
    if (!("observationTiming" in event) || event.observationTiming === null || event.observationTiming.clockDomainId !== final.capture.clockDomainId) {
      previous = null; state.run = null; attendance.clear(); failure = "coverage_barrier"; continue;
    }
    const before = BigInt(event.observationTiming.hostBeforeNs), after = BigInt(event.observationTiming.hostAfterNs);
    if (event.type === "participant_joined") { attendance.set(event.feishuUserId, after); continue; }
    if (event.type === "participant_left") { attendance.delete(event.feishuUserId); if (state.run?.id === event.feishuUserId) { state.run = null; previous = null; } continue; }
    if (event.type === "active_speaker") {
      if (event.confidence === "ambiguous" || (state.run !== null && state.run.id !== event.feishuUserId)) { previous = null; state.run = null; failure = "identity_ambiguous"; }
      continue;
    }
    if (event.type !== "ui_snapshot") { previous = null; state.run = null; continue; }
    const priorTiming: UiSnapshot["observationTiming"] | undefined = previous?.observationTiming;
    const ordered: boolean = priorTiming !== null && priorTiming !== undefined && BigInt(priorTiming.hostAfterNs) <= before;
    const adjacent: boolean = ordered && priorTiming !== null && priorTiming !== undefined && after - BigInt(priorTiming.hostBeforeNs) <= TWO_SECONDS_NS;
    if (event.barrierBefore !== null || !adjacent) { previous = null; state.run = null; failure = "coverage_barrier"; }
    if (event.state !== "ui_exact" || event.feishuUserId === null) {
      state.run = null; previous = event;
      failure = event.state === "ambiguous" ? "identity_ambiguous" : "coverage_barrier";
      continue;
    }
    watermark = before;
    if (state.run?.id === event.feishuUserId && adjacent) state.run.end = before;
    else {
      const changed: boolean = previous !== null && ((previous.state === "unknown" && previous.reason === "no_highlight") ||
        (previous.state === "ui_exact" && previous.feishuUserId !== event.feishuUserId));
      // The previous read may have happened at the start of its bracket. A
      // transition could follow immediately; neither its bracket end nor the
      // next positive read is a conservative earliest activation coordinate.
      state.run = { id: event.feishuUserId, start: after, end: before,
        activation: changed && priorTiming ? BigInt(priorTiming.hostBeforeNs) : null };
    }
    previous = event;
    const run = state.run;
    if (run.start <= envelope.hostStartNs && run.end >= envelope.hostEndNs) {
      if (run.activation === null || run.activation < envelope.firstFrameHostEndNs - TWO_SECONDS_NS) return { kind: "anonymous", reason: "activation_not_fresh" };
      const joined = attendance.get(run.id);
      if (joined === undefined || joined > envelope.hostStartNs) return { kind: "anonymous", reason: "attendance_missing" };
      return { kind: "provisional_ui_observed", feishuUserId: run.id };
    }
  }
  return watermark !== null && watermark >= envelope.hostEndNs ? { kind: "anonymous", reason: failure } : null;
}

export class LiveProvisionalCorrelator {
  private readonly options: Options;
  private readonly owner: TimedEvidenceOwner;
  private readonly clock: LiveCatchupClock;
  private observations: BridgeEventMessageV2[] = [];
  private readonly pending = new Map<string, Pending>();
  private domain: string | null = null;
  // Tombstones consume the same bounded slots as observations, never a second
  // growing history. Once exhausted, no further domain can safely be admitted.
  private readonly retiredDomains = new Set<string>();
  private domainBudgetExhausted = false;
  private epoch: bigint | null = null;
  private lastSequence = 0;
  private lastSnapshotSequence = 0;
  private lastHost: { before: bigint; after: bigint } | null = null;
  private stopped = false;
  private storageLost = false;
  private closing: Promise<void> | undefined;
  private failure: unknown = null;
  constructor(options: Options) {
    this.options = options; this.clock = options.catchupClock ?? realCatchupClock;
    this.owner = options.store.beginTimedEvidence(options.binding, options.nowMs());
  }
  observe(raw: unknown): void {
    if (this.stopped) return;
    let event: BridgeEventMessageV2;
    try { event = parseEventV2(raw); } catch (error) { this.invalidateCoverage(); throw error; }
    if (event.sessionId !== this.owner.bridgeSessionId) throw new Error("timed observation changed bridge generation");
    let appended: TimedAppendResult;
    try { appended = this.options.store.appendTimedUi(this.owner, event, this.options.nowMs()); }
    catch (error) {
      this.storageLost = true; this.failure ??= error;
      try { this.invalidateCoverage(); } catch { /* Original failure remains owned through close. */ }
      throw error;
    }
    if (appended === "duplicate") return;
    if (appended !== "inserted") { this.storageLost = true; this.barrier(appended === "expired" ? "evidence_expired" : "ui_storage_loss"); return; }
    if (event.sequence <= this.lastSequence) { this.invalidateCoverage("ui_sequence_gap"); return; }
    if (this.lastSequence !== 0 && event.sequence !== this.lastSequence + 1) this.invalidateCoverage("ui_sequence_gap");
    this.lastSequence = event.sequence;
    if (event.type === "media_disconnected" || event.type === "reconnecting" || event.type === "left") { this.barrier("coverage_barrier"); return; }
    if (!("observationTiming" in event)) return;
    if (event.observationTiming !== null) {
      const nextDomain = event.observationTiming.clockDomainId;
      if (this.retiredDomains.has(nextDomain)) { this.invalidateCoverage(); return; }
      if (this.domainBudgetExhausted) { this.barrier("observation_limit"); return; }
      if (this.domain !== null && this.domain !== nextDomain) {
        this.barrier("generation_changed"); this.lastHost = null; this.epoch = null;
        this.retiredDomains.add(this.domain);
        if (this.retiredDomains.size === 4096) { this.domainBudgetExhausted = true; return; }
      }
      this.domain = nextDomain;
      const before = BigInt(event.observationTiming.hostBeforeNs), after = BigInt(event.observationTiming.hostAfterNs);
      if (this.lastHost !== null && (before < this.lastHost.before || after < this.lastHost.after)) { this.invalidateCoverage(); return; }
      this.lastHost = { before, after };
    }
    if (event.type === "ui_snapshot") {
      if (event.snapshotSequence <= this.lastSnapshotSequence) { this.invalidateCoverage("ui_sequence_gap"); return; }
      if (this.lastSnapshotSequence !== 0 && event.snapshotSequence !== this.lastSnapshotSequence + 1) this.invalidateCoverage("ui_sequence_gap");
      this.lastSnapshotSequence = event.snapshotSequence;
      if (event.barrierBefore !== null) this.barrier("coverage_barrier", event.barrierBefore === "stream_start");
    }
    if (this.observations.length + this.retiredDomains.size === 4096) this.barrier("observation_limit");
    this.observations.push(event);
    this.resolveReady();
  }
  /** Invalid/missing observations are durable loss, never invisible holes. */
  invalidateCoverage(reason: "ui_invalid" | "ui_sequence_gap" = "ui_invalid"): void {
    if (this.stopped) return;
    try { this.options.store.markTimedUiLoss(this.owner, reason, this.options.nowMs()); }
    catch (error) { this.storageLost = true; this.failure ??= error; throw error; }
    finally { this.barrier("coverage_barrier"); }
  }
  noteWordingDrop(): void {
    if (this.stopped) return;
    try { this.options.store.markTimedWordingLoss(this.owner, "runtime_queue_overflow", this.options.nowMs()); }
    catch (error) { this.failure ??= error; throw error; }
  }
  finalize(event: VersionFourVoiceTranscriptFinalEvent): TimedAppendResult {
    if (this.stopped) throw new Error("live evidence owner closed");
    const result = this.options.store.appendTimedFinal(this.owner, event, this.options.nowMs());
    if (result !== "inserted") return result;
    const admitted = decodeLiveEvidence(encodeLiveEvidence(event), event.text);
    if (this.storageLost) { this.resolve(event.segmentId, { kind: "anonymous", reason: "ui_storage_loss" }); return result; }
    if (this.domainBudgetExhausted) { this.resolve(event.segmentId, { kind: "anonymous", reason: "observation_limit" }); return result; }
    if (admitted.capture) {
      if (this.domain !== null && admitted.capture.clockDomainId !== this.domain) { this.resolve(event.segmentId, { kind: "anonymous", reason: "generation_changed" }); return result; }
      this.domain ??= admitted.capture.clockDomainId;
      if (this.epoch !== null && admitted.capture.captureEpoch < this.epoch) { this.resolve(event.segmentId, { kind: "anonymous", reason: "generation_changed" }); return result; }
      if (this.epoch !== null && admitted.capture.captureEpoch !== this.epoch) this.barrier("generation_changed");
      this.epoch = admitted.capture.captureEpoch;
    }
    const immediate = coverage(this.observations, admitted);
    if (immediate) { this.resolve(event.segmentId, immediate); return result; }
    if (this.pending.size === 32) { this.resolve(event.segmentId, { kind: "anonymous", reason: "pending_limit" }); return result; }
    const deadline = this.clock.now() + 2000;
    const cancel = this.clock.schedule(() => {
      if (this.stopped) return;
      try { this.resolve(event.segmentId, { kind: "anonymous", reason: "catchup_timeout" }); }
      catch (error) { this.failure ??= error; }
    }, 2000);
    this.pending.set(event.segmentId, { event: admitted, deadline, cancel });
    return result;
  }
  private resolveReady(): void {
    for (const [id, pending] of this.pending) {
      const result = this.clock.now() >= pending.deadline ? { kind: "anonymous" as const, reason: "catchup_timeout" as const } : coverage(this.observations, pending.event);
      if (result) this.resolve(id, result);
    }
  }
  private resolve(segmentId: string, result: ProvisionalResult): void {
    this.pending.get(segmentId)?.cancel();
    const now = this.options.nowMs();
    const status = this.options.store.getTimedEvidenceStatus(this.owner, now);
    const actual: ProvisionalResult = status === null ? { kind: "anonymous", reason: "evidence_expired" } : result;
    const committed = this.options.store.resolveTimedFinal(this.owner, segmentId, actual, now);
    this.pending.delete(segmentId);
    if (committed) this.options.onResult?.({ segmentId, result: actual });
  }
  private barrier(reason: Extract<ProvisionalResult, { kind: "anonymous" }>["reason"], retainInitialAttendance = false): void {
    // The native first snapshot follows same-read participant events. Keeping
    // those facts does not keep any speaker state/coverage across stream start.
    this.observations = retainInitialAttendance ? this.observations.filter((event) => event.type === "participant_joined" || event.type === "participant_left") : [];
    for (const id of this.pending.keys()) this.resolve(id, { kind: "anonymous", reason });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    for (const pending of this.pending.values()) pending.cancel();
    this.closing = Promise.resolve().then(() => {
      this.observations = [];
      this.retiredDomains.clear();
      for (const id of this.pending.keys()) {
        try { this.resolve(id, { kind: "anonymous", reason: "owner_closed" }); } catch (error) { this.failure ??= error; }
      }
      try { this.options.store.closeTimedEvidence(this.owner, this.options.nowMs()); } catch (error) { this.failure ??= error; }
      if (this.failure !== null) throw this.failure;
    });
    return this.closing;
  }
}

/** Caller must await this owned drain before closing its store. Cancellation
 * leaves expired (already unreadable) rows for the next explicit drain. */
export async function drainExpiredTimedEvidence(store: SessionStore, nowMs: number, signal?: AbortSignal): Promise<void> {
  while (true) {
    signal?.throwIfAborted();
    if (!store.purgeExpiredTimedEvidenceBatch(nowMs).pending) return;
    await yieldTurn(undefined, signal ? { signal } : undefined);
  }
}

/** The callback is a TRUSTED supervisor/application precondition, not a claim
 * that JavaScript can cryptographically prove its caller reaped another process.
 * SQLite open, elapsed time and absent local objects are never that authority.
 * Caller owns and awaits this operation before closing its store. */
export async function recoverPendingLiveEvidence(options: {
  store: SessionStore; binding: TimedEvidenceBinding; nowMs(): number;
  exclusivePriorOwnerClosed(): Promise<void>;
}): Promise<void> {
  const prior = options.store.getTimedRecoveryOwner(options.binding, options.nowMs());
  if (!prior) return;
  await options.exclusivePriorOwnerClosed();
  const owner = options.store.beginTimedRecovery(prior, mintLiveRecoveryPermit(prior), options.nowMs());
  while (options.store.settleTimedRecoveryBatch(owner, options.nowMs())) {
    await yieldTurn();
  }
  options.store.closeTimedEvidence(owner, options.nowMs());
}
