// Application Cut B: durable invitation → admitted live occurrence → observed
// end → finalization seed, composed by src/application-composition.ts.
//
// Every peer here is a scripted in-process peer (a v2 bridge slot, the real
// RuntimeClient over a scripted transport, the real Feishu SDK over a local
// websocket peer). The accepted gateway binary is used only through the
// existing MEETING_TEST_RUNTIME_GATEWAY pattern. No live network, device,
// provider or key is touched.

import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { Agent } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { test } from "node:test";
import Database from "better-sqlite3";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientCommand } from "@conversation/runtime";

import { acquireApplicationOwnerLock, type ApplicationOwnerLock } from "../src/adapters/application-owner-lock.ts";
import { createFeishuSdkHttp } from "../src/adapters/feishu-sdk-http.ts";
import { createFeishuSocketOwner } from "../src/adapters/feishu-sdk-connection.ts";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { composeApplication, stateDatabasePath, RUNTIME_CHILD_ENVIRONMENT_ALLOWLIST, type ComposeApplicationOptions, type ComposedApplication } from "../src/application-composition.ts";
import { normalizeInvite } from "../src/ports/feishu-ingress.ts";
import type { BridgeProcessSlot, BridgeShutdownResult, OwnedBridgeProcess } from "../src/ports/bridge-process.ts";
import type { FeishuOrganizerLookup } from "../src/ports/feishu.ts";
import type { BridgeProcessOutcome, CustodyBinding } from "../src/contracts/bridge-process-outcome-v1.ts";
import type { BridgeCommandMessageV2 } from "../src/contracts/bridge-session-v2.ts";
import { STANDALONE_SCHEMA, type StandaloneConfigV1 } from "../src/standalone-config.ts";
import { RuntimeTestTransport } from "./lib/runtime-sdk.ts";
import { envelope, scope, httpPeer, eventFrame, framePayload } from "./lib/feishu-fixtures.ts";

const NODE24 = "/opt/homebrew/opt/node@24/bin/node";
const CHILD_FIXTURE = path.resolve("test/fixtures/composition-bridge-child.mjs");
const OBSERVED_AT = "2026-09-02T14:30:00.000Z";

// ---------------------------------------------------------------------------
// Fixture: private state root, data paths, config, counting owner
// ---------------------------------------------------------------------------

type Fixture = {
  readonly dir: string;
  readonly stateRoot: string;
  readonly config: StandaloneConfigV1;
  readonly databasePath: string;
  readonly owner: ApplicationOwnerLock & { readonly asserted: () => number; readonly closed: () => number };
  reopen(): ReturnType<typeof openSessionStore>;
  raw<T>(fn: (db: Database.Database) => T): T;
  close(): void;
};

function fixture(slots = 1): Fixture {
  const dir = realpathSync(mkdtempSync(path.join(realpathSync(tmpdir()), "meeting-composition-")));
  const stateRoot = path.join(dir, "state");
  mkdirSync(stateRoot, { mode: 0o700 }); chmodSync(stateRoot, 0o700);
  for (const name of ["recordings", "outbox", "receipts", "vault"]) mkdirSync(path.join(dir, name));
  writeFileSync(path.join(dir, "app-secret"), "synthetic-app-secret\n", { mode: 0o600 });
  writeFileSync(path.join(dir, "bridge-static.json"), JSON.stringify({ schema: "feishu-bridge-config/v1", bundleVersion: "no-join", evidenceRoot: dir }), { mode: 0o600 });
  const config: StandaloneConfigV1 = {
    schema: STANDALONE_SCHEMA, stateRoot,
    feishu: { region: "feishu", tenantKey: scope.tenantKey, appId: scope.appId, appSecretFile: path.join(dir, "app-secret") },
    agentIdentity: { aliases: ["Meetbot"] },
    dataPaths: { recordingsDir: path.join(dir, "recordings"), outboxDir: path.join(dir, "outbox"), receiptsDir: path.join(dir, "receipts"), teamVaultDir: path.join(dir, "vault") },
    runtime: { launcherPath: path.join(dir, "runtime-launcher"), gatewayConfigPath: path.join(dir, "gateway.toml"), protocolVersion: 4 },
    bridgeSlots: Array.from({ length: slots }, (_, index) => ({ physicalClientId: `mac-${index + 1}`, bridgeId: `bridge-${index + 1}`,
      executable: NODE24, staticConfigPath: path.join(dir, "bridge-static.json"), argv: [CHILD_FIXTURE], cooperativeGraceMs: 1000 })),
  };
  let asserted = 0, closed = 0;
  const databasePath = stateDatabasePath(config);
  return {
    dir, stateRoot, config, databasePath,
    owner: { assertCurrentOwnership() { asserted += 1; }, close() { closed += 1; }, asserted: () => asserted, closed: () => closed },
    reopen: () => openSessionStore({ filename: databasePath }),
    raw<T>(fn: (db: Database.Database) => T): T { const db = new Database(databasePath); try { db.pragma("foreign_keys = ON"); return fn(db); } finally { db.close(); } },
    close() { rmSync(dir, { recursive: true, force: true }); },
  };
}

// ---------------------------------------------------------------------------
// Scripted Runtime peer: the real RuntimeClient parses every reply.
// ---------------------------------------------------------------------------

type RuntimeScript = {
  /** Keep connect pending: never push ready. */
  holdReady?: boolean;
  startMode?: "accept" | "reject" | "hang";
  /** already_ended: the gateway ends the voice session before stop is asked. */
  /** reject_as_inactive: the gateway rejects stop with the SDK's own "no longer
   * active" wording but never routed a terminal; that is a stop failure. */
  /** terminal_then_reject: the terminal for this exact handle is routed first and
   * the same stop request is then rejected; the SDK reports already_terminal. */
  stopMode?: "accept" | "reject" | "reject_as_inactive" | "terminal_then_reject" | "hang" | "already_ended";
  finalizeMode?: "accept" | "reject";
  closeFails?: boolean;
  recordingsDir: string;
};

type ScriptedRuntime = {
  readonly transport: RuntimeTestTransport;
  readonly controlSessionId: bigint;
  readonly handle: string;
  readonly commands: () => readonly ClientCommand["type"][];
  readonly closes: () => number;
  readonly recordingPath: string;
  readonly deliver: (event: Record<string, unknown>) => void;
};

