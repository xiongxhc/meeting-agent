import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error Test-only oracle has no public declaration.
import { d2OrderingOracles } from "./d2-oracles.mjs";

interface RuntimeEvent {
  type?: string; session_id?: string; segment_id?: string; turn_id?: string; generation_id?: string;
  milestone?: string; state?: string; monotonicNs: string; event?: { type: string; turn_id: string };
  activity?: { type: string };
}

function fixture(cut: string) {
  const terminal = cut === "complete-wins" ? "turn_completed" : "turn_cancelled";
  const detail = { turn: "4", generation: "4", segment: "7", renderCallbacks: [{ sequence: "9", generation: "4", status: cut === "complete-wins" ? "suppressed_duplicate" : "suppressed_flushed", monotonicNs: "50" }],
    rendered: [{ sequence: "9", generation: "4", status: "rendered", monotonicNs: "10" }], lateActivityMonotonicNs: "40",
    activityMonotonicNs: "5" as string | null, flushMonotonicNs: "20", runtimeLateActivityMonotonicNs: "45" };
  const ordering = { name: cut === "complete-wins" ? "completion_ordered" : "interruption_acknowledged", ...detail };
  const closed = { name: "repeated_close", concurrentPromiseSame: true, settledPromiseSame: true, startedWhileHeld: true,
    results: Array.from({ length: 3 }, () => ({ status: "rejected", reason: "composition_close_failed:application_close_failed" })),
    outcomes: [{ occurrenceId: "occ", phase: "settled", runtimeClose: "closed", controlSessionId: "42" }] };
  const trace = ["shutdown_fenced", "shutdown_owned_work_settled", "shutdown_application_closed", "shutdown_runtime_owners_closed", "shutdown_transports_closed", "shutdown_store_closed"];
  const accepted = { name: "held_playback_accepted", sessionId: "42", segment: "7", turn: "4", generation: "4", sequence: "9", acceptedMonotonicNs: "3", monotonicNs: "4" };
  const closeStarted = { name: "repeated_close_started", sessionId: "42", segment: "7", turn: "4", generation: "4", startedWhileHeld: true, monotonicNs: "5" };
  return { cut, ordering, closed, accepted, closeStarted,
    events: [ordering,
      { name: "transcript_tested", testName: "story", sessionId: "42", segment: "7", turn: "4", authorized: true },
      accepted, closeStarted,
      closed,
      { name: "owner_lock_released", released: true, afterStoreClosed: true }],
    runtimeEvents: [{ type: "voice_transcript_final", session_id: "42", segment_id: "7", monotonicNs: "1" },
      { type: "response_authorized", session_id: "42", segment_id: "7", turn_id: "4", monotonicNs: "2" },
      { type: "voice_playback", session_id: "42", generation_id: "4", state: "accepted", monotonicNs: "3" },
      ...(cut === "complete-wins" ? [] : [{ type: "voice_barge_in", session_id: "42", turn_id: "4", generation_id: "4", monotonicNs: "10" },
      { type: "voice_timing", session_id: "42", turn_id: "4", milestone: "playback_flush_acknowledged", monotonicNs: "20" }]),
      { session_id: "42", generation_id: "4", event: { type: terminal, turn_id: "4" }, monotonicNs: "30" },
      ...(cut === "complete-wins" ? [{ type: "voice_activity", session_id: "42", activity: { type: "speech_started" }, monotonicNs: "45" }] : [])] as RuntimeEvent[],
    childState: { playback: [{ sequence: "9", generation: "4", turn: "4", held: true, afterFlush: false }],
      flushes: cut === "complete-wins" ? [] : [{ generation: "4", monotonicNs: "20" }], renderCallbacks: detail.renderCallbacks, left: null },
    reopen: { rows: { custody: [{ occurrence_id: "occ", state: "quarantined" }] } },
    summary: { trace, driveFailure: null }, outcome: { code: 70 },
  };
}
function failures(value: ReturnType<typeof fixture>) {
  return d2OrderingOracles(value).filter((row: { status: string }) => row.status === "fail");
}
for (const cut of ["cancel-wins", "complete-wins", "repeated-close"]) {
  test(`${cut} checks actual terminal/ACK or shutdown evidence and rejects a contradictory terminal`, () => {
    const f = fixture(cut), rows = d2OrderingOracles(f);
    assert.ok(rows.length > 0); assert.deepEqual(failures(f), []);
    if (cut === "repeated-close") {
      f.closed.concurrentPromiseSame = false;
    } else {
      f.runtimeEvents.push({ session_id: "42", generation_id: "4", event: { type: "turn_failed", turn_id: "4" }, monotonicNs: "60" });
    }
    assert.ok(failures(f).length > 0);
  });
}

