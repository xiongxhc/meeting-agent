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
  readonly store?: SessionStore;
};

export type MeetingAgentApplication = {
  readonly coordinator: SessionCoordinator;
  createSession(identity: MeetingIdentity): MeetingSession;
  close(): void;
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

  return {
    coordinator,
    createSession(identity: MeetingIdentity): MeetingSession {
      if (coordinator.get(identity.occurrenceId) === null) coordinator.discover(identity);
      const bridge = options.adapters.bridgeFor(identity);
      return createMeetingSession({
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
      });
    },
    close(): void {
      if (ownsStore) store.close();
    },
  };
}
