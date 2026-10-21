// Application Cut B: the live graph and lifecycle owner behind the standalone
// entry's admission seam (src/main.ts, Cut A).
//
// Order of ownership, which the tests pin:
//   1. the held owner lock is rechecked, every data path is realpath-checked
//      against the canonical state root, the private root and database
//      identity are verified (fail closed, never chmod or repair), the Feishu
//      app secret is read through a no-follow descriptor;
//   2. exactly ONE application-owned SessionStore opens inside the private
//      state root and is handed to the application, discovery and every
//      consumer; the application never closes it;
//   3. per admitted occurrence, lazily: the actual Runtime SDK is connected
//      and its v4 control identity awaited BEFORE physical custody is claimed
//      and the bridge child is spawned, so timed UI evidence binds to it; the
//      accepted `runtimeFor` surface stays synchronous because the owner is
//      already connected when the application asks for it;
//   4. shutdown fences new admission and ticks first, cancels/awaits owned
//      work, closes the application (sessions, children, physical outcomes),
//      awaits every Runtime owner's close outcome, closes owned Feishu
//      transports, closes the store; the CALLER closes the lock last.
//
// What this file deliberately does not do: reimplement the accepted SDK
// adapter, bridge child adapter, ingress, metadata resolver or discovery
// worker; read provider or recording keys; own the maintenance lanes' logic
// (src/application-maintenance.ts, Cut C, is constructed here and started/
// closed in the accepted order).

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FINALIZED_RECORDING_PROTOCOL_VERSION, RuntimeClient, StdioGatewayTransport, type RuntimeStatus, type RuntimeTransport, type StdioGatewayCleanupOutcome, type DrainableTimedVoiceSession, type TimedVoiceSession } from "@conversation/runtime";

import type { ApplicationOwnerLock } from "./adapters/application-owner-lock.ts";
import { createChildBridgeSlot } from "./adapters/child-bridge-process.ts";
import { createConversationRuntimeClient } from "./adapters/conversation-runtime-client.ts";
import { createFeishuInviteIngress } from "./adapters/feishu-invite-ingress.ts";
import { createFeishuOrganizerMetadata } from "./adapters/feishu-organizer-metadata.ts";
import { createFeishuOrganizerSender } from "./adapters/feishu-organizer-sender.ts";
import { createFeishuSocketOwner, type FeishuSocketOwner } from "./adapters/feishu-sdk-connection.ts";
import { createFeishuSdkHttp, type FeishuSdkHttp } from "./adapters/feishu-sdk-http.ts";
import { openSessionStore } from "./adapters/sqlite-session-store.ts";
import { createApplicationMaintenance, type MaintenanceLane, type MaintenanceOptions, type MaintenanceStatus } from "./application-maintenance.ts";
import { createMeetingAgentApplication, type MeetingAgentApplication } from "./application.ts";
import { RedactedSecret, type MeetingAgentConfig } from "./config.ts";
import type { NotificationSender } from "./delivery/notification-worker.ts";
import { buildMeetingIdentity, type MeetingIdentity } from "./domain/meeting.ts";
import type { BridgeProcessSlot, OwnedBridgeProcess } from "./ports/bridge-process.ts";
import type { ConversationRuntimePort, FinalizedRecordingRuntime } from "./ports/conversation-runtime.ts";
import type { InviteOccurrence, NormalizedInvite } from "./ports/feishu-ingress.ts";
import type { FeishuOrganizerLookup, OrganizerReferenceEntry } from "./ports/feishu.ts";
import type { BackfillSeedConfig, PublishStoredGenerationsInput, SessionStore, UnknownEndCustodySource } from "./ports/session-store.ts";
import type { RecordingSummary } from "./ports/conversation-runtime.ts";
import type { Clock } from "./sessions/coordinator.ts";
import { createInviteDiscovery } from "./sessions/invite-discovery.ts";
import type { CreateMeetingSessionOptions, MeetingSession } from "./sessions/meeting-session.ts";
import { recognitionOutageWarnings, type RecognitionOutage } from "./domain/transcript.ts";
import { markJoinTiming, type JoinTimingObserver } from "./sessions/join-timing.ts";
import type { StandaloneConfigV1 } from "./standalone-config.ts";

export const STATE_DATABASE_NAME = "orchestration.db";
/** The only environment the private Runtime launcher and bridge children see. */
export const RUNTIME_CHILD_ENVIRONMENT_ALLOWLIST: readonly string[] = ["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"];
/** D009: launch-and-ready budget and the first profile's cleanup phases. */
const RUNTIME_STARTUP_BUDGET_MS = 15_000;
const RUNTIME_CLEANUP_TIMEOUTS = { eofGraceMs: 5_000, termGraceMs: 1_000, killGraceMs: 1_000 } as const;
const BRIDGE_LEASE_TTL_MS = 30_000;
const MAX_APP_SECRET_BYTES = 4_096;
const DISCOVERY_PAGE = 64;
const MAX_METADATA_RESOLUTIONS_PER_TICK = 256;

/** Wait before relaunching a failed bridge generation: 1 s doubling per
 * attempt, capped at 10 s. The number of attempts is bounded by the store's
 * bridge failure retry limit. */
/** Relaunches of any cause per occurrence; the store's bridge failure retry
 * limit bounds the failures that ended a running generation. */
const MAX_BRIDGE_RELAUNCHES = 4;

export function defaultBridgeRecoveryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 10_000);
}
/** The accepted SDK v4 status exposes no STT/live/batch model or cipher name;
 * the seed records that explicitly instead of inventing a value. */
const UNAVAILABLE_CURRENT_SDK = "unavailable_current_sdk";
/** D032 §2. The cipher of the Runtime's finalized recording container is a
 * pinned engine fact of the protocol version this client speaks, not an
 * unavailable one: v4's container header is AES-256-GCM. A protocol bump
 * fails the test that ties these two together rather than publishing a
 * silently stale claim. */
export const RECORDING_CONTAINER_ENCRYPTION = FINALIZED_RECORDING_PROTOCOL_VERSION === 4 ? "aes-256-gcm" : UNAVAILABLE_CURRENT_SDK;

export function stateDatabasePath(config: Pick<StandaloneConfigV1, "stateRoot">): string {
  return path.join(config.stateRoot, STATE_DATABASE_NAME);
}

export type OwnedRuntimeTransport = RuntimeTransport & { readonly cleanupOutcome?: StdioGatewayCleanupOutcome | undefined };

