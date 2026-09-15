import { z } from "zod";
import type { RecordingAlignmentPage, RecordingAlignmentComplete, RecordingAlignmentEntry } from "@conversation/runtime";
import { randomUUID } from "node:crypto";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import type { ConversationRuntimePort } from "../ports/conversation-runtime.ts";
import type { AlignmentAttempt, RecordingRecovery, SelectedAlignment, SessionStore } from "../ports/session-store.ts";
import { mintAlignmentRecoveryPermit } from "../ports/recording-alignment-authority.ts";

export const ALIGNMENT_LIMITS = Object.freeze({ pageBytes: 32 * 1024, pageEntries: 64,
  attemptBytes: 256 * 1024 * 1024, attemptEntries: 2_000_000, attemptPages: 250_000 });
export const ALIGNMENT_POLICY = Object.freeze({ id: "local-wall-estimate/v1" as const,
  cadenceTargetNs: 1_000_000_000n, maximumBracketNs: 5_000_000n,
  maximumPairGapNs: 2_000_000_000n, maximumResidualNs: 10_000_000n });
const u64 = z.bigint().min(0n).max((1n << 64n) - 1n), positive = u64.refine((n) => n > 0n);
const i64 = z.bigint().min(-(1n << 63n)).max((1n << 63n) - 1n);
const u32 = z.number().int().min(1).max(0xffffffff);
const identifier = z.string().min(1).max(64).refine((s) => Buffer.byteLength(s) <= 64);
const reason = z.enum(["source_drop", "sequence_hole", "reconnect", "pause", "epoch_reset", "missing_timing",
  "inconsistent_coordinates", "source_discontinuity", "alignment_limit_exceeded", "audio_missing", "capture_alignment_missing",
  "wall_alignment_missing", "wall_clock_discontinuity", "clock_pair_gap", "clock_bracket_exceeded", "missing_clock_pair",
  "clock_domain_mismatch", "arithmetic_overflow", "local_wall_timestamp_estimate", "unavailable_legacy"]);
const reasons = z.array(reason).max(20).refine((items) => new Set(items).size === items.length);
const source = z.strictObject({ sourceSessionId: positive, recordingHandle: z.string().regex(/^[0-9a-f]{32}$/), sha256: z.string().regex(/^[0-9a-f]{64}$/) });
const epoch = z.strictObject({ bridgeSessionId: identifier, clockDomainId: identifier, captureEpoch: positive });
const span = z.strictObject({ hostStartNs: positive, hostEndNs: positive, roundingEnvelopeNs: u64, captureUncertaintyNs: u64.nullable() })
  .refine((s) => s.hostEndNs > s.hostStartNs);
const provenance = z.strictObject({ captureEpoch: positive, sequence: positive, outputStartSample: u64, sampleCount: u32,
  sourceStartNumerator: u64, sourceEndNumerator: u64, sourceDenominator: u32, sourceRateHz: u32,
  quality: z.enum(["nominal_frame_endpoint_interpolation", "unknown_clock", "unknown_priming", "filter_edge", "incomplete_source_coverage"]), span: span.nullable() })
  .refine((p) => p.outputStartSample + BigInt(p.sampleCount) <= (1n << 64n) - 1n &&
    p.sourceStartNumerator === p.outputStartSample * BigInt(p.sourceRateHz) &&
    p.sourceEndNumerator === (p.outputStartSample + BigInt(p.sampleCount)) * BigInt(p.sourceRateHz) &&
    (p.span !== null) === (p.quality === "nominal_frame_endpoint_interpolation"));
const wall = z.strictObject({ quality: z.literal("local_wall_estimate"), policyId: z.literal("local-wall-estimate/v1"),
  localStartNs: i64, localEndNs: i64, wallEpoch: positive, wallRun: positive, maximumBracketNs: u64.max(5_000_000n),
  maximumResolutionNs: u64, modelAllowanceNs: z.literal(10_000_000n), interpolationRoundingNs: u64, captureRoundingNs: u64,
  captureUncertaintyNs: u64.nullable(), externalUtcAccuracyNs: u64.nullable(), overallPhysicalAccuracyNs: z.null() })
  .refine((w) => w.localStartNs <= w.localEndNs);
