// Application Cut C: the independent, recoverable maintenance lanes owned by
// the composed application (src/application-composition.ts, Cut B).
//
// One lane per accepted one-shot owner: initial build / backfill, operator
// warning, outbox reconcile (receipts, D016 early cleanup, exact endedAt+14d
// expiry, seed cleanup, reconciliation purge), organizer notification, durable
// discovery (Cut B's own tick, reused) and unknown-end custody cleanup
// (D002/D007, custody M1/M2). Every lane admits AT MOST ONE in-flight tick and
// schedules its next tick only after that tick settled: no overlapping
// interval promises, no backlog. Lanes never wait on Feishu readiness, live
// admission or a quarantined slot; a slow backfill never serializes the others.
//
// Actual cadence and the maximum observed scheduling delay are recorded per
// lane in a static counters surface (`status()`), never inferred from logs.
//
// Shutdown fences new ticks first, cancels the backfill worker (which awaits
// its child cleanup), awaits every in-flight tick, and reports a static sorted
// code list. The caller (the composition) closes the store only afterwards, so
// no lane ever calls back into a closed store. A cleanup failure is a code,
// never "idle".
//
// Deliberately not here: any store, worker, migration, scanner or transport
// change; a job subsystem; DB/TTL/PID inference as an ownership proof.

import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";
import type { StdioGatewayCleanupTimeouts } from "@conversation/runtime";

import { createFilesystemOperatorWarningSink } from "./adapters/filesystem-operator-warning.ts";
import { deleteSeedRecordingEvidence } from "./adapters/filesystem-outbox.ts";
import { readTeamVaultProjects } from "./adapters/team-vault-projects.ts";
import { createBackfillWarningWorker, createBackfillWorker, type BackfillWorkerOptions } from "./delivery/backfill-worker.ts";
import { createNotificationWorker, type NotificationSender } from "./delivery/notification-worker.ts";
import { createOutboxWorker } from "./delivery/outbox-worker.ts";
import type { OperatorWarningSink } from "./ports/operator-warning.ts";
import type { AlignmentAttempt, SessionStore, UnknownEndCustodyCleanupClaim, UnknownEndCustodyFailureReason, UnknownEndCustodySource } from "./ports/session-store.ts";
import type { Clock } from "./sessions/coordinator.ts";

export const MAINTENANCE_LANES = ["backfill", "warning", "outbox", "notification", "discovery", "custody"] as const;
export type MaintenanceLane = (typeof MAINTENANCE_LANES)[number];

/** First-profile cadence (milliseconds between a tick's settlement and the
 * next tick's start). Exact deadlines (warning, expiry, custody) live in the
 * store; cadence only bounds how late a due item is noticed. */
export const DEFAULT_LANE_INTERVALS_MS: Readonly<Record<MaintenanceLane, number>> = {
  backfill: 15_000, warning: 60_000, outbox: 5_000, notification: 5_000, discovery: 15_000, custody: 60_000,
};
/** D010/D017 accepted budgets for the postmeeting Runtime child. */
export const BACKFILL_OPERATION_BUDGET_MS = 900_000;
export const BACKFILL_CLEANUP_TIMEOUTS: StdioGatewayCleanupTimeouts = { eofGraceMs: 5_000, termGraceMs: 1_000, killGraceMs: 1_000 };
/** Bounded organizer notification settings: the request timeout plus safety
 * margin stays far inside Feishu's one-hour UUID dedup window; the claim lease
 * covers the request. The shared Feishu transport caps each HTTP request at
 * 5 seconds; either timeout is an uncertain send in the notification worker. */
export const NOTIFICATION_SETTINGS = { requestTimeoutMs: 10_000, claimTtlMs: 60_000, dedupSafetyMarginMs: 300_000 } as const;
const MAX_LANE_INTERVAL_MS = 3_600_000;

export type MaintenanceOptions = {
  readonly intervalsMs?: Partial<Record<MaintenanceLane, number>>;
  /** Deterministic [0,1] source for the workers' bounded jitter in tests. */
  readonly random?: () => number;
  readonly monotonicNow?: () => number;
  readonly backfill?: Pick<BackfillWorkerOptions, "operationBudgetMs" | "cleanupTimeouts" | "startTransport" | "connectRuntime">;
  /** Test seams only; production composes the accepted Feishu sender and file sink. */
  readonly warningSink?: OperatorWarningSink;
};

/** The application supervisor's own facts. These are the ONLY quiescence and
 * ownership proofs the lanes accept: never a DB reopen, TTL, PID or claim age. */
