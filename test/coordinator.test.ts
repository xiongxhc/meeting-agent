// Orchestration state: the durable, per-occurrence session lifecycle, its
// bridge leases, and the concurrency semaphore that bounds how many
// occurrences run at once.
//
// What this suite exists to prove:
//   1. Restart safety. A process that dies between ANY two states resumes
//      from the persisted row, not from memory. Every boundary is
//      exercised, not just the interesting-looking ones.
//   2. Isolation. Occurrence A's activity never reads or mutates occurrence
//      B's rows -- proved with a full row-level snapshot of B taken before a
//      long burst of A activity (including a rolled-back failure) and
//      compared after, not by "two ids were used and nothing blew up".
//   3. Atomicity. A transition and its audit record commit together --
//      proved by making the audit-record write fail after the state write
//      would already have landed if they were not one transaction.
//   4. Determinism. Lease expiry is driven by an injected clock, never by
//      sleeping. No test in this file waits on wall-clock time.
//
// Every database lives in a fresh temp directory and is removed afterwards.
// Nothing here touches a live TeamMem installation.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildMeetingIdentity, type MeetingIdentity } from "../src/domain/meeting.ts";
import { occurrencePathSegment } from "../src/domain/occurrence-id.ts";
import {
  OrchestrationError,
  openSessionStore,
  type LeaseRow,
  type SessionRow,
  type SessionState,
  type SessionStore,
  type TransitionRow,
} from "../src/adapters/sqlite-session-store.ts";
import {
  ALLOWED_TRANSITIONS,
  HAPPY_PATH_STATES,
  SESSION_STATES,
  TERMINAL_STATES,
  createCoordinator,
  type Clock,
  type SessionCoordinator,
} from "../src/sessions/coordinator.ts";

const BASE_MS = 1_700_000_000_000;
const LEASE_TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Harness = {
  open(nowMs?: number): SessionStore;
  cleanup(): void;
};