export type ComposeApplicationOptions = {
  readonly clock?: Clock;
  /** External shutdown request (the entry's signal handling); close() is still required. */
  readonly shutdownSignal?: AbortSignal;
  /** Injected physical slots; default builds child slots from the config. */
  readonly bridgeSlots?: readonly BridgeProcessSlot[];
  /** Injected Runtime transport; default starts the private launcher over stdio. */
  readonly startRuntimeTransport?: (input: { readonly occurrenceId: string; readonly signal: AbortSignal }) => Promise<OwnedRuntimeTransport>;
  readonly runtimeStartupBudgetMs?: number;
  /** Test seam: compose without the official invite ingress. Production always composes it. */
  readonly inviteIngress?: false;
  readonly feishu?: {
    readonly http?: FeishuSdkHttp; readonly connection?: FeishuSocketOwner;
    readonly readyTimeoutMs?: number; readonly handshakeTimeoutMs?: number; readonly closeTimeoutMs?: number;
  };
  readonly metadata?: FeishuOrganizerLookup;
  readonly organizerReferences?: readonly OrganizerReferenceEntry[];
  readonly discoveryJitter?: () => number;
  /** Cut C lane seams (cadence, jitter, backfill peer, sink); the sender seam
   * replaces the accepted Feishu sender only in tests. */
  readonly maintenance?: MaintenanceOptions & { readonly notificationSender?: NotificationSender };
  /** Static lifecycle codes only; never paths, identities or secrets. */
  readonly log?: (code: string) => void;
  /** Backoff before relaunching a failed bridge generation (attempt is 1-based). */
  readonly bridgeRecoveryDelayMs?: (attempt: number) => number;
  /** PRIVATE test-entry join-latency observer (sessions/join-timing.ts); production never sets it. */
  readonly joinTiming?: JoinTimingObserver;
};

export type OccurrenceFailure =
  | "runtime_startup_aborted" | "runtime_startup_timeout" | "runtime_startup_failed"
  | "application_closed" | "physical_client_quarantined" | "launch_failed"
  | "join_failed" | "media_format_rejected" | "join_cancelled";

export type OccurrenceOutcome = {
  readonly occurrenceId: string;
  readonly bridgeId: string;
  readonly organizer: MeetingIdentity["organizer"];
  readonly phase: "starting" | "live" | "settled";
  readonly controlSessionId: bigint | null;
  readonly failure: OccurrenceFailure | null;
  readonly finalization: "none" | "seeded" | "recorded" | "stop_failed" | "finalize_failed" | "transaction_failed";
  readonly custody: "not_applicable" | "assigned" | "existing" | "refused" | "unpersisted";
  readonly runtimeClose: "pending" | "closed" | "failed";
  readonly runtimeCleanup: StdioGatewayCleanupOutcome["status"] | null;
  /** Bridge generations started for this occurrence (recoveries + 1). */
  readonly generations: number;
};

export type DiscoveryTick = { readonly resolved: number; readonly launched: number; readonly deferred: number };

export type ComposedApplication = {
  readonly stateDatabasePath: string;
  start(): Promise<void>;
  /** One durable discovery tick (metadata resolution, then bounded launch scan); one in flight. */
  discover(): Promise<DiscoveryTick>;
  retryInviteMetadata(occurrenceId: string, operator: string): "pending" | "already_pending" | "counter_exhausted";
  liveOccurrenceIds(): readonly string[];
  occurrenceOutcomes(): readonly OccurrenceOutcome[];
  awaitOccurrence(occurrenceId: string): Promise<OccurrenceOutcome>;
  /** Cut C: static per-lane counters (cadence, delay, outcomes, custody settlements). */
  /** `inviteAdmission` is not `allowlist` while every invite is refused: no inviters configured, or only chat IDs,
   * which the invite event is not known to carry. */
  maintenanceStatus(): MaintenanceStatus & { readonly inviteAdmission: "allowlist" | "no_inviters_configured" | "chat_ids_only_unverified" };
  /** Cut C: run (or join) one lane tick now; resolves to its static outcome code. */
  maintenanceTick(lane: MaintenanceLane): Promise<string>;
  close(): Promise<void>;
};

export type StandaloneCompositionResult =
  | { readonly status: "composition_unavailable"; readonly reason: string }
  | { readonly status: "composition_closed"; readonly clean: boolean };

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  constructor() { this.promise = new Promise<T>((resolve) => { this.resolve = resolve; }); }
}

class OccurrenceStartupFailure extends Error {
  readonly code: OccurrenceFailure;
  constructor(code: OccurrenceFailure) { super(code); this.name = "OccurrenceStartupFailure"; this.code = code; }
}

// ---------------------------------------------------------------------------
// Admission checks (read-only; nothing is created, repaired or removed)
// ---------------------------------------------------------------------------

function currentUid(): bigint {
  if (process.getuid === undefined) throw new Error("private_state_unsafe");
  return BigInt(process.getuid());
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

type DataPathField = keyof StandaloneConfigV1["dataPaths"];
const DATA_PATH_FIELDS: readonly DataPathField[] = ["recordingsDir", "outboxDir", "receiptsDir", "teamVaultDir"];

/** Cut A M1: every data path is canonicalized and rechecked against the
 * canonical state root before the store opens; a symlink alias into the
 * private root, a missing directory or an overlap refuses composition. */
function canonicalDataPaths(config: StandaloneConfigV1): MeetingAgentConfig["dataPaths"] {
  const canonical = {} as Record<DataPathField, string>;
  for (const field of DATA_PATH_FIELDS) {
    let real: string;
    try {
      real = realpathSync.native(config.dataPaths[field]);
      if (!lstatSync(real).isDirectory()) throw new Error("not_directory");
    } catch { throw new Error(`data_path_unsafe:${field}`); }
    if (real === config.stateRoot || isWithin(real, config.stateRoot) || isWithin(config.stateRoot, real)) throw new Error(`data_path_unsafe:${field}`);
    canonical[field] = real;
  }
  for (const a of DATA_PATH_FIELDS) for (const b of DATA_PATH_FIELDS) {
    if (a !== b && (canonical[a] === canonical[b] || isWithin(canonical[a], canonical[b]))) throw new Error(`data_path_unsafe:${a}`);
  }
  return canonical;
}

function verifyPrivateRoot(stateRoot: string): void {
  try {
    const root = lstatSync(stateRoot, { bigint: true });
    if (root.isSymbolicLink() || !root.isDirectory() || root.uid !== currentUid() || (root.mode & 0o077n) !== 0n) throw new Error("private_state_unsafe");
  } catch { throw new Error("private_state_unsafe"); }
}

function verifyDatabaseIdentity(filename: string, mustExist: boolean): void {
  let stat;
  try { stat = lstatSync(filename, { bigint: true }); }
  catch (error) {
    if (!mustExist && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("private_state_unsafe");
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n || stat.uid !== currentUid()) throw new Error("private_state_unsafe");
}

/** The app secret reference becomes bytes only here, after admission, through a
 * no-follow descriptor that must be a current-UID regular file nobody else can read. */
function readAppSecret(filename: string): RedactedSecret {
  let fd: number;
  try { fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new Error("app_secret_unreadable"); }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.uid !== currentUid() || (stat.mode & 0o077n) !== 0n || stat.size > BigInt(MAX_APP_SECRET_BYTES)) throw new Error("app_secret_unreadable");
    const bytes = Buffer.alloc(MAX_APP_SECRET_BYTES + 1);
    let offset = 0;
    for (let calls = 0; calls < 64; calls += 1) {
      let count: number;
      try { count = readSync(fd, bytes, offset, bytes.length - offset, null); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EINTR") continue; throw new Error("app_secret_unreadable"); }
      offset += count;
      if (offset > MAX_APP_SECRET_BYTES) throw new Error("app_secret_unreadable");
      if (count === 0) break;
    }
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset)).trim();
    if (value.length === 0) throw new Error("app_secret_unreadable");
    return new RedactedSecret(value);
  } catch { throw new Error("app_secret_unreadable"); }
  finally { closeSync(fd); }
}