function scriptedRuntimes(script: RuntimeScript) {
  const owned: ScriptedRuntime[] = [];
  let next = 100n;
  const factory: NonNullable<ComposeApplicationOptions["startRuntimeTransport"]> = async () => {
    const transport = new RuntimeTestTransport();
    const controlSessionId = next++;
    const id = controlSessionId.toString();
    const handle = id.padStart(32, "0").replaceAll(/[^0-9a-f]/g, "a");
    const recordingPath = path.join(script.recordingsDir, `${handle}.crsr`);
    let closes = 0;
    const close = transport.close.bind(transport);
    transport.close = async () => { closes += 1; await close(); if (script.closeFails) throw new Error("scripted transport close failure"); };
    let voiceEnded = false;
    const deliver = (event: Record<string, unknown>) => transport.push({ type: "voice_event", protocol_version: 4, event });
    transport.onSend = (command) => {
      const accept = (extra: Record<string, unknown> = {}) => transport.push({ type: "command_accepted", protocol_version: 4, request_id: command.requestId, ...extra });
      switch (command.type) {
        case "status":
          accept();
          transport.push({ type: "status", protocol_version: 4, request_id: command.requestId, status: readyStatus }); return;
        case "start_drainable_timed_voice_session":
          if ((script.startMode ?? "accept") === "hang") return;
          if (script.startMode === "reject") {
            transport.push({ type: "command_rejected", protocol_version: 4, request_id: command.requestId, error: { code: "invalid_state", kind: "invalid_state", stage: "runtime", message: "scripted start rejection" } }); return;
          }
          accept();
          transport.push({ type: "timed_voice_session_started", protocol_version: 4, request_id: command.requestId, media_lease: { media_protocol_version: 3, session_id: id,
            connect_endpoint: "tcp://127.0.0.1:9001", credential: "a".repeat(64), expires_at_ms: String(Date.now() + 60_000), reconnect_window_ms: "10000",
            capture_format: "pcm_s16le/24000/1/20ms", timing_contract: "capture-clock/v1" } });
          deliver({ type: "voice_session_started", session_id: id, privacy: { privacy_mode: "local_only",
            components: ["speech_recognition", "language_model", "speech_synthesis", "audio_io"].map((kind) => ({ kind, execution_location: "local", provider_label: "Synthetic" })) } });
          if (script.stopMode === "already_ended") { voiceEnded = true; deliver({ type: "voice_session_ended", session_id: id }); }
          return;
        case "stop_voice_session":
          if (script.stopMode === "hang") return;
          if (script.stopMode === "terminal_then_reject") {
            voiceEnded = true;
            deliver({ type: "voice_session_ended", session_id: id });
            transport.push({ type: "command_rejected", protocol_version: 4, request_id: command.requestId, error: { code: "invalid_state", kind: "invalid_state", stage: "runtime",
              message: "voice session is no longer active" } }); return;
          }
          if (script.stopMode === "reject" || script.stopMode === "reject_as_inactive") {
            transport.push({ type: "command_rejected", protocol_version: 4, request_id: command.requestId, error: { code: "invalid_state", kind: "invalid_state", stage: "runtime",
              message: script.stopMode === "reject" ? "scripted stop rejection" : "voice session is no longer active" } }); return;
          }
          accept();
          if (!voiceEnded) { voiceEnded = true; deliver({ type: "voice_session_ended", session_id: id }); }
          return;
        case "finalize_recording":
          if (script.finalizeMode === "reject") {
            transport.push({ type: "command_rejected", protocol_version: 4, request_id: command.requestId, error: { code: "invalid_state", kind: "invalid_state", stage: "runtime", message: "scripted finalize rejection" } }); return;
          }
          writeFileSync(recordingPath, Buffer.from(`ciphertext-${id}`));
          accept();
          transport.push({ type: "recording_finalized", protocol_version: 4, request_id: command.requestId,
            recording: { recording_handle: handle, encrypted_path: recordingPath, sha256: "b".repeat(64), key_id: "c".repeat(16), duration_ms: "10", format: "pcm_s16le/24000/1/20ms", gaps: [] },
            recovery_capability: { source_session_id: id, recording_handle: handle, sha256: "b".repeat(64), key_id: "c".repeat(16), authorization: "d".repeat(64) } });
          return;
        case "authorize_voice_response": accept({ turn_id: "99" }); return;
        default: accept(); return;
      }
    };
    const readyStatus = { profile: "online", transport: "stdio", privacy_mode: "hybrid", language_location: "remote", model_id: "scripted-text-model",
      memory_enabled: false, memory_location: null, telemetry_enabled: false, capabilities: ["text", "conversation_context_seed", "voice_session"],
      components: [{ kind: "speech_recognition", execution_location: "remote", provider_label: "scripted-stt" }, { kind: "language_model", execution_location: "remote", provider_label: "scripted-text" },
        { kind: "speech_synthesis", execution_location: "local", provider_label: "scripted-tts" }, { kind: "audio_io", execution_location: "local", provider_label: "scripted-audio" }],
      last_context_seed_operation_id: null };
    if (!script.holdReady) transport.push({ type: "ready", protocol_version: 4, current_session_id: id, status: readyStatus });
    const runtime: ScriptedRuntime = { transport, controlSessionId, handle, recordingPath, deliver, commands: () => transport.commands.map((command) => command.type), closes: () => closes };
    owned.push(runtime);
    return transport;
  };
  return { factory, owned };
}

// ---------------------------------------------------------------------------
// Scripted v2 bridge slot: an in-process peer implementing BridgeProcessSlot.
// ---------------------------------------------------------------------------

type SlotScript = {
  joinMode?: "joined" | "silent" | "reject" | "leave";
  outcome?: "departure_confirmed" | "no_join_action" | "outcome_missing";
  launchMode?: "immediate" | "pending";
  /** Assertions executed inside launch, before the child "spawns". */
  onLaunch?: (binding: CustodyBinding) => void;
};

type ScriptedSlot = BridgeProcessSlot & {
  readonly launches: CustodyBinding[];
  readonly shutdowns: () => number;
  readonly sent: () => readonly BridgeCommandMessageV2[];
  emit(event: Record<string, unknown>): void;
  left(reason: "ended" | "removed" | "bridge_failure", timing?: boolean): void;
  resolveLaunch(): void;
};

function scriptedSlot(index: number, script: SlotScript = {}): ScriptedSlot {
  const launches: CustodyBinding[] = [];
  const sent: BridgeCommandMessageV2[] = [];
  let listener: ((raw: unknown) => void) | undefined, sequence = 0, shutdowns = 0, binding: CustodyBinding | undefined;
  let releaseLaunch: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { releaseLaunch = resolve; });
  const timing = { clockDomainId: "domain", hostBeforeNs: "0", hostAfterNs: "1" };
  const emit = (event: Record<string, unknown>) => listener?.({ schema: "bridge-session/v2", sessionId: binding?.bridgeSessionId, sequence: ++sequence, observedAt: OBSERVED_AT, ...event });
  return {
    physicalClientId: `mac-${index}`, bridgeId: `bridge-${index}`, launches, shutdowns: () => shutdowns, sent: () => sent, emit,
    left(reason, withTiming = true) { emit({ type: "left", reason, observationTiming: withTiming ? timing : null, observationTimingReason: withTiming ? null : "timing_unavailable" }); },
    resolveLaunch() { releaseLaunch?.(); },
    async launch(value) {
      script.onLaunch?.(value);
      launches.push(value); binding = value;
      if (script.launchMode === "pending") await pending;
      const bridge = {
        subscribe(callback: (raw: unknown) => void) { listener = callback; return () => { listener = undefined; }; },
        async send(command: BridgeCommandMessageV2) {
          sent.push(command);
          if (command.type === "join") {
            if (script.joinMode === "reject") throw new Error("bridge_control_rejected");
            if (script.joinMode === "leave") emit({ type: "left", reason: "ended", observationTiming: timing, observationTimingReason: null });
            if ((script.joinMode ?? "joined") === "joined") emit({ type: "joined", meetingOccurrenceId: command.meetingOccurrenceId, observationTiming: timing, observationTimingReason: null });
          }
        },
      };
      const owned: OwnedBridgeProcess = { bridge: bridge as unknown as OwnedBridgeProcess["bridge"], async shutdown(): Promise<BridgeShutdownResult> {
        shutdowns += 1;
        const outcome = script.outcome ?? "no_join_action";
        if (outcome === "outcome_missing") return { reaped: true, exitDiagnostic: null, outcome: null, failure: "outcome_missing" };
        const settled: BridgeProcessOutcome = outcome === "departure_confirmed"
          ? { schema: "bridge-process-outcome/v1", ...value, outcome: "departure_confirmed", reason: "departure_observed", observedAt: OBSERVED_AT }
          : { schema: "bridge-process-outcome/v1", ...value, outcome: "no_join_action", reason: "join_not_issued", observedAt: OBSERVED_AT };
        return { reaped: true, exitDiagnostic: null, failure: null, outcome: settled };
      } };
      return owned;
    },
  };
}

function resolvedLookup(meetingNos: readonly string[]): FeishuOrganizerLookup {
  return { async resolve(invite) {
    if (!meetingNos.includes(invite.meetingNo)) return { status: "blocked", reason: "reference_missing", retryable: false };
    return { status: "resolved", organizer: { ...scope, idType: "open_id", id: "ou_creator", displayName: "Creator", source: "reservation" }, reference: { kind: "reservation", reserveId: `reserve-${invite.meetingNo}` } };
  } };
}

function invite(index: number, meetingNo = "900000001") {
  const raw = envelope(`event-${index}`, `${9007199254740000 + index}`, `Meeting ${index}`);
  return normalizeInvite({ ...raw, event: { ...raw.event, meeting: { ...raw.event.meeting, meeting_no: meetingNo } } }, scope);
}

async function until(check: () => boolean, budgetMs = 2000): Promise<void> {
  const deadline = performance.now() + budgetMs;
  while (!check()) { if (performance.now() >= deadline) throw new Error("fixture_condition_timeout"); await pause(2); }
}

function composeFor(f: Fixture, options: ComposeApplicationOptions = {}): Promise<ComposedApplication> {
  return composeApplication(f.config, f.owner, { inviteIngress: false, ...options });
}

// ---------------------------------------------------------------------------
// 1. Store lifetime, order and shutdown
// ---------------------------------------------------------------------------

test("composition realpath-rechecks every data path against the state root and refuses before any store exists", async () => {
  const f = fixture();
  try {
    const aliased = path.join(f.dir, "aliased-recordings");
    symlinkSync(path.join(f.stateRoot), aliased);
    const config = { ...f.config, dataPaths: { ...f.config.dataPaths, recordingsDir: aliased } };
    await assert.rejects(composeApplication(config, f.owner, { inviteIngress: false }), /data_path_unsafe/);
    assert.equal(existsSync(f.databasePath), false);
    const missing = { ...f.config, dataPaths: { ...f.config.dataPaths, outboxDir: path.join(f.dir, "absent") } };
    await assert.rejects(composeApplication(missing, f.owner, { inviteIngress: false }), /data_path_unsafe/);
    assert.equal(existsSync(f.databasePath), false);
    assert.equal(f.owner.asserted() >= 1, true, "the held owner lock is rechecked before any store");
    assert.equal(f.owner.closed(), 0);
  } finally { f.close(); }
});