function harness(): Harness {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-agent-orchestration-"));
  const dbPath = path.join(dir, "orchestration.db");
  return {
    open(nowMs = BASE_MS) {
      return openSessionStore({ filename: dbPath, nowMs });
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

type TestClock = Clock & { advance(ms: number): void };

function fakeClock(startMs = BASE_MS): TestClock {
  let now = startMs;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

function coordinatorFor(store: SessionStore, clock: Clock, maxConcurrentSessions = 4): SessionCoordinator {
  return createCoordinator({ store, clock, bridgeLeaseTtlMs: LEASE_TTL_MS, maxConcurrentSessions });
}

/** Synthetic, obviously fake occurrence identity. */
function identity(seq: number, startedAt = "2026-09-02T14:00:00Z"): MeetingIdentity {
  return buildMeetingIdentity({
    providerMeetingId: `fake-meeting-${String(seq).padStart(3, "0")}`,
    meetingNo: "000000000",
    occurrenceStartedAt: startedAt,
    title: "Fake Occurrence",
    organizer: null,
  });
}

function isOrchestrationError(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof OrchestrationError && error.code === code;
}

/** Every durable row that belongs to one occurrence, in a comparable shape. */
type OccurrenceSnapshot = {
  readonly session: SessionRow | null;
  readonly transitions: readonly TransitionRow[];
  readonly leases: readonly LeaseRow[];
};

function snapshot(store: SessionStore, occurrenceId: string): OccurrenceSnapshot {
  return {
    session: store.getSession(occurrenceId),
    transitions: store.listTransitions(occurrenceId),
    leases: store.listLeases(occurrenceId),
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Drains the microtask/immediate queue. Not a sleep: no timer duration is
 * involved, so this never depends on wall-clock timing. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Walks the happy path far enough to sit in `target`. Only used for states
 * on the linear path; "failed" is reached via fail() by the test itself. */
function driveTo(coordinator: SessionCoordinator, occurrenceId: string, target: SessionState): void {
  if (target === "discovered") return;
  for (const next of HAPPY_PATH_STATES) {
    coordinator.advance(occurrenceId, next);
    if (next === target) return;
  }
  throw new Error(`cannot drive to ${target}`);
}

// ---------------------------------------------------------------------------
// Migration and schema
// ---------------------------------------------------------------------------

test("the migration applies, reports schema version 1, and passes foreign_key_check", () => {
  const h = harness();
  try {
    const store = h.open();
    try {
      assert.equal(store.schemaVersion, 1);
      assert.deepEqual(store.appliedMigrations(), [
        { version: 1, name: "001_orchestration.sql", appliedAtMs: BASE_MS },
      ]);
      assert.equal(store.foreignKeysEnabled(), true);
      assert.deepEqual(store.foreignKeyCheck(), []);
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("reopening an existing database does not re-apply the migration", () => {
  const h = harness();
  try {
    const id = identity(1);
    const first = h.open(BASE_MS);
    const created = first.createSession({
      occurrenceId: id.occurrenceId,
      occurrenceSegment: occurrencePathSegment(id.occurrenceId),
      providerMeetingId: id.providerMeetingId,
      occurrenceStartedAt: id.occurrenceStartedAt,
      nowMs: BASE_MS,
    });
    first.close();

    const second = h.open(BASE_MS + 999_999);
    try {
      assert.equal(second.schemaVersion, 1);
      // applied_at is the FIRST application's stamp, proving the migration
      // did not run a second time.
      assert.deepEqual(second.appliedMigrations(), [
        { version: 1, name: "001_orchestration.sql", appliedAtMs: BASE_MS },
      ]);
      assert.deepEqual(second.getSession(created.occurrenceId), created);
    } finally {
      second.close();
    }
  } finally {
    h.cleanup();
  }
});

test("the control database is structurally incapable of holding transcript text or audio", () => {
  const h = harness();
  try {
    const store = h.open();
    try {
      const schema = store.describeSchema();
      assert.ok(schema.length >= 4, "expected the orchestration schema to define its tables");

      for (const table of schema) {
        assert.match(table.sql, /\bSTRICT\b/, `table ${table.name} must be STRICT`);
        for (const column of table.columns) {
          assert.notEqual(column.type.toUpperCase(), "BLOB", `${table.name}.${column.name} must not be BLOB`);
          assert.notEqual(column.type.toUpperCase(), "ANY", `${table.name}.${column.name} must not be ANY`);
          assert.ok(
            ["TEXT", "INTEGER", "INT"].includes(column.type.toUpperCase()),
            `${table.name}.${column.name} has unexpected declared type ${column.type}`,
          );
        }
      }

      // Every free-text-shaped column is bounded and token-formatted, so
      // none of them is wide enough (or shaped for prose) to be abused as a
      // transcript field.
      const id = identity(1);
      store.createSession({
        occurrenceId: id.occurrenceId,
        occurrenceSegment: occurrencePathSegment(id.occurrenceId),
        providerMeetingId: id.providerMeetingId,
        occurrenceStartedAt: id.occurrenceStartedAt,
        nowMs: BASE_MS,
      });
      assert.throws(
        () =>
          store.transition({
            occurrenceId: id.occurrenceId,
            fromState: "discovered",
            toState: "joining",
            reason: "the quick brown fox jumped over the lazy dog ".repeat(50),
            terminalReason: null,
            nowMs: BASE_MS + 1,
          }),
        isOrchestrationError("constraint_violation"),
      );
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("foreign keys are enforced, not decorative: a lease for an unknown occurrence is rejected", () => {
  const h = harness();
  try {
    const store = h.open();
    try {
      assert.throws(
        () =>
          store.acquireLease({
            occurrenceId: identity(42).occurrenceId,
            bridgeId: "fake-bridge-a",
            bridgeSessionId: "fake-bridge-session-a",
            nowMs: BASE_MS,
            ttlMs: LEASE_TTL_MS,
          }),
        isOrchestrationError("unknown_session"),
      );
      assert.deepEqual(store.foreignKeyCheck(), []);
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

test("the happy path runs discovered -> ... -> notified with a complete audit trail", () => {
  const h = harness();
  try {
    const store = h.open();
    const clock = fakeClock();
    const coordinator = coordinatorFor(store, clock);
    try {
      const id = identity(1);
      const created = coordinator.discover(id);
      assert.equal(created.state, "discovered");
      assert.equal(created.occurrenceSegment, occurrencePathSegment(id.occurrenceId));

      for (const next of HAPPY_PATH_STATES) {
        clock.advance(1_000);
        const row = coordinator.advance(id.occurrenceId, next);
        assert.equal(row.state, next);
        assert.equal(row.updatedAtMs, clock.now());
      }

      assert.equal(coordinator.get(id.occurrenceId)?.state, "notified");

      const history = coordinator.history(id.occurrenceId);
      assert.deepEqual(
        history.map((t) => [t.fromState, t.toState]),
        [
          [null, "discovered"],
          ["discovered", "joining"],
          ["joining", "listening"],
          ["listening", "finalizing"],
          ["finalizing", "awaiting_teammem"],
          ["awaiting_teammem", "published"],
          ["published", "notified"],
        ],
      );
      for (let i = 1; i < history.length; i += 1) {
        assert.ok(history[i]!.id > history[i - 1]!.id);
        assert.ok(history[i]!.occurredAtMs >= history[i - 1]!.occurredAtMs);
      }
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("a process that dies at ANY state boundary resumes from the persisted row", () => {
  for (let boundary = 0; boundary <= HAPPY_PATH_STATES.length; boundary += 1) {
    const h = harness();
    try {
      const id = identity(1);
      const clock = fakeClock();

      const before = h.open();
      const first = coordinatorFor(before, clock);
      first.discover(id);
      for (const next of HAPPY_PATH_STATES.slice(0, boundary)) {
        clock.advance(1_000);
        first.advance(id.occurrenceId, next);
      }
      const expectedState: SessionState = boundary === 0 ? "discovered" : HAPPY_PATH_STATES[boundary - 1]!;
      before.close();

      // A brand new process, a brand new coordinator, the same file.
      const after = h.open();
      const resumed = coordinatorFor(after, clock);
      try {
        const row = resumed.get(id.occurrenceId);
        assert.equal(row?.state, expectedState, `restart after ${boundary} transitions must resume in ${expectedState}`);

        for (const next of HAPPY_PATH_STATES.slice(boundary)) {
          clock.advance(1_000);
          resumed.advance(id.occurrenceId, next);
        }
        assert.equal(resumed.get(id.occurrenceId)?.state, "notified");
        assert.equal(
          resumed.history(id.occurrenceId).length,
          HAPPY_PATH_STATES.length + 1,
          "the audit trail must survive the restart intact",
        );
      } finally {
        after.close();
      }
    } finally {
      h.cleanup();
    }
  }
});

test("every edge declared legal is actually accepted by the coordinator", () => {
  let exercised = 0;
  for (const from of SESSION_STATES) {
    for (const to of ALLOWED_TRANSITIONS[from]) {
      const h = harness();
      try {
        const store = h.open();
        const coordinator = coordinatorFor(store, fakeClock());
        try {
          const id = identity(1);
          coordinator.discover(id);
          driveTo(coordinator, id.occurrenceId, from);
          if (from !== "discovered") {
            assert.equal(coordinator.get(id.occurrenceId)?.state, from);
          }

          const row = to === "failed" ? coordinator.fail(id.occurrenceId, "bridge_failure") : coordinator.advance(id.occurrenceId, to);
          assert.equal(row.state, to);
          exercised += 1;
        } finally {
          store.close();
        }
      } finally {
        h.cleanup();
      }
    }
  }
  assert.ok(exercised >= 12, `expected the state machine to declare real edges, got ${exercised}`);
});

test("invalid transitions are rejected, and reject without touching state or the audit trail", () => {
  const illegal: ReadonlyArray<readonly [SessionState, SessionState]> = [
    ["discovered", "listening"],
    ["discovered", "notified"],
    ["joining", "discovered"],
    ["listening", "joining"],
    ["listening", "published"],
    ["finalizing", "listening"],
    ["awaiting_teammem", "finalizing"],
    ["published", "listening"],
    ["notified", "published"],
    ["notified", "failed"],
    ["failed", "joining"],
    ["failed", "notified"],
  ];

  for (const [from, to] of illegal) {
    const h = harness();
    try {
      const store = h.open();
      const coordinator = coordinatorFor(store, fakeClock());
      try {
        const id = identity(1);
        coordinator.discover(id);
        if (from === "failed") {
          coordinator.fail(id.occurrenceId, "bridge_failure");
        } else {
          driveTo(coordinator, id.occurrenceId, from);
        }
        const before = snapshot(store, id.occurrenceId);

        assert.throws(
          () => (to === "failed" ? coordinator.fail(id.occurrenceId, "bridge_failure") : coordinator.advance(id.occurrenceId, to)),
          isOrchestrationError("illegal_transition"),
          `${from} -> ${to} must be rejected`,
        );

        assert.deepEqual(snapshot(store, id.occurrenceId), before, `${from} -> ${to} must leave every row untouched`);
      } finally {
        store.close();
      }
    } finally {
      h.cleanup();
    }
  }
});

test("terminal states accept no further transition at all", () => {
  for (const terminal of TERMINAL_STATES) {
    assert.deepEqual(ALLOWED_TRANSITIONS[terminal], [], `${terminal} must be terminal in the declared table`);
  }
});

test("a stale expected-from state is rejected by compare-and-swap, so a resumed process cannot replay", () => {
  const h = harness();
  try {
    const store = h.open();
    const clock = fakeClock();
    const coordinator = coordinatorFor(store, clock);
    try {
      const id = identity(1);
      coordinator.discover(id);
      coordinator.advance(id.occurrenceId, "joining");

      // A process resumed from a stale in-memory view still believes the
      // row says "discovered". The store must refuse rather than clobber.
      assert.throws(
        () =>
          store.transition({
            occurrenceId: id.occurrenceId,
            fromState: "discovered",
            toState: "joining",
            reason: "advance",
            terminalReason: null,
            nowMs: clock.now(),
          }),
        isOrchestrationError("state_conflict"),
      );
      assert.equal(store.getSession(id.occurrenceId)?.state, "joining");
      assert.equal(store.listTransitions(id.occurrenceId).length, 2);
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("failing carries a terminal reason and can happen from any non-terminal state", () => {
  for (const from of SESSION_STATES) {
    if (TERMINAL_STATES.includes(from)) continue;
    const h = harness();
    try {
      const store = h.open();
      const coordinator = coordinatorFor(store, fakeClock());
      try {
        const id = identity(1);
        coordinator.discover(id);
        driveTo(coordinator, id.occurrenceId, from);
        const row = coordinator.fail(id.occurrenceId, "organizer_unresolved");
        assert.equal(row.state, "failed");
        assert.equal(row.terminalReason, "organizer_unresolved");
      } finally {
        store.close();
      }
    } finally {
      h.cleanup();
    }
  }
});

test("an unknown occurrence is never silently created by a transition", () => {
  const h = harness();
  try {
    const store = h.open();
    const coordinator = coordinatorFor(store, fakeClock());
    try {
      assert.throws(() => coordinator.advance(identity(99).occurrenceId, "joining"), isOrchestrationError("unknown_session"));
      assert.equal(coordinator.get(identity(99).occurrenceId), null);
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("discovering the same occurrence twice is rejected rather than duplicating state", () => {
  const h = harness();
  try {
    const store = h.open();
    const coordinator = coordinatorFor(store, fakeClock());
    try {
      const id = identity(1);
      coordinator.discover(id);
      assert.throws(() => coordinator.discover(id), isOrchestrationError("duplicate_session"));
      assert.equal(coordinator.history(id.occurrenceId).length, 1);
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

test("a transition and its audit record commit as one unit: a mid-transition failure leaves nothing", () => {
  const h = harness();
  try {
    const store = h.open();
    const clock = fakeClock();
    const coordinator = coordinatorFor(store, clock);
    try {
      const id = identity(1);
      coordinator.discover(id);
      const before = snapshot(store, id.occurrenceId);

      // The state UPDATE is valid and would run first; the audit INSERT
      // then violates the reason CHECK. If the two were not one
      // transaction, the session row would already read "joining" with no
      // audit record for it.
      assert.throws(
        () =>
          store.transition({
            occurrenceId: id.occurrenceId,
            fromState: "discovered",
            toState: "joining",
            reason: "NOT A VALID REASON TOKEN",
            terminalReason: null,
            nowMs: clock.now() + 5,
          }),
        isOrchestrationError("constraint_violation"),
      );

      assert.deepEqual(snapshot(store, id.occurrenceId), before);
      assert.equal(store.getSession(id.occurrenceId)?.state, "discovered");
      assert.equal(store.listTransitions(id.occurrenceId).length, 1);

      // The connection is still usable afterwards: the rollback did not
      // wedge it.
      assert.equal(coordinator.advance(id.occurrenceId, "joining").state, "joining");
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("a rolled-back transition is invisible after a restart", () => {
  const h = harness();
  try {
    const id = identity(1);
    const first = h.open();
    const coordinator = coordinatorFor(first, fakeClock());
    coordinator.discover(id);
    assert.throws(
      () =>
        first.transition({
          occurrenceId: id.occurrenceId,
          fromState: "discovered",
          toState: "joining",
          reason: "INVALID",
          terminalReason: null,
          nowMs: BASE_MS + 5,
        }),
      isOrchestrationError("constraint_violation"),
    );
    first.close();

    const second = h.open();
    try {
      assert.equal(second.getSession(id.occurrenceId)?.state, "discovered");
      assert.equal(second.listTransitions(id.occurrenceId).length, 1);
    } finally {
      second.close();
    }
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Bridge leases
// ---------------------------------------------------------------------------

test("a bridge lease is unique per occurrence while it is live", () => {
  const h = harness();
  try {
    const store = h.open();
    const clock = fakeClock();
    const coordinator = coordinatorFor(store, clock);
    try {
      const id = identity(1);
      coordinator.discover(id);

      const lease = coordinator.acquireBridgeLease(id.occurrenceId, {
        bridgeId: "fake-bridge-a",
        bridgeSessionId: "fake-bridge-session-1",
      });
      assert.equal(lease.expiresAtMs, clock.now() + LEASE_TTL_MS);
      assert.equal(lease.releasedAtMs, null);
      assert.deepEqual(coordinator.activeBridgeLease(id.occurrenceId), lease);

      clock.advance(LEASE_TTL_MS - 1);
      assert.throws(
        () =>
          coordinator.acquireBridgeLease(id.occurrenceId, {
            bridgeId: "fake-bridge-b",
            bridgeSessionId: "fake-bridge-session-2",
          }),
        isOrchestrationError("lease_held"),
      );
      assert.deepEqual(coordinator.activeBridgeLease(id.occurrenceId), lease);
      assert.equal(store.listLeases(id.occurrenceId).length, 1);
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("a stale lease is recoverable once its bounded timeout has passed, using an injected clock", () => {
  const h = harness();
  try {
    const store = h.open();
    const clock = fakeClock();
    const coordinator = coordinatorFor(store, clock);
    try {
      const id = identity(1);
      coordinator.discover(id);
      const abandoned = coordinator.acquireBridgeLease(id.occurrenceId, {
        bridgeId: "fake-bridge-a",
        bridgeSessionId: "fake-bridge-session-1",
      });

      // Exactly at the timeout the lease is expired, not held. No sleeping.
      clock.advance(LEASE_TTL_MS);
      const recovered = coordinator.acquireBridgeLease(id.occurrenceId, {
        bridgeId: "fake-bridge-b",
        bridgeSessionId: "fake-bridge-session-2",
      });

      assert.notEqual(recovered.leaseId, abandoned.leaseId);
      assert.equal(recovered.bridgeId, "fake-bridge-b");
      assert.deepEqual(coordinator.activeBridgeLease(id.occurrenceId), recovered);

      const all = store.listLeases(id.occurrenceId);
      assert.equal(all.length, 2);
      const old = all.find((l) => l.leaseId === abandoned.leaseId)!;
      assert.equal(old.releasedAtMs, clock.now());
      assert.equal(old.releaseReason, "stale_recovered");
      assert.equal(all.filter((l) => l.releasedAtMs === null).length, 1);
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("a `left` event ends the lease; resuming takes a NEW lease for a NEW bridge session", () => {
  const h = harness();
  try {
    const store = h.open();
    const clock = fakeClock();
    const coordinator = coordinatorFor(store, clock);
    try {
      const id = identity(1);
      coordinator.discover(id);
      const first = coordinator.acquireBridgeLease(id.occurrenceId, {
        bridgeId: "fake-bridge-a",
        bridgeSessionId: "fake-bridge-session-1",
      });

      // bridge-session/v1 has no re-open: after `left` that bridge session
      // is over, so the lease is released rather than reused.
      clock.advance(500);
      const released = coordinator.releaseBridgeLease(id.occurrenceId, first.leaseId, "left");
      assert.equal(released.releasedAtMs, clock.now());
      assert.equal(released.releaseReason, "left");
      assert.equal(coordinator.activeBridgeLease(id.occurrenceId), null);

      // Resuming does not un-leave the old bridge session; it takes a new one.
      clock.advance(500);
      const second = coordinator.acquireBridgeLease(id.occurrenceId, {
        bridgeId: "fake-bridge-a",
        bridgeSessionId: "fake-bridge-session-2",
      });
      assert.notEqual(second.leaseId, first.leaseId);
      assert.notEqual(second.bridgeSessionId, first.bridgeSessionId);
      assert.equal(second.releasedAtMs, null);
      assert.equal(store.listLeases(id.occurrenceId).length, 2);
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("a bridge_failure release is terminal for that lease exactly like `left`", () => {
  const h = harness();
  try {
    const store = h.open();
    const clock = fakeClock();
    const coordinator = coordinatorFor(store, clock);
    try {
      const id = identity(1);
      coordinator.discover(id);
      const lease = coordinator.acquireBridgeLease(id.occurrenceId, {
        bridgeId: "fake-bridge-a",
        bridgeSessionId: "fake-bridge-session-1",
      });
      coordinator.releaseBridgeLease(id.occurrenceId, lease.leaseId, "bridge_failure");

      assert.equal(coordinator.activeBridgeLease(id.occurrenceId), null);
      assert.throws(() => coordinator.releaseBridgeLease(id.occurrenceId, lease.leaseId, "left"), isOrchestrationError("unknown_lease"));
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("leases survive a restart: an unexpired lease is still held, an expired one is still recoverable", () => {
  const h = harness();
  try {
    const id = identity(1);
    const clock = fakeClock();

    const before = h.open();
    const firstCoordinator = coordinatorFor(before, clock);
    firstCoordinator.discover(id);
    const lease = firstCoordinator.acquireBridgeLease(id.occurrenceId, {
      bridgeId: "fake-bridge-a",
      bridgeSessionId: "fake-bridge-session-1",
    });
    before.close();

    const after = h.open();
    const resumed = coordinatorFor(after, clock);
    try {
      assert.deepEqual(resumed.activeBridgeLease(id.occurrenceId), lease);
      assert.throws(
        () =>
          resumed.acquireBridgeLease(id.occurrenceId, {
            bridgeId: "fake-bridge-b",
            bridgeSessionId: "fake-bridge-session-2",
          }),
        isOrchestrationError("lease_held"),
      );

      clock.advance(LEASE_TTL_MS);
      const recovered = resumed.acquireBridgeLease(id.occurrenceId, {
        bridgeId: "fake-bridge-b",
        bridgeSessionId: "fake-bridge-session-2",
      });
      assert.notEqual(recovered.leaseId, lease.leaseId);
    } finally {
      after.close();
    }
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

test("occurrence A's entire lifecycle never reads or mutates occurrence B's rows", () => {
  const h = harness();
  try {
    const store = h.open();
    const clock = fakeClock();
    const coordinator = coordinatorFor(store, clock);
    try {
      const a = identity(1);
      const b = identity(2);
      coordinator.discover(a);
      coordinator.discover(b);

      // B is parked mid-flight with a live lease, so it has rows in all
      // three tables that a leaky implementation could plausibly disturb.
      coordinator.advance(b.occurrenceId, "joining");
      const bLease = coordinator.acquireBridgeLease(b.occurrenceId, {
        bridgeId: "fake-bridge-b",
        bridgeSessionId: "fake-bridge-session-b1",
      });
      const bBefore = snapshot(store, b.occurrenceId);
      const aBefore = snapshot(store, a.occurrenceId);

      // A now does everything it can do: the full happy path, two lease
      // generations (one released after `left`, one recovered from
      // staleness), and one transition that fails and rolls back.
      const aLease1 = coordinator.acquireBridgeLease(a.occurrenceId, {
        bridgeId: "fake-bridge-a",
        bridgeSessionId: "fake-bridge-session-a1",
      });
      coordinator.releaseBridgeLease(a.occurrenceId, aLease1.leaseId, "left");
      coordinator.acquireBridgeLease(a.occurrenceId, {
        bridgeId: "fake-bridge-a",
        bridgeSessionId: "fake-bridge-session-a2",
      });
      clock.advance(LEASE_TTL_MS);
      coordinator.acquireBridgeLease(a.occurrenceId, {
        bridgeId: "fake-bridge-a",
        bridgeSessionId: "fake-bridge-session-a3",
      });
      for (const next of HAPPY_PATH_STATES) {
        clock.advance(10);
        coordinator.advance(a.occurrenceId, next);
      }
      assert.throws(
        () =>
          store.transition({
            occurrenceId: a.occurrenceId,
            fromState: "notified",
            toState: "published",
            reason: "INVALID",
            terminalReason: null,
            nowMs: clock.now(),
          }),
        (error: unknown) => error instanceof OrchestrationError,
      );

      // A moved. B did not, row for row.
      assert.notDeepEqual(snapshot(store, a.occurrenceId), aBefore);
      assert.deepEqual(snapshot(store, b.occurrenceId), bBefore, "occurrence B's rows must be byte-identical after all of A's activity");

      // B's lease is untouched even though A's clock has passed B's TTL: no
      // cross-occurrence sweep exists.
      assert.deepEqual(coordinator.activeBridgeLease(b.occurrenceId), bLease);

      // A's lease token is meaningless against B, and vice versa.
      const aActive = coordinator.activeBridgeLease(a.occurrenceId)!;
      assert.throws(() => coordinator.releaseBridgeLease(b.occurrenceId, aActive.leaseId, "left"), isOrchestrationError("unknown_lease"));
      assert.throws(() => coordinator.releaseBridgeLease(a.occurrenceId, bLease.leaseId, "left"), isOrchestrationError("unknown_lease"));
      assert.deepEqual(snapshot(store, b.occurrenceId), bBefore);

      // And B can still be driven forward independently afterwards.
      assert.equal(coordinator.advance(b.occurrenceId, "listening").state, "listening");
      assert.equal(coordinator.get(a.occurrenceId)?.state, "notified");
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("two occurrences of the same recurring meeting never share state", () => {
  const h = harness();
  try {
    const store = h.open();
    const clock = fakeClock();
    const coordinator = coordinatorFor(store, clock);
    try {
      // Same provider meeting id; different occurrence starts -- the
      // recurring-meeting case the occurrence key exists for.
      const week1 = buildMeetingIdentity({
        providerMeetingId: "fake-recurring-standup",
        meetingNo: "000000000",
        occurrenceStartedAt: "2026-09-02T09:00:00Z",
        title: "Fake Recurring Standup",
        organizer: null,
      });
      const week2 = buildMeetingIdentity({
        providerMeetingId: "fake-recurring-standup",
        meetingNo: "000000000",
        occurrenceStartedAt: "2026-09-09T09:00:00Z",
        title: "Fake Recurring Standup",
        organizer: null,
      });
      assert.notEqual(week1.occurrenceId, week2.occurrenceId);

      coordinator.discover(week1);
      coordinator.discover(week2);
      assert.notEqual(
        store.getSession(week1.occurrenceId)?.occurrenceSegment,
        store.getSession(week2.occurrenceId)?.occurrenceSegment,
      );

      const week2Before = snapshot(store, week2.occurrenceId);
      for (const next of HAPPY_PATH_STATES) {
        coordinator.advance(week1.occurrenceId, next);
      }
      coordinator.acquireBridgeLease(week1.occurrenceId, {
        bridgeId: "fake-bridge-a",
        bridgeSessionId: "fake-bridge-session-w1",
      });

      assert.equal(coordinator.get(week2.occurrenceId)?.state, "discovered");
      assert.deepEqual(snapshot(store, week2.occurrenceId), week2Before);
      assert.equal(coordinator.activeBridgeLease(week2.occurrenceId), null);

      // Both may hold their own bridge lease at the same time.
      coordinator.acquireBridgeLease(week2.occurrenceId, {
        bridgeId: "fake-bridge-b",
        bridgeSessionId: "fake-bridge-session-w2",
      });
      assert.notEqual(
        coordinator.activeBridgeLease(week1.occurrenceId)?.leaseId,
        coordinator.activeBridgeLease(week2.occurrenceId)?.leaseId,
      );
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Concurrency semaphore
// ---------------------------------------------------------------------------

const CONCURRENT_OCCURRENCES = 20;

async function runConcurrent(limit: number): Promise<{ peak: number; store: SessionStore; h: Harness }> {
  const h = harness();
  const store = h.open();
  const clock = fakeClock();
  const coordinator = coordinatorFor(store, clock, limit);

  const ids = Array.from({ length: CONCURRENT_OCCURRENCES }, (_, i) => identity(i + 1));
  for (const id of ids) coordinator.discover(id);

  const gate = deferred();
  let peak = 0;
  const tasks = ids.map((id) =>
    coordinator.withSession(id.occurrenceId, async () => {
      peak = Math.max(peak, coordinator.activeSessionCount());
      await gate.promise;
      const lease = coordinator.acquireBridgeLease(id.occurrenceId, {
        bridgeId: `fake-bridge-${id.providerMeetingId}`,
        bridgeSessionId: `fake-bridge-session-${id.providerMeetingId}`,
      });
      for (const next of HAPPY_PATH_STATES) {
        coordinator.advance(id.occurrenceId, next);
      }
      coordinator.releaseBridgeLease(id.occurrenceId, lease.leaseId, "left");
    }),
  );

  await flush();
  assert.equal(
    coordinator.activeSessionCount(),
    Math.min(limit, CONCURRENT_OCCURRENCES),
    `the semaphore must admit exactly ${limit} occurrences at once`,
  );
  gate.resolve();
  await Promise.all(tasks);

  assert.equal(coordinator.activeSessionCount(), 0);
  for (const id of ids) {
    assert.equal(coordinator.get(id.occurrenceId)?.state, "notified");
    assert.equal(coordinator.history(id.occurrenceId).length, HAPPY_PATH_STATES.length + 1);
    assert.equal(coordinator.activeBridgeLease(id.occurrenceId), null);
    assert.equal(store.listLeases(id.occurrenceId).length, 1);
  }
  assert.deepEqual(store.foreignKeyCheck(), []);

  return { peak, store, h };
}

test("20 concurrent occurrences run correctly under a semaphore of 4", async () => {
  const { peak, store, h } = await runConcurrent(4);
  try {
    assert.equal(peak, 4);
  } finally {
    store.close();
    h.cleanup();
  }
});

test("a semaphore of 1 is a valid deployment setting, not a broken one", async () => {
  const { peak, store, h } = await runConcurrent(1);
  try {
    assert.equal(peak, 1);
  } finally {
    store.close();
    h.cleanup();
  }
});

test("the semaphore is not a hard-coded maximum: 20 occurrences may run at once", async () => {
  const { peak, store, h } = await runConcurrent(CONCURRENT_OCCURRENCES);
  try {
    assert.equal(peak, CONCURRENT_OCCURRENCES);
  } finally {
    store.close();
    h.cleanup();
  }
});

test("a nonsensical concurrency limit is rejected at construction", () => {
  const h = harness();
  try {
    const store = h.open();
    try {
      for (const bad of [0, -1, 1.5, Number.NaN]) {
        assert.throws(
          () => coordinatorFor(store, fakeClock(), bad),
          isOrchestrationError("invalid_configuration"),
          `maxConcurrentSessions=${bad} must be rejected`,
        );
      }
      assert.equal(coordinatorFor(store, fakeClock(), 1).maxConcurrentSessions, 1);
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("a failing session releases its semaphore slot", async () => {
  const h = harness();
  try {
    const store = h.open();
    const coordinator = coordinatorFor(store, fakeClock(), 1);
    try {
      const id = identity(1);
      coordinator.discover(id);
      await assert.rejects(
        coordinator.withSession(id.occurrenceId, async () => {
          await Promise.resolve();
          throw new Error("synthetic bridge failure");
        }),
        /synthetic bridge failure/,
      );
      assert.equal(coordinator.activeSessionCount(), 0);

      // The slot is genuinely free again.
      await coordinator.withSession(id.occurrenceId, async () => {
        await Promise.resolve();
        coordinator.fail(id.occurrenceId, "bridge_failure");
      });
      assert.equal(coordinator.get(id.occurrenceId)?.state, "failed");
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});

test("withSession never consumes a slot for an unknown occurrence", async () => {
  const h = harness();
  try {
    const store = h.open();
    const coordinator = coordinatorFor(store, fakeClock(), 1);
    try {
      await assert.rejects(
        coordinator.withSession(identity(404).occurrenceId, async () => {
          await Promise.resolve();
        }),
        isOrchestrationError("unknown_session"),
      );
      assert.equal(coordinator.activeSessionCount(), 0);
    } finally {
      store.close();
    }
  } finally {
    h.cleanup();
  }
});