export type MaintenanceSupervisor = {
  /** Throws when this process no longer holds the exclusive state-root owner lock. */
  assertOwnership(): void;
  /** A live or starting entry exists for that occurrence in this process. */
  occurrenceIsLive(occurrenceId: string): boolean;
  /** Some live/starting entry in this process still holds a finalized recording. */
  holdsFinalizedRecording(): boolean;
};

export type LaneStatus = {
  readonly lane: MaintenanceLane;
  readonly intervalMs: number;
  readonly ticks: number;
  readonly inFlight: boolean;
  readonly lastOutcome: string | null;
  readonly lastStartedAtMs: number | null;
  readonly lastDurationMs: number | null;
  readonly maxDurationMs: number | null;
  /** Start-to-start gap of the two most recent ticks: the actual cadence. */
  readonly lastCadenceMs: number | null;
  readonly maxCadenceMs: number | null;
  /** Largest observed (actual start − scheduled due) of timer-driven ticks. */
  readonly maxScheduleDelayMs: number | null;
  readonly failures: readonly string[];
};

export type CustodyOutcome = {
  readonly source: UnknownEndCustodySource;
  readonly outcome: "deleted" | "failed" | "claim_expired" | "claim_stale";
  readonly reason: UnknownEndCustodyFailureReason | null;
};

export type MaintenanceStatus = {
  readonly started: boolean;
  readonly closing: boolean;
  readonly lanes: readonly LaneStatus[];
  /** Every custody settlement this process performed or could not record. */
  readonly custody: readonly CustodyOutcome[];
  /** Static sorted codes; empty means no lane failed. */
  readonly codes: readonly string[];
};

export type MaintenanceOwner = {
  start(): void;
  /** Runs one tick now (or joins the in-flight one); resolves to the static outcome code. */
  tick(lane: MaintenanceLane): Promise<string>;
  status(): MaintenanceStatus;
  close(): Promise<void>;
};

export type CreateMaintenanceInput = {
  readonly store: SessionStore;
  readonly clock: Clock;
  readonly dataPaths: { readonly recordingsDir: string; readonly outboxDir: string; readonly receiptsDir: string; readonly teamVaultDir: string };
  readonly runtime: { readonly launcherPath: string; readonly gatewayConfigPath: string };
  /** The composition's allowlisted child environment. */
  readonly env: Readonly<Record<string, string>>;
  readonly supervisor: MaintenanceSupervisor;
  /** Cut B's durable discovery tick (metadata resolution + bounded launch scan). */
  readonly discover: () => Promise<unknown>;
  /** The accepted Feishu sender. Production composes the exact Feishu adapter
   * that owns the tenant-token credential operation; a caller that composes
   * none keeps a lane that claims nothing and reports
   * `notification_sender_unavailable`. */
  readonly notificationSender?: NotificationSender;
  readonly log?: (code: string) => void;
  readonly options?: MaintenanceOptions;
};

type Lane = {
  readonly name: MaintenanceLane;
  readonly intervalMs: number;
  readonly run: () => Promise<string>;
  inFlight: Promise<string> | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  dueAtMono: number | null;
  lastStartMono: number | null;
  ticks: number;
  lastOutcome: string | null;
  lastStartedAtMs: number | null;
  lastDurationMs: number | null;
  maxDurationMs: number | null;
  lastCadenceMs: number | null;
  maxCadenceMs: number | null;
  maxScheduleDelayMs: number | null;
  readonly failures: Set<string>;
};

function claimToken(): string {
  return randomUUID().replaceAll("-", "");
}

function staticCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[a-z_]+(:[a-z_,]+)?$/.test(message) ? message : "lane_failed";
}

/** Rechecks the stored exact identity against the filesystem before the
 * identity-only tombstone deletion runs; mirrors what the deletion adapter
 * verifies so the exact custody reason is recorded, never a generic failure. */