/** Compose-time refusal of a v2 slot whose operator static file cannot carry
 * the accepted feishu-bridge-config/v3 `audio` object, so a misprovisioned
 * slot is refused before any store opens or child spawns. The child adapter's
 * own launch-time validation (D026) remains authoritative; this mirrors only
 * the exact shape it requires. Read-only, bounded, no-follow. */
function preflightBridgeStaticConfig(filename: string): void {
  let fd: number;
  try { fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new Error("bridge_slot_invalid"); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65_536) throw new Error("bridge_slot_invalid");
    const bytes = Buffer.alloc(65_537);
    let offset = 0;
    for (let calls = 0; calls < 1024; calls += 1) {
      let count: number;
      try { count = readSync(fd, bytes, offset, bytes.length - offset, null); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EINTR") continue; throw new Error("bridge_slot_invalid"); }
      offset += count;
      if (offset > 65_536) throw new Error("bridge_slot_invalid");
      if (count === 0) break;
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset)));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("bridge_slot_invalid");
    const record = value as Record<string, unknown>;
    const audio = record.audio;
    if (record.schema !== "feishu-bridge-config/v1" || Object.hasOwn(record, "custody") ||
        typeof audio !== "object" || audio === null || Array.isArray(audio)) throw new Error("bridge_slot_invalid");
    const fields = audio as Record<string, unknown>;
    const display = fields.captureDisplayId, uid = fields.outputDeviceUid;
    if (Object.keys(fields).length !== 2 || !Number.isInteger(display) || (display as number) < 1 || (display as number) > 4_294_967_295 ||
        typeof uid !== "string" || uid.length === 0 || Buffer.byteLength(uid) > 512 || uid.includes("\0")) throw new Error("bridge_slot_invalid");
  } catch { throw new Error("bridge_slot_invalid"); }
  finally { closeSync(fd); }
}

function allowlistedEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  const allowed = { HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME, PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LC_CTYPE: process.env.LC_CTYPE };
  for (const [name, value] of Object.entries(allowed)) if (value !== undefined) env[name] = value;
  return env;
}

function agentVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name?: unknown; version?: unknown };
    if (typeof manifest.name === "string" && typeof manifest.version === "string") return `${manifest.name}/${manifest.version}`;
  } catch { /* fall through */ }
  return UNAVAILABLE_CURRENT_SDK;
}

/** Seed inputs stated by the connected Runtime itself; fields v4 status does
 * not expose are recorded as unavailable rather than invented. */
function seedConfigFor(status: RuntimeStatus, version: string): BackfillSeedConfig {
  const label = (kind: RuntimeStatus["components"][number]["kind"]) => status.components.find((component) => component.kind === kind)?.providerLabel ?? UNAVAILABLE_CURRENT_SDK;
  return {
    provider: "feishu", encryption: RECORDING_CONTAINER_ENCRYPTION, processingWarnings: [],
    provenance: { runtimeProfile: status.profile, sttProvider: label("speech_recognition"), sttModel: UNAVAILABLE_CURRENT_SDK,
      liveStreamModel: UNAVAILABLE_CURRENT_SDK, finalBatchModel: UNAVAILABLE_CURRENT_SDK, textProvider: label("language_model"),
      textModel: status.modelId, agentVersion: version },
  };
}

/** A restarted process has no Runtime owner for an interrupted meeting: the
 * live profile is the pinned one, and every value only a status could supply
 * is stated as unavailable rather than invented. */
function interruptedSeedConfig(version: string): BackfillSeedConfig {
  return {
    provider: "feishu", encryption: RECORDING_CONTAINER_ENCRYPTION, processingWarnings: [],
    provenance: { runtimeProfile: "online", sttProvider: UNAVAILABLE_CURRENT_SDK, sttModel: UNAVAILABLE_CURRENT_SDK,
      liveStreamModel: UNAVAILABLE_CURRENT_SDK, finalBatchModel: UNAVAILABLE_CURRENT_SDK, textProvider: UNAVAILABLE_CURRENT_SDK,
      textModel: UNAVAILABLE_CURRENT_SDK, agentVersion: version },
  };
}

// ---------------------------------------------------------------------------
// Runtime owner: actual SDK client, connected before the bridge exists
// ---------------------------------------------------------------------------

type RuntimeOwner = {
  readonly port: ConversationRuntimePort & FinalizedRecordingRuntime;
  readonly controlSessionId: bigint;
  readonly seedConfig: BackfillSeedConfig;
  readonly closeRequested: Promise<void>;
  close(): Promise<void>;
  closeOutcome(): "pending" | "closed" | "failed";
  cleanupOutcome(): StdioGatewayCleanupOutcome["status"] | null;
  finalization(): OccurrenceOutcome["finalization"];
};

async function startRuntimeOwner(input: {
  readonly occurrenceId: string; readonly shutdown: AbortSignal; readonly budgetMs: number; readonly version: string;
  readonly startTransport: NonNullable<ComposeApplicationOptions["startRuntimeTransport"]>;
}): Promise<RuntimeOwner> {
  const startup = new AbortController();
  const deadline = performance.now() + input.budgetMs;
  let timedOut = false, gaveUp = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => startup.abort();
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { timedOut = true; startup.abort(); reject(new OccurrenceStartupFailure("runtime_startup_timeout")); }, Math.max(0, deadline - performance.now()));
    startup.signal.addEventListener("abort", () => reject(new OccurrenceStartupFailure(timedOut ? "runtime_startup_timeout" : "runtime_startup_aborted")), { once: true });
  });
  void guard.catch(() => undefined);
  if (input.shutdown.aborted) startup.abort(); else input.shutdown.addEventListener("abort", onAbort, { once: true });
  const step = <T>(work: Promise<T>): Promise<T> => { void work.catch(() => undefined); return Promise.race([work, guard]); };
  let transport: OwnedRuntimeTransport | undefined;
  const transportStart = input.startTransport({ occurrenceId: input.occurrenceId, signal: startup.signal });
  void transportStart.then((late) => { if (gaveUp) void late.close().catch(() => undefined); }, () => undefined);
  try {
    transport = await step(transportStart);
    if (startup.signal.aborted) throw new OccurrenceStartupFailure(timedOut ? "runtime_startup_timeout" : "runtime_startup_aborted");
    const client = await step(RuntimeClient.connect(transport, 4));
    const controlSessionId = client.currentSessionId;
    if (typeof controlSessionId !== "bigint" || controlSessionId <= 0n) throw new OccurrenceStartupFailure("runtime_startup_failed");
    const status = await step(client.status());
    return createRuntimeOwner(client, transport, controlSessionId, seedConfigFor(status, input.version));
  } catch (error) {
    gaveUp = true;
    if (transport !== undefined) await transport.close().catch(() => undefined);
    if (error instanceof OccurrenceStartupFailure) throw error;
    throw new OccurrenceStartupFailure(startup.signal.aborted ? (timedOut ? "runtime_startup_timeout" : "runtime_startup_aborted") : "runtime_startup_failed");
  } finally {
    clearTimeout(timer);
    input.shutdown.removeEventListener("abort", onAbort);
  }
}

