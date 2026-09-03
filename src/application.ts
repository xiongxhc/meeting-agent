// Supported composition boundary for the public control plane. Deployment
// overlays supply concrete bridge and runtime adapters; this package owns only
// their safe orchestration and never contacts a provider itself.

import { mkdirSync } from "node:fs";
import path from "node:path";

import { openSessionStore } from "./adapters/sqlite-session-store.ts";
import type { MeetingAgentConfig } from "./config.ts";
import type { MeetingIdentity } from "./domain/meeting.ts";
import type { BridgeTransport } from "./ports/bridge.ts";
import type { ConversationRuntimePort } from "./ports/conversation-runtime.ts";
import type { SessionStore } from "./ports/session-store.ts";
import { createCoordinator, type Clock, type SessionCoordinator } from "./sessions/coordinator.ts";
import { createMeetingSession, type MeetingSession } from "./sessions/meeting-session.ts";

// Keep the original public configuration surface available from the package
// root while adding composition. Existing deployment overlays import these
// names from `meeting-agent`, not from an implementation file.
export { ConfigError, RedactedSecret, describeConfig, loadConfig, type MeetingAgentConfig } from "./config.ts";

export type MeetingAgentCompositionAdapters = {
  bridgeFor(identity: MeetingIdentity): {
    readonly bridge: BridgeTransport;
    readonly bridgeId: string;
    readonly bridgeSessionId: string;
  };
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
  createSession(identity: MeetingIdentity): MeetingSession;
  liveSessionCount(): number;
  close(): Promise<void>;
};

export function createMeetingAgentApplication(
  options: CreateMeetingAgentApplicationOptions,
): MeetingAgentApplication {
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
  let closed = false;
  let closePromise: Promise<void> | null = null;

  return {
    coordinator,
    createSession(identity: MeetingIdentity): MeetingSession {
      if (closed) throw new Error("meeting-agent application is closed");
      if (coordinator.get(identity.occurrenceId) === null) coordinator.discover(identity);
      const bridge = options.adapters.bridgeFor(identity);
      const sessionOptions = {
        identity,
        bridge: bridge.bridge,
        runtime: options.adapters.runtimeFor(identity),
        coordinator,
        clock,
        agentIdentity: options.config.agentIdentity,
        bridgeId: bridge.bridgeId,
        bridgeSessionId: bridge.bridgeSessionId,
        disclosureText: "A meeting agent is listening and will create meeting notes.",
        teamVaultDir: options.config.dataPaths.teamVaultDir,
      };
      const tracked: { session?: MeetingSession } = {};
      const lifecycleOptions = {
        ...sessionOptions,
        onInactive: () => {
          if (tracked.session !== undefined) sessions.delete(tracked.session);
        },
      };
      const session = createMeetingSession(options.bridgeFailureRetryLimit === undefined
        ? lifecycleOptions
        : { ...lifecycleOptions, bridgeFailureRetryLimit: options.bridgeFailureRetryLimit });
      tracked.session = session;
      sessions.add(session);
      return session;
    },
    liveSessionCount(): number {
      return sessions.size;
    },
    close(): Promise<void> {
      if (closePromise !== null) return closePromise;
      if (closed) return Promise.resolve();
      closed = true;
      closePromise = (async () => {
        await Promise.all([...sessions].map((session) => session.dispose()));
        sessions.clear();
        if (ownsStore) store.close();
      })();
      return closePromise;
    },
  };
}
