import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error Test-only harness module has no public declaration.
import { interactiveOracles } from "./run.mjs";

// Synthetic interactive evidence; these predicate tests are not integration proof.
function fixture(d2Cut?: string) {
  const answered = (turn: string) => [
    { type: "response_authorized", segment_id: `${turn}0`, turn_id: turn },
    { event: { type: "turn_completed", turn_id: turn } },
  ];
  return {
    plan: { vaultRevision: "rev", d2Cut },
    events: [
      { name: "silent_capture", frames: 51, disclosure: "failed", languageCalls: 0, playback: 0, authorizations: 0 },
      { name: "name_gate_negative", languageCalls: 0, playback: 0 },
      { name: "current_question_answered", turn: "1", segment: "10", vaultReadsBefore: 0, vaultReadsAfter: 0 },
      { name: "vault_question_answered", turn: "2", segment: "20", vaultReadsBefore: 0, vaultReadsAfter: 1 },
      { name: "unavailable_question_answered", turn: "3", segment: "30" },
      { name: "interruption_acknowledged", turn: "4", generation: "4", captureBefore: 5, captureAfter: 15 },
    ] as Array<Record<string, unknown>>,
    summary: {
      runtimeEvents: [
        { type: "response_skipped" }, { type: "response_skipped" }, { type: "response_skipped" },
        ...answered("1"), ...answered("2"), ...answered("3"),
        { type: "voice_barge_in", generation_id: "4", turn_id: "4" },
        { type: "voice_timing", turn_id: "4", milestone: "playback_flush_acknowledged" },
        { event: { type: "turn_cancelled", turn_id: "4" } },
      ] as Array<Record<string, unknown>>,
      interactiveCalls: [
        { route: "language", grounded: "current", currentFact: true, vaultFact: false },
        { route: "speech", text: "Copper budget is seven." },
        { route: "language", grounded: "vault", vaultFact: true },
        { route: "speech", text: "Orion launch code is violet." },
        { route: "language", unavailable: true },
        { route: "speech", text: "Historical team memory is unavailable." },
      ] as Array<Record<string, unknown>>,
      vaultReads: [{ type: "vault_index_source", source: "rev:orion.md" }] as Array<Record<string, unknown>>,
    },
    childState: {
      playback: [{ turn: "1", held: false }, { turn: "2", held: false }, { turn: "3", held: false },
        { turn: "4", generation: "4", held: true, afterFlush: false }] as Array<Record<string, unknown>>,
      flushes: [{ generation: "4" }] as Array<Record<string, unknown>>,
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
function results(live: Fixture) {
  const rows: Array<{ name: string; pass: boolean }> = [];
  interactiveOracles(live, (name: string, condition: unknown) => { rows.push({ name, pass: Boolean(condition) }); return condition; });
  return rows;
}
const failed = (live: Fixture) => results(live).filter((row) => !row.pass).map((row) => row.name);
const event = (live: Fixture, name: string) => live.events.find((row) => row.name === name)!;
const runtime = (live: Fixture, match: (row: Record<string, unknown>) => boolean) => live.summary.runtimeEvents.find(match)!;
const terminal = (turn: string) => (row: Record<string, unknown>) => (row.event as { turn_id?: string } | undefined)?.turn_id === turn;

test("complete interactive evidence passes all six oracles", () => {
  assert.deepEqual(results(fixture()).map((row) => [row.name, row.pass]), [
    ["silent_name_gate", true], ["current_meeting_grounding", true], ["vault_grounding", true], ["vault_unavailable", true],
    ["acknowledged_interruption", true], ["capture_after_interrupt", true]]);
});

test("complete-wins and repeated-close stop before the interruption oracles", () => {
  for (const cut of ["complete-wins", "repeated-close"]) assert.deepEqual(results(fixture(cut)).map((row) => row.name),
    ["silent_name_gate", "current_meeting_grounding", "vault_grounding", "vault_unavailable"]);
});

test("each interactive oracle refuses its own missing or contradicted fact", () => {
  const cases: Array<[string, string, (f: Fixture) => void]> = [
    ["silent_name_gate", "short silent capture", f => { event(f, "silent_capture").frames = 50; }],
    ["silent_name_gate", "language call before invocation", f => { event(f, "silent_capture").languageCalls = 1; }],
    ["silent_name_gate", "disclosure not failed", f => { event(f, "silent_capture").disclosure = "sent"; }],
    ["silent_name_gate", "near-name playback", f => { event(f, "name_gate_negative").playback = 1; }],
    ["silent_name_gate", "two skips", f => { f.summary.runtimeEvents.splice(0, 1); }],
    ["current_meeting_grounding", "vault read during the current question", f => { event(f, "current_question_answered").vaultReadsAfter = 1; }],
    ["current_meeting_grounding", "vault fact in the current request", f => { f.summary.interactiveCalls[0]!.vaultFact = true; }],
    ["current_meeting_grounding", "wrong spoken answer", f => { f.summary.interactiveCalls[1]!.text = "Copper budget is six."; }],
    ["current_meeting_grounding", "cancelled turn", f => { (runtime(f, terminal("1")).event as { type: string }).type = "turn_cancelled"; }],
    ["current_meeting_grounding", "no unheld playback", f => { f.childState.playback[0]!.held = true; }],
    ["vault_grounding", "fixture source not indexed", f => { f.summary.vaultReads[0]!.source = "other:orion.md"; }],
    ["vault_grounding", "no vault read", f => { event(f, "vault_question_answered").vaultReadsAfter = 0; }],
    ["vault_grounding", "duplicate authorization", f => { f.summary.runtimeEvents.push({ type: "response_authorized", segment_id: "20", turn_id: "2" }); }],
    ["vault_unavailable", "no unavailable instruction", f => { f.summary.interactiveCalls[4]!.unavailable = false; }],
    ["vault_unavailable", "missing answer", f => { f.events = f.events.filter((row) => row.name !== "unavailable_question_answered"); }],
    ["acknowledged_interruption", "completed instead of cancelled", f => { (runtime(f, terminal("4")).event as { type: string }).type = "turn_completed"; }],
    ["acknowledged_interruption", "barge for another generation", f => { runtime(f, (row) => row.type === "voice_barge_in").generation_id = "5"; }],
    ["acknowledged_interruption", "no Runtime flush timing", f => { runtime(f, (row) => row.type === "voice_timing").milestone = "playback_started"; }],
    ["acknowledged_interruption", "no bridge flush", f => { f.childState.flushes = []; }],
    ["acknowledged_interruption", "output after flush", f => { f.childState.playback.push({ turn: "4", generation: "4", held: false, afterFlush: true }); }],
    ["acknowledged_interruption", "second terminal", f => { f.summary.runtimeEvents.push({ event: { type: "turn_failed", turn_id: "4" } }); }],
    ["capture_after_interrupt", "nine frames after", f => { event(f, "interruption_acknowledged").captureAfter = 14; }],
  ];
  for (const [name, label, mutate] of cases) {
    const f = fixture(); mutate(f);
    assert.deepEqual(failed(f), [name], label);
  }
});