function createRuntimeOwner(client: RuntimeClient<4>, transport: OwnedRuntimeTransport, controlSessionId: bigint, seedConfig: BackfillSeedConfig): RuntimeOwner {
  // Whichever timed session the SDK handed back. Only stopIfActive is used
  // here, which both shapes declare identically.
  let voice: TimedVoiceSession | DrainableTimedVoiceSession | null = null;
  let finalization: OccurrenceOutcome["finalization"] = "none";
  let closeOutcome: "pending" | "closed" | "failed" = "pending";
  let closePromise: Promise<void> | undefined;
  const closeRequested = new Deferred<void>();
  const inner = createConversationRuntimeClient(client, { onTimedSession: (session) => { voice = session; } });
  const port: ConversationRuntimePort & FinalizedRecordingRuntime = {
    get currentSessionId(): bigint { return controlSessionId; },
    startVoiceSession: (value) => inner.startVoiceSession(value),
    seedConversationContext: (exchanges, operationId) => inner.seedConversationContext(exchanges, operationId),
    authorizeVoiceResponse: (value) => inner.authorizeVoiceResponse(value),
    skipVoiceResponse: (value) => inner.skipVoiceResponse(value),
    processText: (value) => inner.processText(value),
    readRecordingAlignment: (value) => inner.readRecordingAlignment(value),
    reconcileRecording: (value) => inner.reconcileRecording(value),
    reconcileFinalizedRecording: (value) => inner.reconcileFinalizedRecording(value),
    subscribe: (listener) => inner.subscribe(listener),
    /** D025: the SDK's authoritative stopIfActive is awaited before finalize.
     * Only a correlated rejection on that exact handle after its own routed
     * terminal is already_terminal; both that and a normal stop acceptance let
     * finalize proceed. Every other rejection (transport, close, protocol,
     * uncorrelated) is stop_failed: no finalize, no retry, failure visible.
     * Stop is asked at most once; nothing here re-derives session state. */
    async finalizeRecording(value) {
      const session = voice;
      if (session !== null) {
        voice = null;
        try { await session.stopIfActive(); }
        catch (error) { finalization = "stop_failed"; throw error; }
      }
      try { const result = await inner.finalizeRecording(value); finalization = "recorded"; return result; }
      catch (error) { finalization = "finalize_failed"; throw error; }
    },
    close() {
      closeRequested.resolve();
      if (closePromise === undefined) {
        closePromise = inner.close().then(() => { closeOutcome = "closed"; }, (error: unknown) => { closeOutcome = "failed"; throw error; });
      }
      return closePromise;
    },
  };
  return {
    port, controlSessionId, seedConfig, closeRequested: closeRequested.promise,
    close: () => port.close(),
    closeOutcome: () => closeOutcome,
    cleanupOutcome: () => transport.cleanupOutcome?.status ?? null,
    finalization: () => finalization,
  };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

type OccurrenceEntry = {
  readonly occurrenceId: string;
  readonly identity: MeetingIdentity;
  readonly bridgeId: string;
  runtime: RuntimeOwner | null;
  session: MeetingSession | null;
  childLaunched: boolean;
  childCleanup: Deferred<void>;
  noise: (() => { readonly invalidLines: number; readonly stderrBytes: number }) | null;
  generations: number;
  /** Failed generations' recordings awaiting custody until the occurrence
   * settles, so the one a publication ships is never given a deletion deadline. */
  failedRecordings: { readonly attempt: number; readonly recording: RecordingSummary }[];
  seedConfig: BackfillSeedConfig | null;
  phase: OccurrenceOutcome["phase"];
  failure: OccurrenceFailure | null;
  finalization: OccurrenceOutcome["finalization"];
  custody: OccurrenceOutcome["custody"];
  settled?: Promise<OccurrenceOutcome>;
};

function identityOf(occurrence: InviteOccurrence): MeetingIdentity {
  return buildMeetingIdentity({
    providerMeetingId: occurrence.providerMeetingId, meetingNo: occurrence.meetingNo, occurrenceStartedAt: occurrence.occurrenceStartedAt,
    title: occurrence.title,
    organizer: occurrence.organizer === null ? null
      : { feishuUserId: occurrence.organizer.id, displayName: occurrence.organizer.displayName, source: occurrence.organizer.source },
  });
}

function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

export async function composeApplication(config: StandaloneConfigV1, owner: ApplicationOwnerLock, options: ComposeApplicationOptions = {}): Promise<ComposedApplication> {
  const log = options.log ?? (() => {});
  const clock = options.clock ?? { now: () => Date.now() };
  const shutdown = new AbortController();
  const onExternalShutdown = () => shutdown.abort();
  if (options.shutdownSignal?.aborted) shutdown.abort();
  else options.shutdownSignal?.addEventListener("abort", onExternalShutdown, { once: true });

  // 1. Admission: lock, canonical data paths, private root, secret. No side effect.
  owner.assertCurrentOwnership();
  log("composition_lock_verified");
  const dataPaths = canonicalDataPaths(config);
  verifyPrivateRoot(config.stateRoot);
  const databasePath = stateDatabasePath(config);
  verifyDatabaseIdentity(databasePath, false);
  const appSecret = readAppSecret(config.feishu.appSecretFile);
  const scope = { region: config.feishu.region, tenantKey: config.feishu.tenantKey, appId: config.feishu.appId } as const;
  let slots: readonly BridgeProcessSlot[];
  try {
    if (options.bridgeSlots === undefined) for (const slot of config.bridgeSlots) preflightBridgeStaticConfig(slot.staticConfigPath);
    // The composition always selects timed evidence, so every configured
    // child speaks bridge-session/v2 (D026) and launches on feishu-bridge-config/v3.
    slots = options.bridgeSlots ?? config.bridgeSlots.map((slot) => createChildBridgeSlot({ ...slot, protocol: "bridge-session/v2" }));
  } catch { throw new Error("bridge_slot_invalid"); }
  if (shutdown.signal.aborted) throw new Error("composition_aborted");

  // 2. Exactly one owned store, inside the private root, after the lock.
  owner.assertCurrentOwnership();
  const store: SessionStore = openSessionStore({ filename: databasePath, nowMs: clock.now() });
  let storeOpen = true;
  try { verifyDatabaseIdentity(databasePath, true); }
  catch (error) { store.close(); storeOpen = false; throw error; }
  log("composition_store_opened");

  const version = agentVersion();
  const entries = new Map<string, OccurrenceEntry>();
  const occupied = new Map<string, string>();
  const failures = new Set<string>();
  let started = false, closing = false;
  let discoveryInFlight: Promise<DiscoveryTick> | null = null;
  let closePromise: Promise<void> | null = null;

  // Wrapped slots track child cleanup per occurrence; launch order and custody stay the adapter's.
  const wrappedSlots: BridgeProcessSlot[] = slots.map((slot) => ({
    physicalClientId: slot.physicalClientId, bridgeId: slot.bridgeId,
    async launch(binding) {
      const entry = entries.get(binding.occurrenceId);
      const owned: OwnedBridgeProcess = await slot.launch(binding);
      if (entry === undefined) return owned;
      entry.childLaunched = true;
      const cleanup = entry.childCleanup;
      entry.noise = owned.controlNoise ?? null;
      return { bridge: owned.bridge, shutdown: () => owned.shutdown().finally(() => cleanup.resolve()) };
    },
  }));

  const legacyConfig: MeetingAgentConfig = {
    feishu: { appId: config.feishu.appId, appSecret },
    conversationRuntime: { endpoint: pathToFileURL(config.runtime.launcherPath).href, profile: "online" },
    agentIdentity: { aliases: [...config.agentIdentity.aliases] },
    dataPaths,
  };
  const requireEntry = (identity: MeetingIdentity): OccurrenceEntry => {
    const entry = entries.get(identity.occurrenceId);
    if (entry === undefined || entry.runtime === null) throw new Error("runtime_owner_unavailable");
    return entry;
  };
  let application: MeetingAgentApplication;
  try {
    application = createMeetingAgentApplication({
      config: legacyConfig, store, clock, liveEvidence: "timed", bridgeLeaseTtlMs: BRIDGE_LEASE_TTL_MS, maxConcurrentSessions: wrappedSlots.length,
      backfillSeedConfigFor: (identity) => requireEntry(identity).runtime!.seedConfig, deferBridgeFailureExhaustion: true,
      adapters: { bridgeSlots: wrappedSlots, bridgeIdFor: (identity) => requireEntry(identity).bridgeId, runtimeFor: (identity) => requireEntry(identity).runtime!.port },
      ...(options.joinTiming === undefined ? {} : { joinTiming: options.joinTiming }),
    });
  } catch (error) { store.close(); storeOpen = false; throw error instanceof Error && /duplicate slot/.test(error.message) ? new Error("bridge_slot_invalid") : error; }

  const startTransport = options.startRuntimeTransport ?? (({ signal }) => StdioGatewayTransport.start({
    gatewayPath: config.runtime.launcherPath, configPath: config.runtime.gatewayConfigPath, protocolVersion: 4,
    env: allowlistedEnvironment(), startupAbortSignal: signal, cleanupTimeouts: RUNTIME_CLEANUP_TIMEOUTS,
  }));
  const budgetMs = options.runtimeStartupBudgetMs ?? RUNTIME_STARTUP_BUDGET_MS;

  // Feishu: one owned HTTP transport shared by the ingress and the metadata resolver.
  const ownsHttp = options.feishu?.http === undefined;
  let http: FeishuSdkHttp;
  let metadata: FeishuOrganizerLookup;
  try {
    http = options.feishu?.http ?? createFeishuSdkHttp({ connection: createFeishuSocketOwner() });
    metadata = options.metadata ?? createFeishuOrganizerMetadata({ ...scope, appSecret, http, references: options.organizerReferences ?? [], log });
  } catch { store.close(); storeOpen = false; throw new Error("feishu_scope_invalid"); }
  const discovery = createInviteDiscovery({ store, metadata, now: () => clock.now(), ...(options.discoveryJitter ? { jitter: options.discoveryJitter } : {}) });

  // Invite allowlist (ruling: only invites from configured people or chats are joined). Unset or empty refuses
  // every invite, recorded as inviter_not_allowed.
  const allowedInviters = new Set(config.admission?.allowedInviterIds ?? []);
  const allowedChats = new Set(config.admission?.allowedChatIds ?? []);
  const inviteAdmission = allowedInviters.size > 0 ? "allowlist" as const
    : allowedChats.size > 0 ? "chat_ids_only_unverified" as const : "no_inviters_configured" as const;
  const accept = (invite: NormalizedInvite): void => {
    if (closing) throw new Error("composition_closing");
    const result = store.acceptInvite(invite, clock.now()); // Durable before the SDK ACK.
    log("invite_committed");
    // The inviter is known only here, so the join decision is made right after the commit. A failure is left to
    // the next tick, which fails closed because the inviter is no longer known.
    const allowed = (invite.inviterId !== undefined && allowedInviters.has(invite.inviterId)) || (invite.chatId !== undefined && allowedChats.has(invite.chatId));
    try { admitOne(invite.occurrenceId, allowed ? undefined : "inviter_not_allowed"); }
    catch { log("invite_admission_failed"); }
    if (result !== "replay" && started) void discoverTick().catch(() => undefined);
  };
  let ingress: ReturnType<typeof createFeishuInviteIngress> | null = null;
  if (options.inviteIngress !== false) {
    try {
      ingress = createFeishuInviteIngress({ ...scope, appSecret, http, accept, log, connection: options.feishu?.connection ?? createFeishuSocketOwner(),
        ...(options.feishu?.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.feishu.readyTimeoutMs }),
        ...(options.feishu?.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: options.feishu.handshakeTimeoutMs }),
        ...(options.feishu?.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.feishu.closeTimeoutMs }) });
    } catch { store.close(); storeOpen = false; throw new Error("feishu_scope_invalid"); }
  }

  // The organizer DM sender is always composed: the exact Feishu adapter owns
  // the tenant-token credential operation and the endpoint binding, over the
  // same owned transport as the ingress and the metadata resolver.
  // `maintenance.notificationSender` remains the scripted test/E2E override.
  let maintenance: ReturnType<typeof createApplicationMaintenance>;
  try {
    const notificationSender = options.maintenance?.notificationSender
      ?? createFeishuOrganizerSender({ ...scope, appSecret, http, log });
    maintenance = createApplicationMaintenance({
      store, clock, dataPaths: { recordingsDir: dataPaths.recordingsDir, outboxDir: dataPaths.outboxDir, receiptsDir: dataPaths.receiptsDir, teamVaultDir: dataPaths.teamVaultDir },
      runtime: { launcherPath: config.runtime.launcherPath, gatewayConfigPath: config.runtime.gatewayConfigPath },
      env: allowlistedEnvironment(), log, notificationSender,
      discover: () => discoverTick(),
      supervisor: {
        assertOwnership: () => owner.assertCurrentOwnership(),
        occurrenceIsLive: (occurrenceId) => { const entry = entries.get(occurrenceId); return entry !== undefined && entry.phase !== "settled"; },
        holdsFinalizedRecording: () => [...entries.values()].some((entry) => entry.phase !== "settled" && entry.session !== null && entry.session.state().recording !== null),
        anyOccurrenceLive: () => [...entries.values()].some((entry) => entry.phase !== "settled"),
        publishInterrupted: (occurrenceId, nowMs) => {
          const occurrence = store.getInviteOccurrence(occurrenceId);
          if (occurrence === null) return false;
          return store.publishStoredGenerations({ occurrenceId, nowMs, reason: "capture_interrupted",
            seed: { ...interruptedSeedConfig(version), identity: identityOf(occurrence) } }) !== null;
        },
      },
      ...(options.maintenance ? { options: options.maintenance } : {}),
    }); } catch (error) {
    if (ownsHttp) void http.close().catch(() => undefined);
    store.close(); storeOpen = false; throw error;
  }

  function freeSlot(): BridgeProcessSlot | null {
    const latest = new Map<string, { claimedAtMs: number; state: "quarantined" | "cleared" }>();
    for (const row of store.listPhysicalCustody()) {
      const current = latest.get(row.physicalClientId);
      if (current === undefined || row.claimedAtMs >= current.claimedAtMs) latest.set(row.physicalClientId, { claimedAtMs: row.claimedAtMs, state: row.state });
    }
    for (const slot of wrappedSlots) {
      if (occupied.has(slot.bridgeId)) continue;
      const custody = latest.get(slot.physicalClientId);
      if (custody !== undefined && custody.state !== "cleared") continue; // Never assert an unresolved client idle.
      return slot;
    }
    return null;
  }

  function outcomeOf(entry: OccurrenceEntry): OccurrenceOutcome {
    return { occurrenceId: entry.occurrenceId, bridgeId: entry.bridgeId, organizer: entry.identity.organizer, phase: entry.phase,
      controlSessionId: entry.runtime?.controlSessionId ?? null, failure: entry.failure, finalization: entry.finalization, custody: entry.custody,
      runtimeClose: entry.runtime?.closeOutcome() ?? "pending", runtimeCleanup: entry.runtime?.cleanupOutcome() ?? null, generations: entry.generations };
  }

  /** Explicit unknown-end classification of a stopped recording (D002/D007);
   * a seeded known end is never classified, and refusal stays visible. */
  function settleRecording(entry: OccurrenceEntry): void {
    const session = entry.session;
    if (session === null) return;
    const state = session.state();
    if (store.getBackfillSeed(entry.occurrenceId) !== null) { entry.finalization = "seeded"; return; }
    if (state.recording === null) { entry.finalization = entry.runtime?.finalization() ?? "none"; return; }
    const recording = state.recording;
    let source: UnknownEndCustodySource | null = null;
    if (store.getRecording(entry.occurrenceId)?.handle === recording.recordingHandle) source = { kind: "final", occurrenceId: entry.occurrenceId };
    else {
      for (let attempt = 1; attempt <= 64; attempt += 1) {
        const failed = store.getBridgeFailureRecording(entry.occurrenceId, attempt);
        if (failed === null) break;
        if (failed.handle === recording.recordingHandle) { source = { kind: "bridge_failure", occurrenceId: entry.occurrenceId, attempt }; break; }
      }
    }
    if (source === null) { entry.finalization = "transaction_failed"; entry.custody = "unpersisted"; log("occurrence_recording_unpersisted"); return; }
    entry.finalization = "recorded";
    if (source.kind === "bridge_failure") { entry.failedRecordings.push({ attempt: source.attempt, recording }); return; }
    assignCustody(entry, source, recording);
  }

  function assignCustody(entry: OccurrenceEntry, source: UnknownEndCustodySource, recording: RecordingSummary): void {
    try {
      const assignment = store.assignUnknownEndCustody(source, clock.now(),
        { recordingHandle: recording.recordingHandle, encryptedPath: recording.encryptedPath, sha256: recording.sha256, keyId: recording.keyId });
      entry.custody = assignment.outcome;
      log("occurrence_custody_assigned");
    } catch { entry.custody = "refused"; log("occurrence_custody_refused"); }
  }

  /** Abortable by shutdown; resolves either way. */
  function backoff(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (shutdown.signal.aborted || ms <= 0) { resolve(); return; }
      const done = () => { clearTimeout(timer); shutdown.signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, ms);
      shutdown.signal.addEventListener("abort", done, { once: true });
    });
  }

  /** Runs generations on the entry's slot until one ends without a recoverable
   * bridge failure. A recoverable failure (the store allowed the retry and left
   * the row listening) is relaunched after a backoff with a fresh Runtime owner
   * and bridge session; the store's retry limit bounds the attempts. */
  async function runOccurrence(entry: OccurrenceEntry): Promise<OccurrenceOutcome> {
    let recovery: CreateMeetingSessionOptions["recovery"];
    let outages: readonly RecognitionOutage[] = [];
    let gaveUp: PublishStoredGenerationsInput["reason"] | null = null;
    let relaunches = 0;
    for (let attempt = 1; ; attempt += 1) {
      await runGeneration(entry, recovery);
      const state = entry.session?.state() ?? null;
      if (state !== null) outages = state.recognitionOutages;
      const listening = storeOpen && store.getSession(entry.occurrenceId)?.state === "listening";
      if (!listening) break;
      // Only a recovery that could not continue gives up; a first generation
      // that ended otherwise keeps its own outcome (e.g. a rolled-back finalize).
      if (state?.terminalReason !== "bridge_failure") {
        if (recovery === undefined) break;
        // A relaunch that could not start (the Runtime refused the voice
        // session, startup or join failed) is retried within the same bound;
        // the earlier generation's capture loss stays open and is the gap. A
        // quarantined physical client is never retried.
        if (closing || entry.failure === "physical_client_quarantined" || relaunches >= MAX_BRIDGE_RELAUNCHES) {
          gaveUp = closing ? "application_closed" : "bridge_recovery_failed";
          break;
        }
        log("occurrence_bridge_relaunch_refused");
      } else {
        if (state.bridgeRetryAllowed !== true) { gaveUp = "bridge_failure_exhausted"; break; }
        if (closing) { gaveUp = "application_closed"; break; }
        if (relaunches >= MAX_BRIDGE_RELAUNCHES) { gaveUp = "bridge_recovery_failed"; break; }
        recovery = { uncoveredSince: state.captureLostAt ?? state.generationStartedAt, priorOutages: outages };
      }
      relaunches += 1;
      log("occurrence_bridge_recovery_scheduled");
      await backoff((options.bridgeRecoveryDelayMs ?? defaultBridgeRecoveryDelayMs)(attempt));
      entry.runtime = null; entry.session = null; entry.failure = null; entry.finalization = "none"; entry.custody = "not_applicable";
      entry.childLaunched = false; entry.childCleanup = new Deferred<void>(); entry.noise = null;
      if (closing) { entry.failure = "application_closed"; gaveUp = "application_closed"; break; }
    }
    // No generation can continue and none observed the end: publish what the
    // stored generations recorded, or fail visibly when nothing was recorded.
    let shipped: number | null = null;
    if (gaveUp !== null && storeOpen && store.getSession(entry.occurrenceId)?.state === "listening") {
      try {
        const published = entry.seedConfig === null ? null : store.publishStoredGenerations({ occurrenceId: entry.occurrenceId, nowMs: clock.now(), reason: gaveUp,
          seed: { ...entry.seedConfig, identity: entry.identity,
            processingWarnings: [...entry.seedConfig.processingWarnings, ...recognitionOutageWarnings(outages, new Date(clock.now()).toISOString())] } });
        if (published === null) { application.coordinator.fail(entry.occurrenceId, gaveUp); log("occurrence_bridge_recovery_failed"); }
        else { shipped = published.attempt; entry.finalization = "seeded"; log("occurrence_published_from_stored_generations"); }
      } catch { failures.add("bridge_recovery_record_failed"); }
    }
    for (const failed of entry.failedRecordings) {
      if (failed.attempt === shipped) continue;
      assignCustody(entry, { kind: "bridge_failure", occurrenceId: entry.occurrenceId, attempt: failed.attempt }, failed.recording);
    }
    occupied.delete(entry.bridgeId);
    entry.phase = "settled";
    return outcomeOf(entry);
  }

  async function runGeneration(entry: OccurrenceEntry, recovery: { readonly uncoveredSince: string } | undefined): Promise<void> {
    let joined = false;
    entry.generations += 1;
    try {
      entry.runtime = await startRuntimeOwner({ occurrenceId: entry.occurrenceId, shutdown: shutdown.signal, budgetMs, version, startTransport });
      entry.seedConfig ??= entry.runtime.seedConfig;
      if (closing) throw new OccurrenceStartupFailure("application_closed");
      log("occurrence_runtime_connected");
      markJoinTiming(options.joinTiming, "runtime_connected");
      try { entry.session = await application.createSession(entry.identity, recovery); }
      catch (error) {
        const message = error instanceof Error ? error.message : "";
        throw new OccurrenceStartupFailure(/closed/.test(message) ? "application_closed" : /quarantined/.test(message) ? "physical_client_quarantined" : "launch_failed");
      }
      markJoinTiming(options.joinTiming, "session_created");
      if (closing) throw new OccurrenceStartupFailure("application_closed");
      entry.phase = "live";
      markJoinTiming(options.joinTiming, "join_called");
      try { await entry.session.join(); joined = true; }
      catch {
        const reason = entry.session.state().terminalReason;
        entry.failure = reason === "join_failed" || reason === "media_format_rejected" ? reason : "join_cancelled";
      }
      markJoinTiming(options.joinTiming, "join_settled");
    } catch (error) {
      entry.failure = error instanceof OccurrenceStartupFailure ? error.code : "launch_failed";
    }
    if (joined && entry.runtime !== null) await entry.runtime.closeRequested; // The session closes its Runtime owner at terminal/dispose.
    if (entry.childLaunched) { await entry.childCleanup.promise; await nextTurn(); }
    if (entry.runtime !== null) {
      if (storeOpen) settleRecording(entry);
      await entry.runtime.close().catch(() => undefined);
      log("occurrence_runtime_closed");
      if (entry.runtime.closeOutcome() === "failed") failures.add("runtime_close_failed");
    }
    const noise = entry.noise?.();
    if (noise !== undefined && (noise.invalidLines > 0 || noise.stderrBytes > 0)) log("bridge_control_noise_tolerated");
  }

  function launchOccurrence(occurrence: InviteOccurrence, slot: BridgeProcessSlot): void {
    const identity = identityOf(occurrence);
    const entry: OccurrenceEntry = { occurrenceId: occurrence.occurrenceId, identity, bridgeId: slot.bridgeId, runtime: null, session: null,
      childLaunched: false, childCleanup: new Deferred<void>(), noise: null, generations: 0, failedRecordings: [], seedConfig: null, phase: "starting", failure: null, finalization: "none", custody: "not_applicable" };
    entries.set(entry.occurrenceId, entry);
    occupied.set(slot.bridgeId, entry.occurrenceId);
    entry.settled = runOccurrence(entry);
    log("occurrence_launched");
  }

  /** One durable join decision; every refusal or stale drop is a failed session with its reason. */
  function admitOne(occurrenceId: string, refusal?: "inviter_not_allowed" | "inviter_unverified"): void {
    // A refusal never touches an existing session; an allowed invite may admit a session that predates the allowlist.
    if (refusal !== undefined && store.getSession(occurrenceId) !== null) return;
    const outcome = store.admitInviteJoin(occurrenceId, clock.now(), refusal);
    if (outcome !== "admitted" && outcome !== "existing_session") log(`invite_admission_${outcome}`);
  }

  const unadmittedLogged = new Set<string>();
  // Per-row admission failures back off in memory so one bad row never stops later joins.
  const admissionBackoff = new Map<string, { failures: number; retryAtMs: number }>();

  /** Join lane: a valid invite alone admits and launches its occurrence. Synchronous, so it never
   * waits on the organizer lane; terminal or already-generated sessions never rejoin here. */
  function admitAndLaunch(): { launched: number; deferred: number } {
    let launched = 0, deferred = 0, after = "";
    while (!closing) {
      const page = store.listInviteOccurrences(after, DISCOVERY_PAGE);
      if (page.length === 0) break;
      for (const occurrence of page) {
        if (closing) continue;
        const backoff = admissionBackoff.get(occurrence.occurrenceId);
        if (backoff !== undefined && clock.now() < backoff.retryAtMs) continue;
        try {
          // A settled entry that never created a session (Runtime startup
          // failed before custody/spawn) leaves the durable row discovered and
          // may be retried by a later tick; anything else never relaunches here.
          const previous = entries.get(occurrence.occurrenceId);
          if (previous !== undefined && (previous.phase !== "settled" || previous.session !== null)) continue;
          const session = store.getSession(occurrence.occurrenceId);
          if (session === null) {
            // A recorded refusal is final for that invite; only a later allowed invite (at accept) reopens it.
            if (occurrence.state === "metadata_blocked" && ["inviter_not_allowed", "inviter_unverified", "invite_stale"].includes(occurrence.lastBlockedReason ?? "")) continue;
            // Otherwise the accept-time decision was lost (crash): the inviter is no longer known, so it fails closed.
            admitOne(occurrence.occurrenceId, inviteAdmission === "allowlist" ? "inviter_unverified" : "inviter_not_allowed");
            admissionBackoff.delete(occurrence.occurrenceId);
            continue;
          }
          admissionBackoff.delete(occurrence.occurrenceId);
          if (session.state !== "discovered") continue;
          // A session from before the allowlist launches only after an allowed invite admits it.
          if (!store.inviteJoinAllowed(occurrence.occurrenceId)) {
            if (!unadmittedLogged.has(occurrence.occurrenceId)) { unadmittedLogged.add(occurrence.occurrenceId); log("invite_admission_session_unverified"); }
            continue;
          }
          const slot = freeSlot();
          if (slot === null) { deferred += 1; continue; }
          launchOccurrence(occurrence, slot);
          launched += 1;
        } catch {
          const failures = (backoff?.failures ?? 0) + 1;
          admissionBackoff.set(occurrence.occurrenceId, { failures, retryAtMs: clock.now() + Math.min(60_000, 1000 * 2 ** Math.min(failures - 1, 6)) });
          log("invite_admission_failed");
        }
      }
      after = page[page.length - 1]!.occurrenceId;
    }
    return { launched, deferred };
  }

  /** One tick: launch first, then resolve organizer metadata (notification addressing only). */
  function discoverTick(): Promise<DiscoveryTick> {
    if (closing) return Promise.reject(new Error("composition_closed"));
    let early: { launched: number; deferred: number };
    try { early = admitAndLaunch(); } catch (error) { return Promise.reject(error); }
    if (discoveryInFlight !== null) return discoveryInFlight;
    discoveryInFlight = (async (): Promise<DiscoveryTick> => {
      log("discovery_tick");
      let resolved = 0;
      for (let count = 0; count < MAX_METADATA_RESOLUTIONS_PER_TICK && !closing; count += 1) {
        if (!await discovery.runOnce()) break;
        resolved += 1;
      }
      const late = admitAndLaunch();
      return { resolved, launched: early.launched + late.launched, deferred: late.deferred };
    })().finally(() => { discoveryInFlight = null; });
    return discoveryInFlight;
  }

  return {
    stateDatabasePath: databasePath,
    async start(): Promise<void> {
      if (closing) throw new Error("composition_closed");
      if (started) throw new Error("composition_already_started");
      started = true;
      // Before any occurrence launches, so no live entry exists: recordings and
      // capture rows a previous process left get their retention now.
      log(maintenance.sweepRetention());
      // Maintenance lanes start before, and never wait on, Feishu ingress readiness.
      maintenance.start();
      if (ingress !== null) await ingress.start();
      if (inviteAdmission === "no_inviters_configured") log("invite_admission_no_inviters_configured");
      if (allowedChats.size > 0) log("invite_admission_chat_ids_unverified"); // The invite event is not known to carry a chat ID.
      if (inviteAdmission === "chat_ids_only_unverified") log("invite_admission_refuses_all_invites");
      log("composition_started");
    },
    discover: discoverTick,
    maintenanceStatus: () => ({ ...maintenance.status(), inviteAdmission }),
    maintenanceTick: (lane) => maintenance.tick(lane),
    retryInviteMetadata(occurrenceId, operator) {
      if (closing) throw new Error("composition_closed");
      return store.retryInviteMetadata(occurrenceId, operator, clock.now());
    },
    liveOccurrenceIds: () => [...entries.values()].filter((entry) => entry.phase !== "settled").map((entry) => entry.occurrenceId),
    occurrenceOutcomes: () => [...entries.values()].map(outcomeOf),
    awaitOccurrence(occurrenceId) {
      const settled = entries.get(occurrenceId)?.settled;
      return settled === undefined ? Promise.reject(new Error("unknown_occurrence")) : settled;
    },
    close(): Promise<void> {
      if (closePromise !== null) return closePromise;
      closePromise = (async () => {
        closing = true;
        shutdown.abort();
        options.shutdownSignal?.removeEventListener("abort", onExternalShutdown);
        ingress?.dispatcher.fence();
        log("shutdown_fenced");
        // Cut C: fence ticks, cancel/await every lane and its worker (backfill
        // awaits its child cleanup) before any other owner or the store closes.
        try { await maintenance.close(); }
        catch (error) {
          const message = error instanceof Error ? error.message : "";
          for (const code of (/^maintenance_close_failed:(.+)$/.exec(message)?.[1] ?? "maintenance_close_failed").split(",")) failures.add(code);
        }
        if (discoveryInFlight !== null) await discoveryInFlight.catch(() => undefined);
        if (!await discovery.close()) failures.add("discovery_close_unconfirmed");
        log("shutdown_owned_work_settled");
        try { await application.close(); } catch { failures.add("application_close_failed"); }
        log("shutdown_application_closed");
        await Promise.allSettled([...entries.values()].map((entry) => entry.settled ?? Promise.resolve()));
        log("shutdown_runtime_owners_closed");
        if (ingress !== null) { if (!(await ingress.close()).clean) failures.add("ingress_close_unclean"); }
        else if (ownsHttp) { try { await http.close(); } catch { failures.add("feishu_http_close_failed"); } }
        log("shutdown_transports_closed");
        storeOpen = false;
        store.close();
        log("shutdown_store_closed");
        if (failures.size > 0) throw new Error(`composition_close_failed:${[...failures].sort().join(",")}`);
      })();
      return closePromise;
    },
  };
}

/** The entry's lifecycle runner: compose, start, one durable discovery tick,
 * wait for a shutdown signal, close. Refusals are reported as static codes. */
export async function runStandaloneComposition(config: StandaloneConfigV1, owner: ApplicationOwnerLock, options: ComposeApplicationOptions = {}): Promise<StandaloneCompositionResult> {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  const signals: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.once(signal, onSignal);
  try {
    let application: ComposedApplication;
    try { application = await composeApplication(config, owner, { ...options, shutdownSignal: controller.signal }); }
    catch (error) {
      const message = error instanceof Error ? error.message : "";
      return { status: "composition_unavailable", reason: /^[a-z_]+(:[A-Za-z]+)?$/.test(message) ? message : "composition_failed" };
    }
    let clean = true;
    try {
      if (!controller.signal.aborted) {
        await application.start();
        await application.discover();
        await new Promise<void>((resolve) => {
          if (controller.signal.aborted) resolve();
          else controller.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    } catch { clean = false; }
    try { await application.close(); } catch { clean = false; }
    return { status: "composition_closed", clean };
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
  }
}