test("race evidence refuses reordered flush, unsuppressed callbacks or a missing completed terminal", () => {
  const cancel = fixture("cancel-wins");
  [cancel.runtimeEvents[3], cancel.runtimeEvents[4]] = [cancel.runtimeEvents[4]!, cancel.runtimeEvents[3]!];
  assert.ok(failures(cancel).length > 0);
  const complete = fixture("complete-wins");
  complete.ordering.renderCallbacks[0]!.status = "rendered";
  assert.ok(failures(complete).length > 0);
  const missing = fixture("complete-wins"); missing.runtimeEvents = [];
  assert.ok(failures(missing).length > 0);
});

test("all race and teardown events require the bound Runtime session and generation", () => {
  for (const cut of ["cancel-wins", "complete-wins", "repeated-close"]) {
    for (const type of ["response_authorized", "terminal", ...(cut === "cancel-wins" ? ["voice_barge_in", "voice_timing"] : [])]) {
      const f = fixture(cut);
      const row = f.runtimeEvents.find(row => type === "terminal" ? row.event : row.type === type)!;
      row.session_id = "43";
      assert.ok(failures(f).length > 0, `${cut} accepted foreign ${type}`);
    }
    const f = fixture(cut); f.runtimeEvents.find(row => row.event)!.generation_id = "5";
    assert.ok(failures(f).length > 0, `${cut} accepted foreign terminal generation`);
  }
});

test("repeated-close counts held-turn terminals through teardown and rejects late output", () => {
  const missing = fixture("repeated-close"); missing.runtimeEvents = missing.runtimeEvents.filter(row => !row.event);
  assert.ok(failures(missing).length > 0);
  const duplicate = fixture("repeated-close"); duplicate.runtimeEvents.push({ session_id: "42", generation_id: "4", event: { type: "turn_failed", turn_id: "4" }, monotonicNs: "60" });
  assert.ok(failures(duplicate).length > 0);
  const late = fixture("repeated-close"); late.runtimeEvents.push({ type: "voice_playback", session_id: "42", generation_id: "4", state: "accepted", monotonicNs: "60" });
  assert.ok(failures(late).length > 0);
});

test("cancellation evidence requires its scripted monotonic endpoints", () => {
  const f = fixture("cancel-wins"); f.ordering.activityMonotonicNs = null;
  assert.ok(failures(f).length > 0);
});

test("completed work permits delayed ordinary Rendered observation", () => {
  const f = fixture("complete-wins");
  f.runtimeEvents.push({ type: "voice_playback", session_id: "42", generation_id: "4", state: "rendered", monotonicNs: "60" });
  assert.deepEqual(failures(f), []);
});

test("unclean owner close requires settled custody quarantine and ordered store closure", () => {
  const f = fixture("repeated-close"); f.reopen.rows.custody[0]!.state = "cleared";
  assert.ok(failures(f).length > 0);
  const reordered = fixture("repeated-close"); reordered.summary.trace.reverse();
  assert.ok(failures(reordered).length > 0);
});

test("each ordering requires actual held Runtime acceptance before its action", () => {
  for (const cut of ["cancel-wins", "complete-wins", "repeated-close"]) {
    for (const fault of ["missing", "foreign_session", "foreign_generation", "before_authorization", "after_action", "missing_barrier", "wrong_frame"]) {
      const f = fixture(cut), accepted = f.runtimeEvents.find(row => row.state === "accepted")!;
      if (fault === "missing") f.runtimeEvents = f.runtimeEvents.filter(row => row !== accepted);
      if (fault === "foreign_session") accepted.session_id = "43";
      if (fault === "foreign_generation") accepted.generation_id = "5";
      if (fault === "before_authorization") { accepted.monotonicNs = "1"; f.accepted.acceptedMonotonicNs = "1"; }
      if (fault === "after_action") { accepted.monotonicNs = "12"; f.accepted.acceptedMonotonicNs = "12"; f.accepted.monotonicNs = "13"; }
      if (fault === "missing_barrier") f.events = f.events.filter(row => row.name !== "held_playback_accepted");
      if (fault === "wrong_frame") f.accepted.sequence = "10";
      assert.ok(failures(f).length > 0, `${cut} accepted ${fault}`);
    }
  }
});

test("completion requires same-session Runtime late speech rather than only provider send", () => {
  for (const fault of ["missing", "foreign_session", "wrong_activity", "before_completion", "before_provider_send", "missing_binding"]) {
    const f = fixture("complete-wins"), activity = f.runtimeEvents.find(row => row.type === "voice_activity")!;
    if (fault === "missing") f.runtimeEvents = f.runtimeEvents.filter(row => row !== activity);
    if (fault === "foreign_session") activity.session_id = "43";
    if (fault === "wrong_activity") activity.activity!.type = "speech_ended";
    if (fault === "before_completion" || fault === "before_provider_send") {
      activity.monotonicNs = fault === "before_completion" ? "20" : "35";
      f.ordering.runtimeLateActivityMonotonicNs = activity.monotonicNs;
    }
    if (fault === "missing_binding") f.ordering.runtimeLateActivityMonotonicNs = "";
    assert.ok(failures(f).length > 0, `completion accepted ${fault}`);
  }
});
