// Supported composition boundary for the public control plane. Deployment
// overlays supply concrete bridge and runtime adapters; this package owns only
// their safe orchestration and never contacts a provider itself.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { openSessionStore } from "./adapters/sqlite-session-store.ts";
import { validateBridgeSlots, type MeetingAgentConfig } from "./config.ts";
import type { MeetingIdentity } from "./domain/meeting.ts";
import type { BridgeProcessSlot, OwnedBridgeProcess, BridgeShutdownResult } from "./ports/bridge-process.ts";
import { validateCustodyBinding, type CustodyBinding } from "./contracts/bridge-process-outcome-v1.ts";
import type { ConversationRuntimePort } from "./ports/conversation-runtime.ts";
import type { SessionStore } from "./ports/session-store.ts";
import { createCoordinator, type Clock, type SessionCoordinator } from "./sessions/coordinator.ts";
import { createMeetingSession, type MeetingSession } from "./sessions/meeting-session.ts";

// Keep the original public configuration surface available from the package
// root while adding composition. Existing deployment overlays import these
// names from `meeting-agent`, not from an implementation file.
export { ConfigError, RedactedSecret, describeConfig, loadConfig, type MeetingAgentConfig } from "./config.ts";
export { createChildBridgeSlot, type ChildBridgeOptions } from "./adapters/child-bridge-process.ts";
export { createFeishuInviteIngress } from "./adapters/feishu-invite-ingress.ts";
export { createFeishuOrganizerMetadata } from "./adapters/feishu-organizer-metadata.ts";
export { createFeishuSdkHttp } from "./adapters/feishu-sdk-http.ts";
export { createInviteDiscovery } from "./sessions/invite-discovery.ts";
export { createConversationRuntimeClient, connectPostmeetingRuntime, type ConversationRuntimeSdk } from "./adapters/conversation-runtime-client.ts";
export { RecordingAlignmentOwner } from "./sessions/recording-alignment.ts";
export { openSessionStore, type OpenSessionStoreOptions } from "./adapters/sqlite-session-store.ts";
export type { RecordingRecovery, SelectedAlignment, AlignmentAttempt } from "./ports/session-store.ts";
export type { FeishuScope, NormalizedInvite, InviteOccurrence } from "./ports/feishu-ingress.ts";
export type { OrganizerReferenceEntry, OrganizerResolution } from "./ports/feishu.ts";
export type { BridgeProcessSlot, OwnedBridgeProcess, BridgeShutdownResult } from "./ports/bridge-process.ts";

export type MeetingAgentCompositionAdapters = {
  readonly bridgeSlots: readonly BridgeProcessSlot[];
  /** Pure selection only: may not spawn, send, or construct a live transport. */
  bridgeIdFor(identity: MeetingIdentity): string;
  runtimeFor(identity: MeetingIdentity): ConversationRuntimePort;
};

export type CreateMeetingAgentApplicationOptions = {
  readonly config: MeetingAgentConfig;
  readonly adapters: MeetingAgentCompositionAdapters;
  readonly clock?: Clock;
  readonly bridgeLeaseTtlMs?: number;
  readonly maxConcurrentSessions?: number;
  readonly bridgeFailureRetryLimit?: number;
  readonly store?: SessionStore;
};

export type MeetingAgentApplication = {
  readonly coordinator: SessionCoordinator;
  createSession(identity: MeetingIdentity): Promise<MeetingSession>;
  liveSessionCount(): number;
  close(): Promise<void>;
};