test("one application-owned store opens inside the private root after the lock; close never touches the lock and is idempotent", async () => {
  const f = fixture();
  const log: string[] = [];
  const runtimes = scriptedRuntimes({ recordingsDir: f.config.dataPaths.recordingsDir });
  try {
    const app = await composeFor(f, { log: (code) => log.push(code), startRuntimeTransport: runtimes.factory, bridgeSlots: [scriptedSlot(1)] });
    assert.equal(path.dirname(f.databasePath), f.stateRoot);
    const stat = lstatSync(f.databasePath, { bigint: true });
    assert.equal(stat.isFile(), true); assert.equal(stat.nlink, 1n);
    assert.equal(log.indexOf("composition_lock_verified") < log.indexOf("composition_store_opened"), true);
    await app.start();
    await assert.rejects(app.start(), /already_started/);
    const first = app.close(), second = app.close();
    assert.equal(first, second);
    await first;
    await app.close();
    const shutdown = log.filter((code) => code.startsWith("shutdown_"));
    assert.deepEqual(shutdown, ["shutdown_fenced", "shutdown_owned_work_settled", "shutdown_application_closed", "shutdown_runtime_owners_closed", "shutdown_transports_closed", "shutdown_store_closed"]);
    assert.equal(f.owner.closed(), 0, "the caller closes the lock last");
    await assert.rejects(app.discover(), /closed/);
    const reopened = f.reopen();
    try { assert.equal(reopened.schemaVersion, 29); } finally { reopened.close(); }
  } finally { f.close(); }
});

test("a private root that is not owned 0700 or a replaced database identity fails closed without chmod or repair", async () => {
  const f = fixture();
  try {
    chmodSync(f.stateRoot, 0o750);
    await assert.rejects(composeFor(f), /private_state_unsafe/);
    assert.equal((statSync(f.stateRoot).mode & 0o777), 0o750, "no repair");
    chmodSync(f.stateRoot, 0o700);
    symlinkSync(path.join(f.dir, "elsewhere.db"), f.databasePath);
    await assert.rejects(composeFor(f), /private_state_unsafe/);
    assert.equal(lstatSync(f.databasePath).isSymbolicLink(), true);
  } finally { f.close(); }
});