const entry: z.ZodType<RecordingAlignmentEntry> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("epoch"), epoch }),
  z.strictObject({ kind: z.literal("clock_pair"), pair: z.strictObject({ clockDomainId: identifier, wallEpoch: positive,
    sequence: positive, hostBeforeNs: positive, localUnixNs: i64, hostAfterNs: positive, wallResolutionNs: u64,
    externalUtcAccuracyNs: u64.nullable() }).refine((p) => p.hostBeforeNs <= p.hostAfterNs) }),
  z.strictObject({ kind: z.literal("discontinuity"), captureEpoch: positive, reason }),
  z.strictObject({ kind: z.literal("audio_gap"), startedAtMs: u64, endedAtMs: u64.nullable(), reason: z.literal("capture_discontinuity") })
    .refine((g) => g.endedAtMs === null || g.endedAtMs >= g.startedAtMs),
  z.strictObject({ kind: z.literal("alignment_limit") }),
  z.strictObject({ kind: z.literal("frame"), mediaStartSample: u64, mediaEndSample: u64, sampleRateHz: u32, gapOffsetMs: u64,
    epoch: epoch.nullable(), provenance: provenance.nullable(), captureStatus: z.enum(["available", "capture_alignment_missing"]),
    wall: wall.nullable(), reasons }).refine((f) => f.mediaEndSample > f.mediaStartSample &&
      (f.provenance === null || (f.provenance.sourceDenominator === f.sampleRateHz &&
        BigInt(f.provenance.sampleCount) === f.mediaEndSample - f.mediaStartSample && f.provenance.captureEpoch === f.epoch?.captureEpoch)) &&
      (f.captureStatus !== "available" || f.provenance?.span !== null && f.provenance?.span !== undefined) &&
      (f.wall === null || f.captureStatus === "available")),
]);
const pageSchema: z.ZodType<RecordingAlignmentPage> = z.strictObject({ type: z.literal("recording_alignment_page"), source,
  pageIndex: u64, policy: z.strictObject({ id: z.literal(ALIGNMENT_POLICY.id), cadenceTargetNs: z.literal(ALIGNMENT_POLICY.cadenceTargetNs),
    maximumBracketNs: z.literal(ALIGNMENT_POLICY.maximumBracketNs), maximumPairGapNs: z.literal(ALIGNMENT_POLICY.maximumPairGapNs),
    maximumResidualNs: z.literal(ALIGNMENT_POLICY.maximumResidualNs) }), entries: z.array(entry).min(1).max(64) });
const completeSchema: z.ZodType<RecordingAlignmentComplete> = z.strictObject({ type: z.literal("recording_alignment_complete"), source,
  pageCount: u64, coverageStatus: z.enum(["available", "partial", "unavailable_legacy"]), warnings: reasons, traversalSucceeded: z.literal(true) });

/** This is a bounded PRIVATE storage representation of SDK-parsed values. It is
 * not the vendor/runtime network protocol; the installed SDK remains its parser. */
export function encodeAlignmentPage(page: RecordingAlignmentPage): string {
  try {
    if (!Array.isArray(page.entries) || page.entries.length > ALIGNMENT_LIMITS.pageEntries ||
      page.entries.some((item) => item.kind === "frame" && (!Array.isArray(item.reasons) || item.reasons.length > 20))) throw new Error();
    const checked = pageSchema.parse(page);
    const encoded = JSON.stringify({ schema: 1, page: checked }, (_key, value: unknown) => typeof value === "bigint"
      ? { bigint: value < 0n ? "i64" : "u64", decimal: value.toString() } : value);
    if (Buffer.byteLength(encoded) > ALIGNMENT_LIMITS.pageBytes) throw new Error();
    return encoded;
  } catch { throw new Error("invalid private alignment page"); }
}