function recheckCustodyIdentity(recordingsDir: string, claim: UnknownEndCustodyCleanupClaim): UnknownEndCustodyFailureReason | null {
  const root = path.resolve(recordingsDir);
  const target = path.resolve(claim.recordingPath);
  if (path.dirname(target) !== root || path.basename(target) !== `${claim.recordingHandle}.crsr`) return "unsafe_source";
  let stat;
  try { stat = lstatSync(target, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unsafe_source";
    // A detached tombstone from an interrupted deletion is completed by the
    // adapter itself; only a source with neither file nor tombstone is missing.
    const tombstone = path.join(root, `.recording-delete-seed-${claim.recordingHandle}-${claim.recordingDevice}-${claim.recordingInode}`);
    try { return lstatSync(tombstone).isFile() ? null : "unsafe_source"; }
    catch { return "source_missing"; }
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return "unsafe_source";
  if (stat.dev.toString() !== claim.recordingDevice || stat.ino.toString() !== claim.recordingInode || stat.size !== BigInt(claim.recordingBytes)) return "identity_mismatch";
  return null;
}

export function createApplicationMaintenance(input: CreateMaintenanceInput): MaintenanceOwner {
  const log = input.log ?? (() => {});
  const options = input.options ?? {};
  const random = options.random ?? Math.random;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const clock = { now: () => input.clock.now(), monotonicNow };
  const intervals: Record<MaintenanceLane, number> = { ...DEFAULT_LANE_INTERVALS_MS };
  for (const name of MAINTENANCE_LANES) {
    const value = options.intervalsMs?.[name];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1 || value > MAX_LANE_INTERVAL_MS) throw new Error("maintenance_interval_invalid");
    intervals[name] = value;
  }

  // --- accepted owners ------------------------------------------------------
  const outbox = createOutboxWorker({
    recordingsDir: input.dataPaths.recordingsDir, outboxDir: input.dataPaths.outboxDir, receiptsDir: input.dataPaths.receiptsDir,
    journal: input.store, clock, random,
    session: { state: (occurrenceId) => input.store.getSession(occurrenceId)?.state ?? null,
      publish: () => { throw new Error("outbox_publish_owned_by_store"); } },
    reconciliationEvidence: input.store,
    onMaintenanceFailure: (reason) => { lanes.outbox.failures.add(`outbox_${reason}`); log(`maintenance_outbox_${reason}`); },
  });
  /** The composition's own trusted proof for a stale alignment attempt: this
   * process holds the exclusive owner lock (so the attempt's previous owner
   * process is gone), this lane is the only alignment reader in-process and it
   * is the one asking, and no live occurrence still holds a finalized
   * recording. Nothing about the attempt's age, DB state or PID is consulted. */
  const proveExclusiveOwnership: (attempt: AlignmentAttempt) => Promise<void> = async () => {
    input.supervisor.assertOwnership();
    if (input.supervisor.holdsFinalizedRecording()) throw new Error("finalized recording still owned by a live occurrence");
  };
  const backfill = createBackfillWorker({
    store: input.store, outbox, gatewayPath: input.runtime.launcherPath, configPath: input.runtime.gatewayConfigPath, env: input.env,
    operationBudgetMs: options.backfill?.operationBudgetMs ?? BACKFILL_OPERATION_BUDGET_MS,
    cleanupTimeouts: options.backfill?.cleanupTimeouts ?? BACKFILL_CLEANUP_TIMEOUTS,
    clock, random, proveExclusiveOwnership,
    readKnownProjects: () => readTeamVaultProjects({ teamVaultDir: input.dataPaths.teamVaultDir }),
    ...(options.backfill?.startTransport ? { startTransport: options.backfill.startTransport } : {}),
    ...(options.backfill?.connectRuntime ? { connectRuntime: options.backfill.connectRuntime } : {}),
  });
  const warning = createBackfillWarningWorker({
    store: input.store, clock, random,
    sink: options.warningSink ?? createFilesystemOperatorWarningSink({ outboxDir: input.dataPaths.outboxDir }),
  });
  const notification = input.notificationSender === undefined ? null
    : createNotificationWorker({ store: input.store, sender: input.notificationSender, clock, random, ...NOTIFICATION_SETTINGS });

  // --- custody lane -----------------------------------------------------------
  const custodyOutcomes: CustodyOutcome[] = [];
  const MAX_CUSTODY_OUTCOMES = 256;
  const recordCustody = (outcome: CustodyOutcome): void => { custodyOutcomes.push(outcome); if (custodyOutcomes.length > MAX_CUSTODY_OUTCOMES) custodyOutcomes.shift(); };
  function settleCustodyFailure(claim: UnknownEndCustodyCleanupClaim, reason: UnknownEndCustodyFailureReason): string {
    try {
      input.store.failUnknownEndCustodyCleanup(claim, clock.now(), reason);
      recordCustody({ source: claim.source, outcome: "failed", reason });
      log("maintenance_custody_cleanup_failed");
      return `custody_cleanup_failed:${reason}`;
    } catch (error) {
      // Custody M1: a claim that expired before settlement is a visible code,
      // never silence; the row stays claimed with an expired lease.
      const expired = error instanceof Error && /expired/.test(error.message);
      recordCustody({ source: claim.source, outcome: expired ? "claim_expired" : "claim_stale", reason });
      log(expired ? "maintenance_custody_claim_expired" : "maintenance_custody_claim_stale");
      return expired ? "custody_claim_expired" : "custody_claim_stale";
    }
  }
  async function runCustody(): Promise<string> {
    const claim = input.store.claimDueUnknownEndCustodyCleanup(clock.now(), claimToken());
    if (claim === null) return "custody_idle";
    // Quiescence gate: the application supervisor's fact only (a retained
    // alignment claim was already excluded by the store's claim).
    if (input.supervisor.occurrenceIsLive(claim.source.occurrenceId)) return settleCustodyFailure(claim, "reader_active");
    const mismatch = recheckCustodyIdentity(input.dataPaths.recordingsDir, claim);
    if (mismatch !== null) return settleCustodyFailure(claim, mismatch);
    try {
      deleteSeedRecordingEvidence({ recordingsDir: input.dataPaths.recordingsDir, recordingPath: claim.recordingPath,
        recordingHandle: claim.recordingHandle, recordingBytes: claim.recordingBytes,
        recordingDevice: claim.recordingDevice, recordingInode: claim.recordingInode });
    } catch { return settleCustodyFailure(claim, "detach_failed"); }
    try {
      input.store.completeUnknownEndCustodyCleanup(claim, clock.now());
      recordCustody({ source: claim.source, outcome: "deleted", reason: null });
      log("maintenance_custody_deleted");
      return "custody_deleted";
    } catch (error) {
      const expired = error instanceof Error && /expired/.test(error.message);
      recordCustody({ source: claim.source, outcome: expired ? "claim_expired" : "claim_stale", reason: null });
      log(expired ? "maintenance_custody_claim_expired" : "maintenance_custody_claim_stale");
      return expired ? "custody_claim_expired" : "custody_claim_stale";
    }
  }

  // --- lanes ------------------------------------------------------------------
  let started = false, closing = false;
  let closePromise: Promise<void> | null = null;
  const closeCodes = new Set<string>();

  function lane(name: MaintenanceLane, run: () => Promise<string>): Lane {
    return { name, intervalMs: intervals[name], run, inFlight: null, timer: undefined, dueAtMono: null, lastStartMono: null, ticks: 0,
      lastOutcome: null, lastStartedAtMs: null, lastDurationMs: null, maxDurationMs: null, lastCadenceMs: null, maxCadenceMs: null,
      maxScheduleDelayMs: null, failures: new Set() };
  }
  const lanes: Record<MaintenanceLane, Lane> = {
    backfill: lane("backfill", async () => {
      try {
        const result = await backfill.pollOnce();
        // A profile refusal will not clear by retrying. It stays a visible
        // lane code from the first refusal, logged once, long before the
        // original-deadline stop warning.
        if (result.kind === "rescheduled" && result.refusal !== undefined && !lanes.backfill.failures.has(`backfill_${result.refusal}`)) {
          lanes.backfill.failures.add(`backfill_${result.refusal}`);
          log(`maintenance_backfill_${result.refusal}`);
        }
        return `backfill_${result.kind}`;
      }
      catch (error) {
        // D020: unconfirmed process cleanup poisons the worker; it stays a
        // visible code on every later tick, never an idle result. The other
        // aggregate failures are persisted-state failures, named as such.
        if (error instanceof AggregateError) {
          throw new Error(/cleanup was not confirmed/.test(error.message) ? "backfill_cleanup_unconfirmed"
            : /could not be settled/.test(error.message) ? "backfill_settlement_unpersisted" : "backfill_failure_unpersisted");
        }
        throw error;
      }
    }),
    warning: lane("warning", async () => `warning_${(await warning.pollOnce()).kind}`),
    outbox: lane("outbox", async () => { outbox.reconcile(); return "outbox_reconciled"; }),
    notification: lane("notification", async () => {
      if (notification === null) throw new Error("notification_sender_unavailable");
      await notification.poll(); return "notification_polled";
    }),
    discovery: lane("discovery", async () => { await input.discover(); return "discovery_ticked"; }),
    custody: lane("custody", runCustody),
  };

  function schedule(entry: Lane): void {
    if (closing || !started || entry.timer !== undefined || entry.inFlight !== null) return;
    entry.dueAtMono = monotonicNow() + entry.intervalMs;
    entry.timer = setTimeout(() => { entry.timer = undefined; void tick(entry.name).catch(() => undefined); }, entry.intervalMs);
  }

  function tick(name: MaintenanceLane): Promise<string> {
    const entry = lanes[name];
    if (closing) return Promise.reject(new Error("maintenance_closed"));
    if (entry.inFlight !== null) return entry.inFlight;
    if (entry.timer !== undefined) { clearTimeout(entry.timer); entry.timer = undefined; }
    const startMono = monotonicNow();
    if (entry.dueAtMono !== null) {
      const delay = Math.max(0, startMono - entry.dueAtMono);
      entry.maxScheduleDelayMs = Math.max(entry.maxScheduleDelayMs ?? 0, delay);
      entry.dueAtMono = null;
    }
    if (entry.lastStartMono !== null) {
      entry.lastCadenceMs = Math.max(0, startMono - entry.lastStartMono);
      entry.maxCadenceMs = Math.max(entry.maxCadenceMs ?? 0, entry.lastCadenceMs);
    }
    entry.lastStartMono = startMono;
    entry.lastStartedAtMs = clock.now();
    entry.ticks += 1;
    entry.inFlight = (async () => {
      let outcome: string;
      try { outcome = await entry.run(); }
      catch (error) { outcome = staticCode(error); entry.failures.add(outcome); log(`maintenance_${entry.name}_failed`); }
      return outcome;
    })().then((outcome) => {
      const duration = Math.max(0, monotonicNow() - startMono);
      entry.lastDurationMs = duration;
      entry.maxDurationMs = Math.max(entry.maxDurationMs ?? 0, duration);
      entry.lastOutcome = outcome;
      entry.inFlight = null;
      schedule(entry); // Only after settlement; never while a tick is in flight.
      return outcome;
    });
    return entry.inFlight;
  }

  function laneStatus(entry: Lane): LaneStatus {
    return { lane: entry.name, intervalMs: entry.intervalMs, ticks: entry.ticks, inFlight: entry.inFlight !== null, lastOutcome: entry.lastOutcome,
      lastStartedAtMs: entry.lastStartedAtMs, lastDurationMs: entry.lastDurationMs, maxDurationMs: entry.maxDurationMs,
      lastCadenceMs: entry.lastCadenceMs, maxCadenceMs: entry.maxCadenceMs, maxScheduleDelayMs: entry.maxScheduleDelayMs,
      failures: [...entry.failures].sort() };
  }

  return {
    start(): void {
      if (closing) throw new Error("maintenance_closed");
      if (started) throw new Error("maintenance_already_started");
      started = true;
      // The first tick follows one interval (no start-time burst); every
      // later tick follows its predecessor's settlement plus the interval.
      for (const name of MAINTENANCE_LANES) schedule(lanes[name]);
      log("maintenance_started");
    },
    tick,
    status(): MaintenanceStatus {
      const codes = new Set<string>(closeCodes);
      for (const name of MAINTENANCE_LANES) for (const failure of lanes[name].failures) codes.add(`${name}:${failure}`);
      return { started, closing, lanes: MAINTENANCE_LANES.map((name) => laneStatus(lanes[name])), custody: [...custodyOutcomes], codes: [...codes].sort() };
    },
    close(): Promise<void> {
      if (closePromise !== null) return closePromise;
      closePromise = (async () => {
        closing = true;
        for (const name of MAINTENANCE_LANES) {
          const entry = lanes[name];
          if (entry.timer !== undefined) { clearTimeout(entry.timer); entry.timer = undefined; }
          entry.dueAtMono = null;
        }
        log("maintenance_fenced");
        // The backfill worker's close cancels its in-flight attempt and awaits
        // the owned Runtime child cleanup; the warning worker awaits its poll.
        const workerCloses = Promise.allSettled([
          backfill.close().catch(() => { closeCodes.add("backfill_close_failed"); }),
          warning.close().catch(() => { closeCodes.add("warning_close_failed"); }),
        ]);
        await Promise.allSettled(MAINTENANCE_LANES.map((name) => lanes[name].inFlight ?? Promise.resolve()));
        await workerCloses;
        log("maintenance_closed");
        if (closeCodes.size > 0) throw new Error(`maintenance_close_failed:${[...closeCodes].sort().join(",")}`);
      })();
      return closePromise;
    },
  };
}