test("shutdown during a pending SDK connect aborts the launch, closes the retained transport and reports no closed-store callback", async () => {
  const f = fixture();
  const log: string[] = [];
  const runtimes = scriptedRuntimes({ recordingsDir: f.config.dataPaths.recordingsDir, holdReady: true });
  const slot = scriptedSlot(1);
  const controller = new AbortController();
  const seed = f.reopen();
  try {
    seed.acceptInvite(invite(1), 1); const claim = seed.claimInviteMetadata(2)!;
    seed.completeInviteClaim(claim, { status: "resolved", organizer: { ...scope, idType: "open_id", id: "ou_creator", displayName: "Creator", source: "reservation" }, reference: { kind: "reservation", reserveId: "reserve" } }, 3);
  } finally { seed.close(); }
  try {
    const app = await composeFor(f, { log: (code) => log.push(code), startRuntimeTransport: runtimes.factory, bridgeSlots: [slot], shutdownSignal: controller.signal, metadata: resolvedLookup(["900000001"]) });
    await app.start();
    assert.equal((await app.discover()).launched, 1);
    await until(() => runtimes.owned.length === 1);
    assert.deepEqual(slot.launches, [], "no bridge spawn before the Runtime control identity is connected");
    controller.abort();
    await app.close();
    assert.equal(runtimes.owned[0]!.closes(), 1);
    assert.deepEqual(slot.launches, []);
    assert.equal(app.occurrenceOutcomes()[0]?.failure, "runtime_startup_aborted");
    const closedAt = log.indexOf("shutdown_store_closed");
    assert.ok(closedAt >= 0);
    assert.deepEqual(log.slice(closedAt + 1).filter((code) => !code.startsWith("shutdown_")), [], "nothing touches the store after it closed");
    const reopened = f.reopen();
    try { assert.equal(reopened.getSession(invite(1).occurrenceId)?.state, "discovered", "an aborted start never advances the durable row"); }
    finally { reopened.close(); }
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// 2. Durable invitation → discovery
// ---------------------------------------------------------------------------

test("the real Feishu SDK ingress commits the normalized envelope before ACK; DB failure, overflow and conflicting replay are not ACKed", async () => {
  const f = fixture();
  const peer = await httpPeer((_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ code: 0, data: {
    URL: peer.origin.replace("http:", "ws:") + "/ws?device_id=synthetic&service_id=1", ClientConfig: { PingInterval: 100, ReconnectCount: 1, ReconnectInterval: 0, ReconnectNonce: 0 } } })); });
  const server = new WebSocketServer({ server: peer.server, perMessageDeflate: false, maxPayload: 65536 });
  const connected = once(server, "connection");
  const http = createFeishuSdkHttp({ request: peer.request, connection: createFeishuSocketOwner(Agent) });
  const runtimes = scriptedRuntimes({ recordingsDir: f.config.dataPaths.recordingsDir });
  let app: ComposedApplication | undefined;
  try {
    app = await composeApplication(f.config, f.owner, { startRuntimeTransport: runtimes.factory, bridgeSlots: [scriptedSlot(1, { joinMode: "silent" })],
      metadata: resolvedLookup([]), feishu: { http, connection: createFeishuSocketOwner(Agent), readyTimeoutMs: 2000, handshakeTimeoutMs: 500 } });
    await app.start();
    const [socket] = await connected as [WebSocket];
    const responses: unknown[] = [];
    socket.on("message", (bytes) => { const payload = framePayload(Buffer.from(bytes as Buffer)); if (payload) responses.push(payload); });
    socket.send(eventFrame(envelope("first", "9007199254740993")));
    await until(() => responses.length >= 1);
    assert.deepEqual(responses[0], { code: 200 });
    const store = f.reopen();
    try {
      assert.equal(store.listInviteOccurrences().length, 1, "the ACK follows the durable commit");
      assert.equal(store.listInviteOccurrences()[0]?.title, "Synthetic meeting");
    } finally { store.close(); }
    socket.send(eventFrame(envelope("first", "9007199254740993", "changed title"), "conflict"));
    await until(() => responses.length >= 2);
    assert.deepEqual(responses[1], { code: 500 }, "a conflicting replay of the same event id is refused, not ACKed");
    f.raw((db) => db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON feishu_invite_events BEGIN SELECT RAISE(ABORT,'synthetic'); END"));
    socket.send(eventFrame(envelope("db-failure", "9007199254740994"), "db-failure"));
    await until(() => responses.length >= 3);
    assert.deepEqual(responses[2], { code: 500 });
    f.raw((db) => { db.exec("DROP TRIGGER reject_event"); assert.equal((db.prepare("SELECT count(*) AS n FROM feishu_invite_occurrences").get() as { n: number }).n, 1); });
    const closed = once(socket, "close");
    await app.close(); app = undefined;
    await closed;
  } finally {
    if (app) await app.close().catch(() => {});
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await http.close().catch(() => {});
    await peer.close();
    f.close();
  }
});

test("process death after commit before callback: reopened bounded discovery launches an eligible occurrence exactly once; duplicates, terminal sessions and blocked metadata never launch", async () => {
  const f = fixture(2);
  const runtimes = scriptedRuntimes({ recordingsDir: f.config.dataPaths.recordingsDir });
  const slots = [scriptedSlot(1, { joinMode: "silent" }), scriptedSlot(2, { joinMode: "silent" })];
  const blocked = invite(2, "900000002"), terminal = invite(3, "900000003"), eligible = invite(1);
  const seed = f.reopen();
  try {
    // A dead process committed three invites and never ran its callbacks.
    seed.acceptInvite(eligible, 1); seed.acceptInvite(blocked, 1); seed.acceptInvite(terminal, 1);
    assert.equal(seed.acceptInvite(eligible, 2), "replay");
    // The terminal one was admitted and failed in an earlier life.
    const claims = [seed.claimInviteMetadata(3)!, seed.claimInviteMetadata(3)!, seed.claimInviteMetadata(3)!];
    const terminalClaim = claims.find((claim) => claim.occurrenceId === terminal.occurrenceId)!;
    seed.completeInviteClaim(terminalClaim, { status: "resolved", organizer: { ...scope, idType: "open_id", id: "ou_creator", displayName: "Creator", source: "reservation" }, reference: { kind: "reservation", reserveId: "reserve" } }, 4);
    f.raw((db) => db.prepare("UPDATE sessions SET state='failed', terminal_reason='bridge_failure' WHERE occurrence_id=?").run(terminal.occurrenceId));
    for (const claim of claims) if (claim.occurrenceId !== terminal.occurrenceId) seed.failInviteClaim(claim, { status: "blocked", reason: "timeout", retryable: true }, 5, 1000);
  } finally { seed.close(); }
  try {
    const app = await composeFor(f, { startRuntimeTransport: runtimes.factory, bridgeSlots: slots, metadata: resolvedLookup(["900000001"]), clock: { now: () => 10_000 } });
    await app.start();
    const first = await app.discover();
    assert.equal(first.launched, 1);
    await until(() => slots[0]!.launches.length + slots[1]!.launches.length === 1);
    const second = await app.discover();
    assert.equal(second.launched, 0, "a second tick never relaunches a live occurrence");
    assert.deepEqual(app.liveOccurrenceIds(), [eligible.occurrenceId]);
    const store = f.reopen();
    try {
      assert.equal(store.getInviteOccurrence(eligible.occurrenceId)?.state, "admitted");
      assert.equal(store.getInviteOccurrence(blocked.occurrenceId)?.state, "metadata_blocked");
      assert.equal(store.getInviteOccurrence(blocked.occurrenceId)?.lastBlockedReason, "reference_missing");
      assert.equal(store.getInviteOccurrence(blocked.occurrenceId)?.organizer, null, "no host/inviter organizer is fabricated");
      assert.equal(store.getSession(blocked.occurrenceId), null);
      assert.equal(store.getSession(terminal.occurrenceId)?.state, "failed");
      assert.equal(store.getSession(eligible.occurrenceId)?.state, "joining");
    } finally { store.close(); }
    const launched = slots.find((slot) => slot.launches.length === 1)!;
    assert.equal(launched.launches[0]!.occurrenceId, eligible.occurrenceId);
    const identity = app.occurrenceOutcomes().find((outcome) => outcome.occurrenceId === eligible.occurrenceId)!;
    assert.deepEqual(identity.organizer, { feishuUserId: "ou_creator", displayName: "Creator", source: "reservation" });
    await app.close();
    // Reopen after this life: the blocked invite is still visible and only the exact operator retry moves it.
    const again = await composeFor(f, { startRuntimeTransport: runtimes.factory, bridgeSlots: [scriptedSlot(1, { joinMode: "silent" }), scriptedSlot(2, { joinMode: "silent" })],
      metadata: resolvedLookup(["900000001", "900000002"]), clock: { now: () => 20_000 } });
    await again.start();
    assert.equal((await again.discover()).launched, 0, "a terminal row from an earlier life is never auto-rejoined");
    const earlier = f.reopen();
    try { assert.equal(earlier.getSession(eligible.occurrenceId)?.state, "failed"); } finally { earlier.close(); }
    const reopened = f.reopen();
    try { assert.equal(reopened.getInviteOccurrence(blocked.occurrenceId)?.state, "metadata_blocked"); } finally { reopened.close(); }
    assert.equal(again.retryInviteMetadata(blocked.occurrenceId, "operator"), "pending");
    const tick = await again.discover();
    assert.equal(tick.launched, 1);
    await again.close();
    const final = f.reopen();
    try { assert.equal(final.getInviteOccurrence(blocked.occurrenceId)?.state, "admitted"); assert.equal(final.getInviteOccurrence(blocked.occurrenceId)?.organizer?.id, "ou_creator"); }
    finally { final.close(); }
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// 3. Physical custody before spawn
// ---------------------------------------------------------------------------

async function admitted(f: Fixture, count: number, meetingNo = "900000001"): Promise<string[]> {
  const store = f.reopen();
  try {
    const ids: string[] = [];
    for (let index = 1; index <= count; index += 1) { const value = invite(index, meetingNo); store.acceptInvite(value, index); ids.push(value.occurrenceId); }
    return ids;
  } finally { store.close(); }
}

test("custody is claimed durably before spawn; a lost private outcome quarantines exactly that slot while an unrelated slot continues", async () => {
  const f = fixture(2);
  const runtimes = scriptedRuntimes({ recordingsDir: f.config.dataPaths.recordingsDir });
  const claimedBeforeSpawn: boolean[] = [];
  const lost = scriptedSlot(1, { outcome: "outcome_missing", onLaunch(binding) {
    const verifier = f.reopen();
    try { claimedBeforeSpawn.push(verifier.listPhysicalCustody().some((row) => row.physicalGenerationId === binding.physicalGenerationId && row.state === "quarantined")); }
    finally { verifier.close(); }
  } });
  const healthy = scriptedSlot(2, { outcome: "departure_confirmed" });
  const [first, second, third] = await admitted(f, 3);
  try {
    const app = await composeFor(f, { startRuntimeTransport: runtimes.factory, bridgeSlots: [lost, healthy], metadata: resolvedLookup(["900000001"]), clock: { now: () => 10_000 } });
    await app.start();
    assert.equal((await app.discover()).launched, 2);
    await until(() => claimedBeforeSpawn.length === 1);
    assert.deepEqual(claimedBeforeSpawn, [true]);
    await until(() => lost.sent().some((command) => command.type === "join") && healthy.sent().some((command) => command.type === "join"));
    lost.left("removed"); healthy.left("removed");
    await app.awaitOccurrence(first!); await app.awaitOccurrence(second!);
    const store = f.reopen();
    try {
      const rows = store.listPhysicalCustody();
      assert.equal(rows.find((row) => row.physicalClientId === "mac-1")?.state, "quarantined");
      assert.equal(rows.find((row) => row.physicalClientId === "mac-2")?.state, "cleared");
    } finally { store.close(); }
    const tick = await app.discover();
    assert.equal(tick.launched, 1, "the third occurrence takes the unrelated healthy slot");
    await until(() => healthy.launches.length === 2);
    assert.equal(lost.launches.length, 1);
    assert.equal(healthy.launches[1]!.occurrenceId, third);
    healthy.left("removed");
    await app.awaitOccurrence(third!);
    await app.close();
  } finally { f.close(); }
});

test("real v2 children: the timed join reaches joined, the owner lock descriptor is never inherited, the child env is allowlisted, a hung child leaves its slot quarantined, and a static file without audio refuses before any store", { timeout: 25_000 }, async () => {
  const f = fixture(3);
  const audio = { captureDisplayId: 1, outputDeviceUid: "synthetic-output-device" };
  for (const name of ["bridge-v2-hung", "bridge-v2-clean", "bridge-v2-view"]) mkdirSync(path.join(f.dir, name));
  writeFileSync(path.join(f.dir, "bridge-hung.json"), JSON.stringify({ schema: "feishu-bridge-config/v1", bundleVersion: "hung", evidenceRoot: path.join(f.dir, "bridge-v2-hung"), audio }), { mode: 0o600 });
  writeFileSync(path.join(f.dir, "bridge-clean.json"), JSON.stringify({ schema: "feishu-bridge-config/v1", bundleVersion: "clean", evidenceRoot: path.join(f.dir, "bridge-v2-clean"), audio }), { mode: 0o600 });
  writeFileSync(path.join(f.dir, "bridge-view.json"), JSON.stringify({ schema: "feishu-bridge-config/v1", bundleVersion: "no-join", evidenceRoot: path.join(f.dir, "bridge-v2-view"), audio }), { mode: 0o600 });
  writeFileSync(path.join(f.dir, "bridge-no-audio.json"), JSON.stringify({ schema: "feishu-bridge-config/v1", bundleVersion: "clean", evidenceRoot: path.join(f.dir, "bridge-v2-clean") }), { mode: 0o600 });
  const v2Child = path.resolve("test/fixtures/bridge-v2-child.mjs");
  const config: StandaloneConfigV1 = { ...f.config, bridgeSlots: [
    { ...f.config.bridgeSlots[0]!, argv: [v2Child], staticConfigPath: path.join(f.dir, "bridge-hung.json") },
    { ...f.config.bridgeSlots[1]!, argv: [v2Child], staticConfigPath: path.join(f.dir, "bridge-clean.json") },
    { ...f.config.bridgeSlots[2]!, staticConfigPath: path.join(f.dir, "bridge-view.json") },
  ] };
  const owner = await acquireApplicationOwnerLock(f.stateRoot);
  const lock = lstatSync(path.join(f.stateRoot, "application.lock"), { bigint: true });
  const runtimes = scriptedRuntimes({ recordingsDir: f.config.dataPaths.recordingsDir });
  process.env.RUNTIME_SECRET = "synthetic-canary"; process.env.FEISHU_APP_SECRET = "synthetic-canary";
  let ids: string[] = [];
  try {
    // A v2 slot whose static file lacks the exact audio object is refused at composition, before any store or spawn.
    const missingAudio: StandaloneConfigV1 = { ...config, bridgeSlots: [{ ...config.bridgeSlots[1]!, staticConfigPath: path.join(f.dir, "bridge-no-audio.json") }] };
    await assert.rejects(composeApplication(missingAudio, owner, { inviteIngress: false, startRuntimeTransport: runtimes.factory, metadata: resolvedLookup(["900000001"]) }), /bridge_slot_invalid/);
    assert.equal(existsSync(f.databasePath), false);
    assert.equal(runtimes.owned.length, 0);
    ids = await admitted(f, 3);

    const app = await composeApplication(config, owner, { inviteIngress: false, startRuntimeTransport: runtimes.factory, metadata: resolvedLookup(["900000001"]), clock: { now: () => 10_000 } });
    await app.start();
    assert.equal((await app.discover()).launched, 3);
    await until(() => existsSync(path.join(f.dir, "bridge-v2-hung", "child.pid")) && existsSync(path.join(f.dir, "bridge-v2-clean", "child.pid")) && existsSync(path.join(f.dir, "bridge-v2-view", "child.json")), 8000);
    const bySlot = (bridgeId: string) => app.occurrenceOutcomes().find((outcome) => outcome.bridgeId === bridgeId)!;
    // The clean v2 child answers the timed join: the occurrence reaches listening with timed evidence bound to the connected control id.
    // The wait is the assertion below, exactly: `listening` alone lands before the ui_snapshot row is written.
    await until(() => { const store = f.reopen(); try {
      const clean = bySlot("bridge-2");
      if (store.getSession(clean.occurrenceId)?.state !== "listening" || clean.controlSessionId === null) return false;
      const custody = store.listPhysicalCustody().find((row) => row.physicalClientId === "mac-2");
      if (custody === undefined) return false;
      const binding = { occurrenceId: clean.occurrenceId, bridgeSessionId: custody.bridgeSessionId, runtimeSessionId: clean.controlSessionId };
      return store.getTimedEvidenceStatus(binding, 10_000)?.state === "active" && store.readTimedUi(binding, 0, 10_000).length >= 2;
    } finally { store.close(); } }, 8000);
    {
      const store = f.reopen();
      try {
        const clean = bySlot("bridge-2");
        const custody = store.listPhysicalCustody().find((row) => row.physicalClientId === "mac-2")!;
        const binding = { occurrenceId: clean.occurrenceId, bridgeSessionId: custody.bridgeSessionId, runtimeSessionId: clean.controlSessionId! };
        assert.equal(store.getTimedEvidenceStatus(binding, 10_000)?.state, "active");
        assert.ok(store.readTimedUi(binding, 0, 10_000).length >= 2, "joined and the ui_snapshot are retained under the connected control id");
        const launched = JSON.parse(readFileSync(path.join(f.dir, "bridge-v2-clean", "child.config.json"), "utf8")) as { schema: string; audio: unknown };
        assert.equal(launched.schema, "feishu-bridge-config/v3"); assert.deepEqual(launched.audio, audio);
      } finally { store.close(); }
    }
    const view = JSON.parse(readFileSync(path.join(f.dir, "bridge-v2-view", "child.json"), "utf8")) as { fds: Array<{ fd: number; file: boolean; dev: string; ino: string }>; env: string[] };
    assert.equal(view.fds.some((entry) => entry.dev === lock.dev.toString() && entry.ino === lock.ino.toString()), false, "the lock descriptor must not reach the child");
    assert.deepEqual(view.fds.filter((entry) => entry.file), [], "no regular file descriptor is inherited");
    // macOS injects __CF_USER_TEXT_ENCODING into every spawned process; it is not a Meeting value.
    assert.deepEqual(view.env.filter((key) => !RUNTIME_CHILD_ENVIRONMENT_ALLOWLIST.includes(key) && key !== "__CF_USER_TEXT_ENCODING"), [], "env is the explicit allowlist only");
    await app.close();
    for (const id of ids) assert.equal(app.occurrenceOutcomes().find((outcome) => outcome.occurrenceId === id)?.failure, null);
    const store = f.reopen();
    try {
      const rows = store.listPhysicalCustody();
      assert.equal(rows.find((row) => row.physicalClientId === "mac-1")?.state, "quarantined");
      assert.equal(rows.find((row) => row.physicalClientId === "mac-1")?.outcomeFailure, "cleanup_failed");
      assert.equal(rows.find((row) => row.physicalClientId === "mac-2")?.state, "quarantined", "departure_unconfirmed from the real child keeps custody");
      assert.equal(rows.find((row) => row.physicalClientId === "mac-2")?.outcome?.outcome, "departure_unconfirmed");
      assert.equal(rows.find((row) => row.physicalClientId === "mac-3")?.state, "cleared");
      assert.deepEqual([store.getSession(bySlot("bridge-2").occurrenceId)?.state, store.getSession(bySlot("bridge-2").occurrenceId)?.terminalReason], ["finalizing", null]);
    } finally { store.close(); }
    const hungPid = Number(readFileSync(path.join(f.dir, "bridge-v2-hung", "child.pid"), "utf8"));
    assert.throws(() => process.kill(hungPid, 0), { code: "ESRCH" }, "the hung child is reaped by owned cleanup");
  } finally {
    delete process.env.RUNTIME_SECRET; delete process.env.FEISHU_APP_SECRET;
    owner.close();
    f.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Runtime owner
// ---------------------------------------------------------------------------

test("the connected v4 control identity is awaited before spawn and join, and timed UI evidence binds to it", async () => {
  const f = fixture();
  const runtimes = scriptedRuntimes({ recordingsDir: f.config.dataPaths.recordingsDir });
  const order: string[] = [];
  const factory: NonNullable<ComposeApplicationOptions["startRuntimeTransport"]> = async (input) => { const transport = await runtimes.factory(input); order.push("runtime_started"); return transport; };
  const slot = scriptedSlot(1, { onLaunch: () => order.push("bridge_launch") });
  const [id] = await admitted(f, 1);
  try {
    const app = await composeFor(f, { startRuntimeTransport: factory, bridgeSlots: [slot], metadata: resolvedLookup(["900000001"]), clock: { now: () => 10_000 } });
    await app.start();
    assert.equal((await app.discover()).launched, 1);
    await until(() => slot.sent().some((command) => command.type === "connect_media"));
    const runtime = runtimes.owned[0]!;
    assert.deepEqual(order, ["runtime_started", "bridge_launch"]);
    assert.equal(runtime.commands().indexOf("status") >= 0, true);
    const binding = { occurrenceId: id!, bridgeSessionId: slot.launches[0]!.bridgeSessionId, runtimeSessionId: runtime.controlSessionId };
    const store = f.reopen();
    try {
      assert.equal(store.getTimedEvidenceStatus(binding, 10_000)?.state, "active", "timed evidence is bound to the connected control identity");
      assert.equal(store.readTimedUi(binding, 0, 10_000).length, 1, "the joined observation is retained under that binding");
    } finally { store.close(); }
    slot.left("removed");
    await app.awaitOccurrence(id!);
    await app.close();
  } finally { f.close(); }
});

test("a Runtime that never becomes ready within the launch budget is closed and the occurrence stays discovered without a spawn", async () => {
  const f = fixture();
  const runtimes = scriptedRuntimes({ recordingsDir: f.config.dataPaths.recordingsDir, holdReady: true });
  const slot = scriptedSlot(1);
  const [id] = await admitted(f, 1);
  try {
    const app = await composeFor(f, { startRuntimeTransport: runtimes.factory, bridgeSlots: [slot], metadata: resolvedLookup(["900000001"]), clock: { now: () => 10_000 }, runtimeStartupBudgetMs: 100 });
    await app.start();
    assert.equal((await app.discover()).launched, 1);
    const outcome = await app.awaitOccurrence(id!);
    assert.equal(outcome.failure, "runtime_startup_timeout");
    assert.equal(runtimes.owned[0]!.closes(), 1);
    assert.deepEqual(slot.launches, []);
    const store = f.reopen();
    try { assert.equal(store.getSession(id!)?.state, "discovered"); assert.deepEqual(store.listPhysicalCustody(), []); } finally { store.close(); }
    assert.equal((await app.discover()).launched, 1, "a row that never reached custody or spawn stays eligible for a later tick");
    assert.equal((await app.awaitOccurrence(id!)).failure, "runtime_startup_timeout");
    assert.equal(runtimes.owned.length, 2);
    await app.close();
  } finally { f.close(); }
});

test("a rejected timed start during join reaps the late child, closes the Runtime owner and persists the physical outcome before the store closes", async () => {
  const f = fixture();
  const log: string[] = [];
  const runtimes = scriptedRuntimes({ recordingsDir: f.config.dataPaths.recordingsDir, startMode: "reject" });
  const slot = scriptedSlot(1, { outcome: "departure_confirmed" });
  const [id] = await admitted(f, 1);
  try {
    const app = await composeFor(f, { log: (code) => log.push(code), startRuntimeTransport: runtimes.factory, bridgeSlots: [slot], metadata: resolvedLookup(["900000001"]), clock: { now: () => 10_000 } });
    await app.start();
    assert.equal((await app.discover()).launched, 1);
    const outcome = await app.awaitOccurrence(id!);
    assert.equal(outcome.failure, "join_failed");
    assert.equal(slot.shutdowns(), 1);
    assert.equal(runtimes.owned[0]!.closes(), 1);
    await app.close();
    assert.ok(log.indexOf("occurrence_runtime_closed") < log.indexOf("shutdown_store_closed"));
    const store = f.reopen();
    try {
      const row = store.listPhysicalCustody()[0]!;
      assert.equal(row.state, "cleared"); assert.notEqual(row.outcomeRecordedAtMs, null);
      assert.equal(store.getSession(id!)?.state, "failed");
      assert.equal(store.getRecording(id!), null, "no recording is invented for a never-admitted voice session");
    } finally { store.close(); }
  } finally { f.close(); }
});

test("a Runtime close rejection swallowed by the session is still visible as a static aggregate at application close", async () => {
  const f = fixture();
  const runtimes = scriptedRuntimes({ recordingsDir: f.config.dataPaths.recordingsDir, closeFails: true });
  const slot = scriptedSlot(1, { outcome: "departure_confirmed" });
  const [id] = await admitted(f, 1);
  try {
    const app = await composeFor(f, { startRuntimeTransport: runtimes.factory, bridgeSlots: [slot], metadata: resolvedLookup(["900000001"]), clock: { now: () => 10_000 } });
    await app.start();
    assert.equal((await app.discover()).launched, 1);
    await until(() => slot.sent().some((command) => command.type === "connect_media"));
    slot.left("removed");
    const outcome = await app.awaitOccurrence(id!);
    assert.equal(outcome.failure, null, "the session's own outcome is not replaced by the cleanup failure");
    assert.equal(outcome.runtimeClose, "failed");
    await assert.rejects(app.close(), /runtime_close_failed/);
    await assert.rejects(app.close(), /runtime_close_failed/, "repeated close reports the same static failure");
    assert.doesNotMatch(String(f.dir), /runtime_close_failed/);
  } finally { f.close(); }
});

test("actual gateway: the private launcher env is the allowlist, no provider or recording key reaches Meeting, and the offline gateway's refusal of the pinned online admission reaps the Runtime owner and the child", { timeout: 40_000 }, async () => {
  const binary = process.env.MEETING_TEST_RUNTIME_GATEWAY;
  assert.ok(binary && path.isAbsolute(binary), "Prebuild the immutable Runtime gateway and set MEETING_TEST_RUNTIME_GATEWAY; do not skip this proof");
  const f = fixture();
  const runtimeRoot = path.join(f.dir, "runtime");
  mkdirSync(runtimeRoot, { mode: 0o700 }); mkdirSync(path.join(runtimeRoot, "models"), { mode: 0o700 });
  const health = createServer((_request, response) => { response.end("{}"); });
  health.listen(0, "127.0.0.1"); await once(health, "listening");
  const address = health.address(); assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const errorPath = path.join(runtimeRoot, "runtime-startup.log");
  const script = `env | sed 's/=.*//' > ${quote(path.join(runtimeRoot, "launcher-env.txt"))}
${quote(process.execPath)} ${quote(path.resolve("test/fixtures/runtime-alignment-child.mjs"))} ${quote(path.join(runtimeRoot, "gateway.toml"))} || exit 2
IFS= read -r MEETING_TEST_RUNTIME_KEY < ${quote(path.join(runtimeRoot, "runtime-synthetic.key"))} || [ -n "$MEETING_TEST_RUNTIME_KEY" ] || exit 2
export MEETING_TEST_RUNTIME_KEY
printf '%s' "$$" > ${quote(path.join(runtimeRoot, "runtime-owned.pid"))}
exec ${quote(binary)} "$@"`;
  const gatewayConfigPath = path.join(runtimeRoot, "gateway.toml");
  const config: StandaloneConfigV1 = { ...f.config, runtime: { ...f.config.runtime, gatewayConfigPath } };
  writeFileSync(config.runtime.launcherPath, `#!/bin/sh\nexec /bin/sh -c ${quote(script)} gateway-exec "$@" 2>${quote(errorPath)}\n`, { mode: 0o700 });
  writeFileSync(gatewayConfigPath, gatewayToml(runtimeRoot, endpoint), { mode: 0o600 });
  const slot = scriptedSlot(1, { outcome: "departure_confirmed" });
  const [id] = await admitted(f, 1);
  process.env.OPENAI_API_KEY_CANARY = "synthetic-canary";
  let app: ComposedApplication | undefined;
  try {
    app = await composeApplication(config, f.owner, { inviteIngress: false, bridgeSlots: [slot], metadata: resolvedLookup(["900000001"]), clock: { now: () => 10_000 } });
    await app.start();
    assert.equal((await app.discover()).launched, 1);
    const settled = app.awaitOccurrence(id!);
    await Promise.race([settled, until(() => slot.sent().some((command) => command.type === "connect_media"), 25_000).catch(() => undefined)]);
    if (slot.sent().some((command) => command.type === "connect_media")) slot.left("removed");
    const outcome = await settled;
    const launcherEnv = readFileSync(path.join(runtimeRoot, "launcher-env.txt"), "utf8").split("\n").filter((line) => line.length > 0);
    assert.deepEqual(launcherEnv.filter((key) => !RUNTIME_CHILD_ENVIRONMENT_ALLOWLIST.includes(key) && key !== "__CF_USER_TEXT_ENCODING" && key !== "PWD" && key !== "SHLVL" && key !== "_"), []);
    assert.equal(process.env.MEETING_TEST_RUNTIME_KEY, undefined);
    assert.equal(outcome.controlSessionId !== null && outcome.controlSessionId > 0n, true, "the actual connected v4 control identity was awaited");
    assert.ok(outcome.failure === "join_failed" || outcome.failure === null, `admission outcome: ${String(outcome.failure)}`);
    assert.equal(outcome.runtimeClose, "closed");
    const pid = Number(readFileSync(path.join(runtimeRoot, "runtime-owned.pid"), "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.equal(slot.shutdowns(), 1);
    await app.close(); app = undefined;
    const store = f.reopen();
    try { assert.equal(store.listPhysicalCustody()[0]?.state, "cleared"); assert.equal(store.getSession(id!)?.state, "failed"); } finally { store.close(); }
  } catch (error) {
    const diagnostic = existsSync(errorPath) ? readFileSync(errorPath, "utf8").slice(0, 2000) : "";
    throw new Error(`${error instanceof Error ? error.message : String(error)}; gateway stderr: ${diagnostic.replaceAll(f.dir, "[dir]")}`);
  } finally {
    delete process.env.OPENAI_API_KEY_CANARY;
    if (app) await app.close().catch(() => {});
    health.closeAllConnections(); await new Promise<void>((resolve) => health.close(() => resolve()));
    f.close();
  }
});

function gatewayToml(runtimeRoot: string, endpoint: string): string {
  return `schema_version = 3
profile = "offline"
privacy_mode = "local-only"
[language]
backend = "ollama-compatible"
execution = "local"
provider = "fixture-language"
provider_host = "fixture"
endpoint = "${endpoint}"
model = "synthetic"
thinking = false
temperature = 0.0
seed = 1
num_predict = 128
num_ctx = 1024
max_assistant_content_bytes = 65536
[persona]
mode = "direct-answer"
warmth = 50
humor = 50
teasing = 50
initiative = 50
directness = 50
intimacy = 50
verbosity = 50
follow_up_frequency = 50
[[provider_hosts]]
id = "fixture"
ownership = "external"
readiness_url = "${endpoint}/health"
startup_timeout_ms = 5000
environment = "inherit"
[voice.capture]
device = "system-default"
[voice.turn]
speech_start_ms = 200
final_silence_ms = 600
[voice.asr]
backend = "whisperkit"
execution = "local"
provider = "fixture-asr"
model_path = "${runtimeRoot}/models"
download = false
[voice.speech]
backend = "openai-compatible"
execution = "local"
provider = "fixture-speech"
provider_host = "fixture"
mode = "buffered"
endpoint = "${endpoint}/v1"
model = "fixture"
voice = "fixture"
speed = 1.0
language = "auto"
instructions = "fixture"
max_tokens = 128
repetition_penalty = 1.0
max_text_bytes = 4096
max_audio_bytes = 8388608
[voice.audio]
backend = "managed-sidecar"
execution = "local"
provider = "fixture-audio"
sidecar_executable = "/bin/sh"
max_error_bytes = 65536
[recording]
directory = "${runtimeRoot}/recordings"
key_env = "MEETING_TEST_RUNTIME_KEY"
[media]
bind = "127.0.0.1:0"
advertised_endpoint = "tcp://127.0.0.1:0"
credential_lifetime_ms = 60000
reconnect_window_ms = 10000
max_frames_per_second = 100
max_payload_bytes = 16384
max_outbound_queue_bytes = 262144
max_outbound_queue_ms = 10000
capture_format = "pcm_s16le/24000/1/20ms"
`;
}

// ---------------------------------------------------------------------------
// 5. Observed end → seed
// ---------------------------------------------------------------------------

async function liveOccurrence(f: Fixture, script: Partial<RuntimeScript> = {}, slotScript: SlotScript = {}, clockMs = 10_000) {
  const runtimes = scriptedRuntimes({ recordingsDir: f.config.dataPaths.recordingsDir, ...script });
  const slot = scriptedSlot(1, { outcome: "departure_confirmed", ...slotScript });
  const [id] = await admitted(f, 1);
  const app = await composeFor(f, { startRuntimeTransport: runtimes.factory, bridgeSlots: [slot], metadata: resolvedLookup(["900000001"]), clock: { now: () => clockMs } });
  await app.start();
  assert.equal((await app.discover()).launched, 1);
  await until(() => slot.sent().some((command) => command.type === "connect_media"));
  return { app, slot, runtimes, id: id! };
}

test("a positively observed meeting-ended notice yields endedAt and the immutable seed; stop is awaited before finalize", async () => {
  const f = fixture();
  try {
    const { app, slot, runtimes, id } = await liveOccurrence(f);
    slot.left("ended");
    const outcome = await app.awaitOccurrence(id);
    assert.equal(outcome.failure, null);
    const runtime = runtimes.owned[0]!;
    const commands = runtime.commands();
    assert.ok(commands.indexOf("stop_voice_session") >= 0 && commands.indexOf("stop_voice_session") < commands.indexOf("finalize_recording"), "the existing SDK stop is awaited before finalize");
    assert.equal(commands.filter((type) => type === "stop_voice_session").length, 1);
    const store = f.reopen();
    try {
      const seed = store.getBackfillSeed(id);
      assert.ok(seed);
      assert.equal(seed.endedAt, OBSERVED_AT);
      assert.equal(seed.recordingPath, runtime.recordingPath);
      assert.equal(seed.capability.recordingHandle, runtime.handle);
      assert.deepEqual(seed.organizer, { feishuUserId: "ou_creator", displayName: "Creator", source: "reservation" });
      assert.equal(seed.provenance.runtimeProfile, "online");
      assert.equal(seed.provenance.sttProvider, "scripted-stt"); assert.equal(seed.provenance.textModel, "scripted-text-model");
      assert.equal(store.getSession(id)?.state, "finalizing");
      assert.equal(store.getUnknownEndCustody({ kind: "final", occurrenceId: id }), null);
    } finally { store.close(); }
    await app.close();
  } finally { f.close(); }
});

test("only the routed terminal means already-ended; a stop rejection (even in the SDK's own wording) and a finalize failure never invent an end, a recording or a seed", async () => {
  for (const variant of ["already_ended", "terminal_then_reject", "reject_stop", "reject_as_inactive", "reject_finalize"] as const) {
    const f = fixture();
    try {
      const { app, slot, runtimes, id } = await liveOccurrence(f, variant === "already_ended" ? { stopMode: "already_ended" }
        : variant === "terminal_then_reject" ? { stopMode: "terminal_then_reject" }
        : variant === "reject_stop" ? { stopMode: "reject" } : variant === "reject_as_inactive" ? { stopMode: "reject_as_inactive" } : { finalizeMode: "reject" });
      slot.left("ended");
      const outcome = await app.awaitOccurrence(id);
      const commands = runtimes.owned[0]!.commands();
      const store = f.reopen();
      try {
        if (variant === "already_ended") {
          assert.equal(commands.includes("stop_voice_session"), false, "no stop is asked of a session the gateway already ended");
          assert.ok(store.getBackfillSeed(id), "the terminal acknowledgement already arrived, so finalize proceeds");
        } else if (variant === "terminal_then_reject") {
          assert.equal(commands.filter((type) => type === "stop_voice_session").length, 1, "stop asked once");
          assert.equal(commands.includes("finalize_recording"), true, "a correlated rejection after this handle's routed terminal is already_terminal, so finalize proceeds");
          assert.ok(store.getBackfillSeed(id), "already_terminal seeds the observed end");
          assert.equal(outcome.finalization, "seeded");
        } else {
          assert.equal(store.getBackfillSeed(id), null);
          assert.equal(store.getRecording(id), null);
          assert.equal(outcome.finalization, variant === "reject_finalize" ? "finalize_failed" : "stop_failed", variant);
          if (variant !== "reject_finalize") assert.equal(commands.includes("finalize_recording"), false, `${variant}: no finalize after a rejected stop`);
          assert.equal(commands.filter((type) => type === "stop_voice_session").length, 1, `${variant}: stop asked once`);
          assert.equal(store.getSession(id)?.state, "finalizing", "the terminal transition is still applied without a fabricated recording");
        }
      } finally { store.close(); }
      await app.close();
    } finally { f.close(); }
  }
});

test("early leave, removal and an unreadable client yield no seed; an unknown-end stop goes through assignUnknownEndCustody with the real descriptor", async () => {
  {
    const f = fixture();
    try {
      // Early leave: the bridge leaves before voice admission → no recording at all.
      const runtimes = scriptedRuntimes({ recordingsDir: f.config.dataPaths.recordingsDir });
      const slot = scriptedSlot(1, { outcome: "departure_confirmed", joinMode: "leave" });
      const [id] = await admitted(f, 1);
      const app = await composeFor(f, { startRuntimeTransport: runtimes.factory, bridgeSlots: [slot], metadata: resolvedLookup(["900000001"]), clock: { now: () => 10_000 } });
      await app.start();
      assert.equal((await app.discover()).launched, 1);
      const outcome = await app.awaitOccurrence(id!);
      assert.equal(outcome.failure, "join_cancelled");
      const store = f.reopen();
      try { assert.equal(store.getRecording(id!), null); assert.equal(store.getBackfillSeed(id!), null); assert.equal(store.getSession(id!)?.state, "failed"); } finally { store.close(); }
      assert.equal(runtimes.owned[0]!.commands().includes("finalize_recording"), false);
      await app.close();
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      // Shutdown mid-meeting: local-clock terminal, recording finalized, no seed, explicit custody.
      const { app, runtimes, id } = await liveOccurrence(f, {}, {}, 50_000);
      await app.close();
      const outcome = app.occurrenceOutcomes().find((value) => value.occurrenceId === id)!;
      assert.equal(outcome.custody, "assigned");
      const store = f.reopen();
      try {
        assert.equal(store.getBackfillSeed(id), null);
        const custody = store.getUnknownEndCustody({ kind: "final", occurrenceId: id });
        assert.ok(custody);
        assert.equal(custody.recordingHandle, runtimes.owned[0]!.handle);
        assert.equal(custody.recordingPath, runtimes.owned[0]!.recordingPath);
        assert.equal(custody.detectedAtMs, 50_000);
        assert.equal(custody.deadlineMs, 50_000 + 14 * 24 * 60 * 60 * 1000);
        // A listening session disposed at shutdown advances to finalizing on the local clock; nothing calls it an end.
        assert.equal(store.getSession(id)?.state, "finalizing");
        assert.equal(store.getSession(id)?.terminalReason, null);
      } finally { store.close(); }
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      // Removal observed by the bridge before the client ever reported joined:
      // the session fails with terminal_reason removed, the stopped recording
      // is persisted, no seed and no endedAt exist, and the composition
      // classifies the exact source explicitly.
      const { app, slot, runtimes, id } = await liveOccurrence(f, {}, { joinMode: "silent" }, 70_000);
      slot.left("removed");
      const outcome = await app.awaitOccurrence(id);
      assert.equal(outcome.custody, "assigned");
      assert.equal(outcome.finalization, "recorded");
      const store = f.reopen();
      try {
        assert.equal(store.getBackfillSeed(id), null);
        assert.equal(store.getRecording(id)?.handle, runtimes.owned[0]!.handle);
        assert.deepEqual([store.getSession(id)?.state, store.getSession(id)?.terminalReason], ["failed", "removed"]);
        const custody = store.getUnknownEndCustody({ kind: "final", occurrenceId: id });
        assert.equal(custody?.detectedAtMs, 70_000);
        assert.equal(custody?.recordingPath, runtimes.owned[0]!.recordingPath);
      } finally { store.close(); }
      await app.close();
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      // Removal observed by the bridge while listening: the accepted session
      // advances a listening occurrence to finalizing (terminal_reason null),
      // the generation persists the observed left reason (D027), and custody
      // refuses only an observed `ended`; a removed stop is classified with
      // the real descriptor. No seed, no endedAt, the recording row exists.
      const { app, slot, runtimes, id } = await liveOccurrence(f, {}, {}, 80_000);
      slot.emit({ type: "ui_snapshot", snapshotSequence: 1, state: "unreadable", feishuUserId: null, reason: "snapshot_unreadable", barrierBefore: null, observationTiming: null });
      slot.left("removed");
      const outcome = await app.awaitOccurrence(id);
      assert.equal(outcome.custody, "assigned");
      const store = f.reopen();
      try {
        assert.equal(store.getBackfillSeed(id), null); assert.ok(store.getRecording(id));
        assert.deepEqual([store.getSession(id)?.state, store.getSession(id)?.terminalReason], ["finalizing", null]);
        const custody = store.getUnknownEndCustody({ kind: "final", occurrenceId: id });
        assert.equal(custody?.detectedAtMs, 80_000);
        assert.equal(custody?.recordingHandle, runtimes.owned[0]!.handle);
      } finally { store.close(); }
      await app.close();
    } finally { f.close(); }
  }
});

test("a crash before the seed transaction commits leaves no seed, recording or end; after it, reopen proves exactly one seed", async () => {
  {
    const f = fixture();
    try {
      const { app, slot, id } = await liveOccurrence(f);
      f.raw((db) => db.exec("CREATE TRIGGER crash_before_seed BEFORE INSERT ON backfill_seeds BEGIN SELECT RAISE(ABORT,'synthetic crash'); END"));
      slot.left("ended");
      const outcome = await app.awaitOccurrence(id);
      assert.equal(outcome.finalization, "transaction_failed");
      const store = f.reopen();
      try {
        assert.equal(store.getBackfillSeed(id), null); assert.equal(store.getRecording(id), null);
        assert.equal(store.getSession(id)?.state, "listening", "the atomic transaction rolled back the terminal transition too");
        assert.equal(store.getUnknownEndCustody({ kind: "final", occurrenceId: id }), null);
      } finally { store.close(); }
      await app.close();
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      const { app, slot, id } = await liveOccurrence(f);
      slot.left("ended");
      await app.awaitOccurrence(id);
      await app.close();
      const reopened = await composeFor(f, { startRuntimeTransport: scriptedRuntimes({ recordingsDir: f.config.dataPaths.recordingsDir }).factory, bridgeSlots: [scriptedSlot(1)], metadata: resolvedLookup(["900000001"]), clock: { now: () => 60_000 } });
      await reopened.start();
      assert.equal((await reopened.discover()).launched, 0);
      await reopened.close();
      const store = f.reopen();
      try {
        assert.ok(store.getBackfillSeed(id));
        assert.equal(f.raw((db) => (db.prepare("SELECT count(*) AS n FROM backfill_seeds").get() as { n: number }).n), 1);
        assert.equal(f.raw((db) => (db.prepare("SELECT count(*) AS n FROM delivery_journal").get() as { n: number }).n), 0, "no artifact is invented");
      } finally { store.close(); }
    } finally { f.close(); }
  }
});

// ---------------------------------------------------------------------------
// 6. Isolation
// ---------------------------------------------------------------------------

for (const count of [1, 2, 4, 8]) {
  test(`${count} interleaved occurrences keep identity, the name gate and independent progress; the excess is refused durably and one failed bridge disturbs nobody`, async () => {
    const f = fixture(count);
    const runtimes = scriptedRuntimes({ recordingsDir: f.config.dataPaths.recordingsDir });
    const slots = Array.from({ length: count }, (_, index) => scriptedSlot(index + 1, { outcome: "departure_confirmed" }));
    const ids = await admitted(f, count + 1);
    const log: string[] = [];
    try {
      const app = await composeFor(f, { log: (code) => log.push(code), startRuntimeTransport: runtimes.factory, bridgeSlots: slots, metadata: resolvedLookup(["900000001"]), clock: { now: () => 10_000 } });
      await app.start();
      const tick = await app.discover();
      assert.equal(tick.launched, count); assert.equal(tick.deferred, 1);
      await until(() => slots.every((slot) => slot.sent().some((command) => command.type === "connect_media")), 5000).catch((error: unknown) => {
        throw new Error(`${String(error)}; log=${log.join(",")}; outcomes=${JSON.stringify(app.occurrenceOutcomes(), (_k, v) => typeof v === "bigint" ? String(v) : v)}; sent=${JSON.stringify(slots.map((slot) => slot.sent().map((c) => c.type)))}`);
      });
      assert.equal(app.liveOccurrenceIds().length, count);
      const bySlot = slots.map((slot) => ({ slot, occurrenceId: slot.launches[0]!.occurrenceId,
        runtime: runtimes.owned.find((runtime) => runtime.commands().length > 0 && app.occurrenceOutcomes().find((o) => o.occurrenceId === slot.launches[0]!.occurrenceId)?.controlSessionId === runtime.controlSessionId)! }));
      assert.equal(new Set(bySlot.map((entry) => entry.runtime.controlSessionId)).size, count, "each occurrence binds its own control identity");
      // Interleave: name gate per occurrence. Only the first is addressed.
      bySlot.forEach((entry, index) => {
        entry.runtime.deliver({ type: "voice_transcript_final", session_id: entry.runtime.controlSessionId.toString(), segment_id: String(9000 + index), turn_id: null,
          text: index === 0 ? "Meetbot, please summarize" : "background talk", capture_unavailable_reason: "provider_offsets_unavailable" });
      });
      await until(() => bySlot.every((entry) => entry.runtime.commands().some((type) => type === (bySlot.indexOf(entry) === 0 ? "authorize_voice_response" : "skip_voice_response"))), 5000).catch((error: unknown) => {
        throw new Error(`${String(error)}; commands=${JSON.stringify(bySlot.map((entry) => entry.runtime.transport.commands), (_k, v) => typeof v === "bigint" ? String(v) : v)}`);
      });
      for (const [index, entry] of bySlot.entries()) {
        assert.equal(entry.runtime.commands().includes("authorize_voice_response"), index === 0, `occurrence ${index} authorization`);
        assert.equal(entry.runtime.commands().includes("skip_voice_response"), index !== 0, `occurrence ${index} silence`);
      }
      // One failed bridge (the last), the rest end positively.
      const failing = bySlot[bySlot.length - 1]!;
      failing.slot.left("bridge_failure");
      await app.awaitOccurrence(failing.occurrenceId);
      for (const entry of bySlot.slice(0, -1)) assert.ok(app.liveOccurrenceIds().includes(entry.occurrenceId), "a failed bridge cannot cancel the others");
      const second = await app.discover();
      assert.equal(second.launched, count > 0 ? 1 : 0, "the deferred occurrence takes the freed slot");
      for (const entry of bySlot.slice(0, -1)) { entry.slot.left("ended"); await app.awaitOccurrence(entry.occurrenceId); }
      const store = f.reopen();
      try {
        for (const entry of bySlot.slice(0, -1)) {
          const seed = store.getBackfillSeed(entry.occurrenceId);
          assert.ok(seed); assert.equal(seed.capability.recordingHandle, entry.runtime.handle);
          assert.equal(seed.capability.sourceSessionId, entry.runtime.controlSessionId);
        }
        assert.equal(store.getSession(failing.occurrenceId)?.state, "listening", "a bridge_failure generation keeps the occurrence recoverable");
        const excess = ids[count]!;
        assert.equal(app.liveOccurrenceIds().includes(excess), true);
      } finally { store.close(); }
      await app.close();
    } finally { f.close(); }
  });
}