export function decodeAlignmentPage(encoded: string): RecordingAlignmentPage {
  try {
    if (typeof encoded !== "string" || encoded.length > ALIGNMENT_LIMITS.pageBytes || Buffer.byteLength(encoded) > ALIGNMENT_LIMITS.pageBytes) throw new Error();
    const parsed: unknown = JSON.parse(encoded, (_key, value: unknown) => {
      if (value !== null && typeof value === "object" && Object.hasOwn(value, "bigint")) {
        const tag = z.strictObject({ bigint: z.enum(["u64", "i64"]), decimal: z.string().max(20) }).parse(value);
        if (!(tag.bigint === "u64" ? /^(0|[1-9][0-9]*)$/ : /^-[1-9][0-9]*$/).test(tag.decimal)) throw new Error();
        return (tag.bigint === "u64" ? u64 : i64).parse(BigInt(tag.decimal));
      }
      return value;
    });
    return z.strictObject({ schema: z.literal(1), page: pageSchema }).parse(parsed).page;
  } catch { throw new Error("invalid private alignment page"); }
}

export function validateAlignmentComplete(value: RecordingAlignmentComplete): RecordingAlignmentComplete {
  try { return completeSchema.parse(value); } catch { throw new Error("invalid private alignment completion"); }
}

export function pageWarnings(page: RecordingAlignmentPage): readonly string[] {
  const warnings = new Set<string>();
  for (const item of page.entries) {
    if (item.kind === "frame") {
      for (const warning of item.reasons) warnings.add(warning);
      if (item.wall !== null) warnings.add("local_wall_timestamp_estimate");
    }
    if (item.kind === "discontinuity") {
      warnings.add(item.reason);
      if (item.reason === "missing_timing" || item.reason === "inconsistent_coordinates") warnings.add("capture_alignment_missing");
    }
    if (item.kind === "audio_gap") warnings.add("audio_missing");
    if (item.kind === "alignment_limit") warnings.add("alignment_limit_exceeded");
  }
  return [...warnings].sort();
}

type AlignmentIterator = AsyncIterator<RecordingAlignmentPage | RecordingAlignmentComplete>;
type ActiveAlignment = { attempt: AlignmentAttempt; iterator: AlignmentIterator | null;
  work: Promise<SelectedAlignment>; cleanup?: Promise<void>; cancelled: boolean };

/** One shared owner, at most one reader. This is a component admission bound,
 * not a meeting/capture limit. It owns neither Runtime transport nor SQLite. */
export class RecordingAlignmentOwner {
  private readonly ownerId = randomUUID();
  private readonly store: SessionStore;
  private readonly runtime: Pick<ConversationRuntimePort, "readRecordingAlignment">;
  private readonly proveExclusiveOwnership: ((attempt: AlignmentAttempt) => Promise<void>) | undefined;
  private active: ActiveAlignment | undefined;
  private recovering = false;
  private recoveryWork: Promise<void> | undefined;
  private closed = false;

  constructor(options: { store: SessionStore; runtime: Pick<ConversationRuntimePort, "readRecordingAlignment">;
    /** TRUSTED supervisor/application lifecycle precondition, not cryptographic
     * proof. It must reject overlap and actually await owned child reap. */
    proveExclusiveOwnership?: (attempt: AlignmentAttempt) => Promise<void> }) {
    this.store = options.store; this.runtime = options.runtime; this.proveExclusiveOwnership = options.proveExclusiveOwnership;
  }

  stage(recovery: RecordingRecovery, replace = false): Promise<SelectedAlignment> {
    if (this.closed || this.active || this.recovering) return Promise.reject(new Error("alignment owner is closed or busy"));
    const stored = this.store.getRecordingRecovery(recovery.occurrenceId, recovery.bridgeSessionId, recovery.capability.recordingHandle);
    if (!stored || stored.generationId !== recovery.generationId || stored.capability.sourceSessionId !== recovery.capability.sourceSessionId ||
      stored.capability.sha256 !== recovery.capability.sha256 || stored.capability.keyId !== recovery.capability.keyId ||
      stored.capability.authorization !== recovery.capability.authorization) return Promise.reject(new Error("recording recovery binding changed"));
    // Hold the one-reader admission across bounded, yielding payload cleanup.
    // This is not an assertion that any unresolved reader has stopped.
    this.recovering = true;
    this.recoveryWork = this.reclaimReleased(stored.generationId);
    return this.recoveryWork.then(() => {
      this.recovering = false; this.recoveryWork = undefined;
      if (this.closed) throw new Error("alignment owner is closed");
      const result = this.store.beginRecordingAlignment(stored.generationId, this.ownerId, replace);
      if (result.kind === "selected") return result.selected;
      const active: ActiveAlignment = { attempt: result.attempt, iterator: null, cancelled: false,
        work: Promise.resolve(undefined as never) };
      this.active = active;
      // Begin is durable before the first SDK read; publish ownership before a
      // synchronous transport callback can run.
      active.work = Promise.resolve().then(() => this.read(active, stored));
      return active.work;
    }, () => {
      this.recovering = false; this.recoveryWork = undefined;
      throw new Error("alignment released payload cleanup incomplete");
    });
  }

