import assert from "node:assert/strict";
import { test } from "node:test";
import { CLIENT_PROTOCOL_VERSION, validateClientCommand } from "@conversation/runtime";

import { buildTimedTeamMemMeetingArtifactV2, type TimedArtifactBuildInput } from "../src/delivery/artifact-builder.ts";
import type { ProcessTextRequest } from "../src/ports/conversation-runtime.ts";
import { buildInput, meeting, PEOPLE } from "./fixtures/long-meeting.ts";

// Reviewer's suggested tests for round 2 (D047): each pins one ruling the
// round-2 tests reach only together with others.

type Person = { person_id: string; display_name: string; text: string };
type WindowInput = { readonly transcript: { readonly segment_id: string }[] };
type Answer = Record<string, unknown> & { person_summaries: Person[] };

const ada = { person_id: PEOPLE[0].id, display_name: PEOPLE[0].name }, ben = { person_id: PEOPLE[1].id, display_name: PEOPLE[1].name };

/** Windows answer with nothing but what `window` returns; merges return one
 * summary for each person their parts name, or what `reduce` makes of that. */
function fake(window: (input: WindowInput, index: number) => Partial<Answer>, reduce?: (answer: Answer, call: number) => Answer) {
  const calls: ProcessTextRequest[] = [];
  let windows = 0, merges = 0;
  const runtime: TimedArtifactBuildInput["runtime"] = { async processText(request) {
    validateClientCommand({ type: "process_text", requestId: "fake", ...request }, CLIENT_PROTOCOL_VERSION);
    calls.push(request);
    const input = JSON.parse(request.input) as WindowInput & { parts?: { person_summaries: Person[] }[] };
    if (input.parts !== undefined) {
      const people = new Map(input.parts.flatMap((part) => part.person_summaries.map((entry) => [entry.person_id, entry.display_name] as const)));
      const answer: Answer = { summary: "merged", person_summaries: [...people].map(([person_id, display_name]) => ({ person_id, display_name, text: "merged" })) };
      return { output: reduce?.(answer, merges++) ?? answer, warnings: [] };
    }
    const index = windows++;
    return { output: { summary: `window ${index}`, projects: [], decisions: [], action_items: [], discussion_points: [],
      person_summaries: [{ ...ada, text: "here" }], ...window(input, index) }, warnings: [] };
  } };
  return { runtime, calls };
}
const first = (input: WindowInput) => input.transcript[0]!.segment_id;

test("a person summarized only in the last window reaches the final summary through every round", async () => {
  // Ben is summarized by window 17 only: round 1's last merge must carry him and the others must not.
  const { runtime, calls } = fake((_input, index) => ({ person_summaries: index === 16 ? [{ ...ada, text: "a" }, { ...ben, text: "b" }] : [{ ...ada, text: "a" }] }));
  const built = await buildTimedTeamMemMeetingArtifactV2(buildInput(meeting(45), runtime));
  assert.equal(calls.length, 17 + 4, "no merge needed a retry");
  assert.deepEqual(built.artifact.person_summaries.map(({ person_id }) => person_id), [ada.person_id, ben.person_id]);
});

for (const field of ["decisions", "action_items", "discussion_points"] as const) {
  test(`a window ${field} item citing outside its window is a visible build failure on its own`, async () => {
    const item = (ids: string[]) => field === "action_items" ? { text: "t", owner: null, due_date: null, evidence_segment_ids: ids } : { text: "t", evidence_segment_ids: ids };
    const { runtime } = fake((input, index) => ({ [field]: [item(index === 1 ? ["final-0"] : [first(input)])] }));
    await assert.rejects(buildTimedTeamMemMeetingArtifactV2(buildInput(meeting(45), runtime)), /window 2 of 17 cites evidence_segment_ids outside the window/);
  });
}

test("action items with the same text and different owners stay two items", async () => {
  const owner = (person: typeof ada | typeof ben) => ({ ...person, explicitly_stated: true as const });
  const { runtime } = fake((input, index) => ({ action_items: index < 2 ? [{ text: "Ship the release.", owner: owner(index === 0 ? ada : ben), due_date: null, evidence_segment_ids: [first(input)] }] : [] }));
  const built = await buildTimedTeamMemMeetingArtifactV2(buildInput(meeting(45), runtime));
  assert.deepEqual(built.artifact.action_items.map(({ owner }) => owner?.person_id), [ada.person_id, ben.person_id]);
});

test("a merged project citing exactly 100 segments and a merged list of exactly 500 items build", async () => {
  const ids = (input: WindowInput, count: number) => input.transcript.slice(0, count).map(({ segment_id }) => segment_id);
  // 16 windows of 6 plus one of 4 is exactly 100.
  const project = fake((input, index) => ({ projects: [{ name: "Payments", evidence_segment_ids: ids(input, index < 16 ? 6 : 4) }] }));
  const built = await buildTimedTeamMemMeetingArtifactV2(buildInput(meeting(45), project.runtime, { knownProjects: ["Payments"] }));
  assert.equal(built.artifact.projects[0]!.evidence_segment_ids.length, 100);
  // 16 windows of 29 plus one of 36 is exactly 500.
  const decisions = fake((input, index) => ({ decisions: Array.from({ length: index < 16 ? 29 : 36 }, (_, item) => ({ text: `Decision ${index}.${item}.`, evidence_segment_ids: [first(input)] })) }));
  const many = await buildTimedTeamMemMeetingArtifactV2(buildInput(meeting(45), decisions.runtime));
  assert.equal(many.artifact.decisions.length, 500);
});

test("a merge answer that repeats a person is retried, and the retry that does not builds", async () => {
  const { runtime, calls } = fake(() => ({}), (answer, call) => call === 0 ? { ...answer, person_summaries: [...answer.person_summaries, answer.person_summaries[0]!] } : answer);
  const built = await buildTimedTeamMemMeetingArtifactV2(buildInput(meeting(45), runtime));
  assert.equal(calls.length, 17 + 4 + 1);
  assert.deepEqual(built.artifact.person_summaries.map(({ person_id }) => person_id), [ada.person_id]);
});