export function createMeetingAgentApplication(
  options: CreateMeetingAgentApplicationOptions,
): MeetingAgentApplication {
  validateBridgeSlots(options.adapters.bridgeSlots);
  const slots = new Map(options.adapters.bridgeSlots.map((slot) => [slot.bridgeId, slot]));
  const ownsStore = options.store === undefined;
  if (ownsStore) mkdirSync(options.config.dataPaths.outboxDir, { recursive: true });
  const store =
    options.store ??
    openSessionStore({ filename: path.join(options.config.dataPaths.outboxDir, "orchestration.db") });
  const clock = options.clock ?? { now: () => Date.now() };
  const coordinator = createCoordinator({
    store,
    clock,
    bridgeLeaseTtlMs: options.bridgeLeaseTtlMs ?? 30_000,
    maxConcurrentSessions: options.maxConcurrentSessions ?? 1,
  });
  const sessions = new Set<MeetingSession>();
  type Ownership = { binding: CustodyBinding; child?: OwnedBridgeProcess; creation?: Promise<MeetingSession>; cleanup?: Promise<void> };
  const owners = new Set<Ownership>();
  const cleanups = new Set<Promise<void>>();
  let cleanupFailed = false;
  let closed = false;
  let closePromise: Promise<void> | null = null;

  function cleanup(owner: Ownership): Promise<void> {
    if (owner.cleanup) return owner.cleanup;
    const operation = (async () => {
      let result: BridgeShutdownResult;
      try { result = owner.child ? await owner.child.shutdown() : { reaped: false, exitDiagnostic: null, outcome: null, failure: "launch_failed" }; }
      catch { result = { reaped: false, exitDiagnostic: null, outcome: null, failure: "cleanup_failed" }; }
      try { store.recordPhysicalOutcome(owner.binding, result, clock.now()); }
      catch { cleanupFailed = true; }
      if (!result.reaped) cleanupFailed = true;
      owners.delete(owner);
    })();
    owner.cleanup = operation;
    cleanups.add(operation);
    void operation.then(() => cleanups.delete(operation));
    return operation;
  }

  return {
    coordinator,
    async createSession(identity: MeetingIdentity): Promise<MeetingSession> {
      if (closed) return Promise.reject(new Error("meeting-agent application is closed"));
      const slot = slots.get(options.adapters.bridgeIdFor(identity));
      if (!slot) return Promise.reject(new Error("physical_client_slot_unknown"));
      const binding = validateCustodyBinding({ physicalClientId: slot.physicalClientId, physicalGenerationId: randomBytes(16).toString("hex"), occurrenceId: identity.occurrenceId, bridgeSessionId: randomBytes(16).toString("hex") });
      try { store.claimPhysicalClient(binding, clock.now()); }
      catch (error) { return Promise.reject(error); }
      const owner: Ownership = { binding };
      owners.add(owner);
      const creation = (async () => {
        try {
          if (coordinator.get(identity.occurrenceId) === null) coordinator.discover(identity);
          owner.child = await slot.launch(binding);
          if (closed) throw new Error("meeting-agent application is closed");
          const sessionOptions = {
            identity,
            bridge: owner.child.bridge,
            runtime: options.adapters.runtimeFor(identity),
            coordinator,
            clock,
            agentIdentity: options.config.agentIdentity,
            bridgeId: slot.bridgeId,
            bridgeSessionId: binding.bridgeSessionId,
            disclosureText: "A meeting agent is listening and will create meeting notes.",
            teamVaultDir: options.config.dataPaths.teamVaultDir,
          };
          const tracked: { session?: MeetingSession } = {};
          const lifecycleOptions = {
            ...sessionOptions,
            onInactive: () => {
              if (tracked.session !== undefined) sessions.delete(tracked.session);
              void cleanup(owner);
            },
          };
          const session = createMeetingSession(options.bridgeFailureRetryLimit === undefined
            ? lifecycleOptions
            : { ...lifecycleOptions, bridgeFailureRetryLimit: options.bridgeFailureRetryLimit });
          tracked.session = session;
          sessions.add(session);
          return session;
        } catch (error) { await cleanup(owner); throw error; }
      })();
      owner.creation = creation;
      return creation;
    },
    liveSessionCount(): number {
      return sessions.size;
    },
    close(): Promise<void> {
      if (closePromise !== null) return closePromise;
      if (closed) return Promise.resolve();
      closed = true;
      closePromise = (async () => {
        const pending = [...owners];
        for (const owner of pending) if (owner.child) void cleanup(owner);
        const disposal = Promise.allSettled([...sessions].map((session) => session.dispose()));
        await Promise.allSettled(pending.map((owner) => owner.creation));
        const disposed = await disposal;
        await Promise.all([...cleanups]);
        sessions.clear();
        if (ownsStore) store.close();
        if (cleanupFailed || disposed.some((result) => result.status === "rejected")) throw new Error("bridge_cleanup_unconfirmed");
      })();
      return closePromise;
    },
  };
}