  private async cleanup(active: ActiveAlignment): Promise<void> {
    if (!active.cleanup) active.cleanup = (async () => {
      if (!active.iterator?.return) throw new Error("alignment cleanup unavailable");
      await active.iterator.return();
    })();
    return active.cleanup;
  }

  private async reclaim(attempt: AlignmentAttempt): Promise<void> {
    // Each transaction deletes <=64 rows; no transaction crosses this yield.
    while (!this.store.reclaimRecordingAlignment(attempt, 64)) await yieldImmediate();
  }

  private async reclaimReleased(generationId: string): Promise<void> {
    for (;;) {
      const released = this.store.getReclaimableAlignment(generationId);
      if (!released) return;
      await this.reclaim(released);
    }
  }

  private async read(active: ActiveAlignment, recovery: RecordingRecovery): Promise<SelectedAlignment> {
    try {
      active.iterator = this.runtime.readRecordingAlignment({ capability: recovery.capability })[Symbol.asyncIterator]();
      if (active.cancelled) throw new Error("cancelled");
      for (;;) {
        const item = await active.iterator.next();
        if (active.cancelled || item.done) throw new Error("missing alignment terminal");
        if (item.value.type === "recording_alignment_page") {
          this.store.appendRecordingAlignment(active.attempt, item.value);
          // Only now may next() grant the SDK's next-page credit.
          continue;
        }
        const terminal = item.value;
        if (!(await active.iterator.next()).done || active.cancelled) throw new Error("duplicate alignment terminal");
        await this.cleanup(active);
        const selected = this.store.completeRecordingAlignment(active.attempt, terminal);
        this.active = undefined;
        return selected;
      }
    } catch {
      try {
        await this.cleanup(active);
        this.store.abandonRecordingAlignment(active.attempt, mintAlignmentRecoveryPermit(active.attempt), active.cancelled ? "cancelled" : "read_failed");
        await this.reclaim(active.attempt);
        this.active = undefined;
      } catch {
        try { this.store.markAlignmentCleanupFailed(active.attempt); } catch { /* Preserve the durable claim; never claim cleanup. */ }
        throw new Error("alignment cleanup failed; exclusive owner recovery required");
      }
      throw new Error(active.cancelled ? "alignment cancelled" : "alignment read failed; tentative evidence discarded");
    }
  }

  /** Caller must await before closing Runtime or SQLite. Failed cleanup retains
   * ownership and cannot be converted into automatic takeover by reopening. */
  async close(): Promise<void> {
    this.closed = true;
    await this.recoveryWork?.catch(() => {});
    const active = this.active;
    if (!active) return;
    active.cancelled = true;
    // Let a just-admitted read install its iterator before cancellation.
    await Promise.resolve();
    await this.cleanup(active);
    await active.work.catch(() => {});
    if (this.active) throw new Error("alignment cleanup failed; exclusive owner recovery required");
  }

  async recover(generationId: string): Promise<void> {
    if (this.closed || this.active || this.recovering) throw new Error("exclusive alignment owner proof required");
    const attempt = this.store.getPendingAlignment(generationId);
    if (attempt && !this.proveExclusiveOwnership) throw new Error("exclusive alignment owner proof required");
    this.recovering = true;
    const proof = this.proveExclusiveOwnership;
    this.recoveryWork = (async () => {
      if (attempt && proof) {
        await proof(attempt);
        if (this.closed) throw new Error("alignment owner is closed");
        this.store.abandonRecordingAlignment(attempt, mintAlignmentRecoveryPermit(attempt));
      }
      await this.reclaimReleased(generationId);
    })();
    try {
      await this.recoveryWork;
    } finally { this.recovering = false; this.recoveryWork = undefined; }
  }
}
