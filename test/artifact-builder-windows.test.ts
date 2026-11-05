import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { CLIENT_PROTOCOL_VERSION, validateClientCommand } from "@conversation/runtime";

import { buildTimedTeamMemMeetingArtifact, buildTimedTeamMemMeetingArtifactV2, MAX_PROCESSING_INPUT_BYTES, type TimedArtifactBuildInput } from "../src/delivery/artifact-builder.ts";
import type { ProcessTextRequest } from "../src/ports/conversation-runtime.ts";
import { buildInput, meeting, PEOPLE } from "./fixtures/long-meeting.ts";

// A long meeting is synthesized in windows because the Runtime refuses a
// processText input above its cap, and the window summaries are merged by the
// model in rounds (D047). The fake below admits a request exactly as the SDK
// client does (validateClientCommand), so a request the real Runtime would
// refuse is refused here too.

type WindowInput = { readonly known_projects: string[]; readonly transcript: { readonly segment_id: string; readonly speaker: { kind: string; person_id?: string } }[] };
type Person = { person_id: string; display_name: string; text: string };
type Part = { readonly first_window: number; readonly last_window: number; readonly summary: string; readonly person_summaries: Person[] };
type Answer = Record<string, unknown> & { summary: string; person_summaries: Person[] };

/** Answers each window with items citing only that window, plus one decision
 * every window repeats, and answers each reduce call with one summary naming
 * the windows it merged and one summary for each person its parts name. */
function sdkRuntime(options: {
  readonly cite?: (window: WindowInput, index: number) => string[];
  readonly summaryBytes?: number;
  readonly window?: (answer: Answer, window: WindowInput, index: number) => Answer;
  readonly reduce?: (answer: Answer, parts: readonly Part[], call: number) => Answer;
} = {}) {
  const calls: ProcessTextRequest[] = [];
  let windowCalls = 0, reduceCalls = 0;
  const runtime: TimedArtifactBuildInput["runtime"] = {
    async processText(request) {
      validateClientCommand({ type: "process_text", requestId: "fake", ...request }, CLIENT_PROTOCOL_VERSION);
      calls.push(request);
      const input = JSON.parse(request.input) as Record<string, unknown>;
      if (!("transcript" in input)) {
        const parts = input.parts as Part[];
        const people = new Map(parts.flatMap((part) => part.person_summaries.map((entry) => [entry.person_id, entry.display_name] as const)));
        const answer: Answer = { summary: `Merged ${parts.length} parts, windows ${parts[0]!.first_window}-${parts.at(-1)!.last_window}.`,
          person_summaries: [...people].map(([person_id, display_name]) => ({ person_id, display_name, text: `Merged view of ${display_name}.` })) };
        return { output: options.reduce?.(answer, parts, reduceCalls++) ?? answer, warnings: [] };
      }
      const window = input as WindowInput, index = windowCalls++, first = window.transcript[0]!.segment_id;
      const cited = options.cite?.(window, index) ?? [first];
      const named = [...new Set(window.transcript.flatMap(({ speaker }) => speaker.kind === "person" ? [speaker.person_id!] : []))];
      const answer: Answer = {
        summary: options.summaryBytes === undefined ? `Window starting at ${first}.` : `Window starting at ${first}. `.padEnd(options.summaryBytes, "detail "),
        projects: [{ name: "Payments", evidence_segment_ids: cited }],
        decisions: [{ text: `Decision near ${first}.`, evidence_segment_ids: cited }, { text: "Keep the weekly sync.", evidence_segment_ids: cited }],
        action_items: [{ text: `Follow up on ${first}.`, owner: null, due_date: null, evidence_segment_ids: cited }],
        discussion_points: [{ text: `Discussion near ${first}.`, evidence_segment_ids: cited }],
        person_summaries: named.map((id) => ({ person_id: id, display_name: PEOPLE.find((person) => person.id === id)!.name, text: `Window view of ${id}.` })),
      };
      return { output: options.window?.(answer, window, index) ?? answer, warnings: [] };
    },
  };
  return { runtime, calls };
}

const parsed = (call: ProcessTextRequest) => JSON.parse(call.input) as { transcript?: WindowInput["transcript"]; parts?: Part[] };
const windowIds = (calls: readonly ProcessTextRequest[]) => calls.filter((call) => parsed(call).transcript !== undefined)
  .map((call) => parsed(call).transcript!.map(({ segment_id }) => segment_id));
const reduceCalls = (calls: readonly ProcessTextRequest[]) => calls.filter((call) => parsed(call).parts !== undefined);
const reduceSpans = (calls: readonly ProcessTextRequest[]) => reduceCalls(calls)
  .map((call) => parsed(call).parts!.map(({ first_window, last_window }) => `${first_window}-${last_window}`));

test("the probed input cap is exactly where the installed SDK starts refusing", () => {
  const command = (bytes: number) => ({ type: "process_text" as const, requestId: "cap", sessionId: 1n, instructions: ".",
    input: ".".repeat(bytes), outputSchema: { type: "object" }, maxOutputBytes: 1 });
  assert.doesNotThrow(() => validateClientCommand(command(MAX_PROCESSING_INPUT_BYTES), CLIENT_PROTOCOL_VERSION));
  assert.throws(() => validateClientCommand(command(MAX_PROCESSING_INPUT_BYTES + 1), CLIENT_PROTOCOL_VERSION), /input exceeds/);
});

test("a 45-minute v2 meeting fits the Runtime input cap and its summaries are merged by the model in rounds", async () => {
  const segments = meeting(45);
  const { runtime, calls } = sdkRuntime();
  const built = await buildTimedTeamMemMeetingArtifactV2(buildInput(segments, runtime));
  const windows = windowIds(calls);
  assert.equal(windows.length, 17);
  // 17 window summaries are merged six at a time: three calls, then one.
  assert.deepEqual(reduceSpans(calls), [["1-1", "2-2", "3-3", "4-4", "5-5"], ["6-6", "7-7", "8-8", "9-9", "10-10", "11-11"],
    ["12-12", "13-13", "14-14", "15-15", "16-16", "17-17"], ["1-5", "6-11", "12-17"]]);
  assert.equal(calls.length, 17 + 4);
  assert.deepEqual(parsed(calls.at(-1)!).parts!.map(({ summary }) => summary),
    ["Merged 5 parts, windows 1-5.", "Merged 6 parts, windows 6-11.", "Merged 6 parts, windows 12-17."]);
  // Only the merges that are merged again are asked to stay short.
  for (const call of reduceCalls(calls).slice(0, 3)) assert.match(call.instructions, /merged again with the other parts: keep the summary and all person summaries together within 600 characters/);
  assert.doesNotMatch(calls.at(-1)!.instructions, /merged again|600 characters/);
  // Every stored segment is synthesized exactly once, in artifact order.
  assert.deepEqual(windows.flat(), built.artifact.transcript.map(({ segment_id }) => segment_id));
  assert.equal(windows.flat().length, segments.length);
  // A live entry and the final entry that observed the same speech share a window.
  for (let index = 0; index < segments.length / 2; index += 1) {
    assert.equal(windows.findIndex((ids) => ids.includes(`final-${index}`)), windows.findIndex((ids) => ids.includes(`live-${index}`)), `pair ${index}`);
  }
  for (const [index, call] of calls.slice(0, windows.length).entries()) {
    assert.match(call.instructions, new RegExp(`window ${index + 1} of ${windows.length}\\b.*within 600 characters\\.$`));
    assert.deepEqual(call.outputSchema, calls[0]!.outputSchema);
  }
  assert.equal(built.artifact.summary, "Merged 3 parts, windows 1-17.");
  assert.deepEqual(built.artifact.person_summaries, PEOPLE.map(({ id, name }) => ({ person_id: id, display_name: name, text: `Merged view of ${name}.` })));
  // Items are concatenated in window order; the decision every window repeats is merged once with every citation.
  assert.equal(built.artifact.decisions.length, windows.length + 1);
  assert.deepEqual(built.artifact.decisions.find(({ text }) => text === "Keep the weekly sync.")!.evidence_segment_ids, windows.map((ids) => ids[0]));
  assert.deepEqual(built.artifact.action_items.map(({ text }) => text), windows.map((ids) => `Follow up on ${ids[0]}.`));
  assert.deepEqual(built.artifact.projects, [{ name: "Payments", evidence_segment_ids: windows.map((ids) => ids[0]) }]);
  assert.deepEqual(built.artifact.processing_warnings.slice(-2), [
    { code: "synthesis_reduced", detail: "the 17 window summaries were merged by the model in 2 reduce round(s) of 3, 1 call(s)" },
    { code: "synthesis_windowed", detail: `transcript synthesized in 17 windows covering all ${segments.length} segments` },
  ]);
});

test("a single-window meeting makes exactly the one call it made before windowing, with the same artifact", async () => {
  const segments = meeting(1);
  const { runtime, calls } = sdkRuntime();
  const built = await buildTimedTeamMemMeetingArtifactV2(buildInput(segments, runtime, { knownProjects: ["Payments"] }));
  assert.equal(calls.length, 1);
  const request = calls[0]!;
  // Digests taken from the builder before windowing existed.
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  assert.equal(digest(request.instructions), "73b73eccf72c6517ff09f9664d0a5711f1a9522283962f2b2e7e576ac2f07d9f");
  assert.equal(digest(request.input), "a7d171bd89a49a4670c069518adcccf6602ed66dc9356969f5593098eb11b696");
  assert.equal(built.artifact_hash, "sha256:d57a42ed509da04b20668e50cdeb3d54cb128fac92f69eba010dbbdb840ad8c5");
});

test("a window that cites a segment outside itself is a visible build failure", async () => {
  const segments = meeting(45);
  const { runtime } = sdkRuntime({ cite: (window, index) => index === 1 ? ["final-0"] : [window.transcript[0]!.segment_id] });
  await assert.rejects(buildTimedTeamMemMeetingArtifactV2(buildInput(segments, runtime)), /window 2 of \d+ cites evidence_segment_ids outside the window/);
});

test("window summaries too large to merge are a visible build failure: nothing is joined or cut", async () => {
  const segments = meeting(45);
  const { runtime, calls } = sdkRuntime({ summaryBytes: 4_000 });
  await assert.rejects(buildTimedTeamMemMeetingArtifactV2(buildInput(segments, runtime)),
    /synthesis reduce round 1 of 2, windows 1-5: the summaries take \d+ bytes, over the Runtime text processing input cap of 16384/);
  assert.equal(calls.length, 17, "no reduce call is attempted with an input the Runtime refuses");
});

test("a transcript needing more calls than the ceiling fails before any call", async () => {
  const segments = meeting(85, { textBytes: 1_000 });
  assert.ok(segments.length <= 1280);
  const { runtime, calls } = sdkRuntime();
  await assert.rejects(buildTimedTeamMemMeetingArtifactV2(buildInput(segments, runtime)),
    /needs \d+ synthesis windows and \d+ reduce calls, up to \d+ calls with retries; at most 64 are allowed/);
  assert.equal(calls.length, 0);
});

test("one segment larger than the Runtime input cap fails before any call", async () => {
  const segments = meeting(1, { textBytes: 17_000, utteranceMs: 30_000 });
  const { runtime, calls } = sdkRuntime();
  await assert.rejects(buildTimedTeamMemMeetingArtifactV2(buildInput(segments, runtime)), /transcript segment \S+ alone exceeds the Runtime text processing input cap/);
  assert.equal(calls.length, 0);
});

test("a published project list that leaves no room for a segment says so, not that the segment is too large", async () => {
  const segments = meeting(1, { textBytes: 8_000, utteranceMs: 30_000 });
  const knownProjects = Array.from({ length: 60 }, (_, index) => `Project ${String(index).padStart(3, "0")} `.padEnd(150, "x"));
  const { runtime, calls } = sdkRuntime();
  await assert.rejects(buildTimedTeamMemMeetingArtifactV2(buildInput(segments, runtime, { knownProjects })),
    /^Error: the published project list \(60 names, \d+ bytes\) leaves no room for transcript segment live-0 under the Runtime text processing input cap of 16384 bytes$/);
  assert.equal(calls.length, 0);
});

test("a window's unpublished project is dropped wherever it cites, as from one window; a published one must cite its window", async () => {
  const segments = meeting(45);
  const outside = (window: WindowInput, index: number) => index === 1 ? ["final-0"] : [window.transcript[0]!.segment_id];
  // Only the project cites outside its window here; every other item cites in window.
  const projectOnly = () => sdkRuntime({ window: (answer, window, index) =>
    ({ ...answer, projects: [{ name: "Payments", evidence_segment_ids: outside(window, index) }] }) }).runtime;
  const dropped = await buildTimedTeamMemMeetingArtifactV2(buildInput(segments, projectOnly(), { knownProjects: ["Other"] }));
  assert.deepEqual(dropped.artifact.projects, []);
  assert.ok(dropped.artifact.processing_warnings.some(({ code, detail }) => code === "project_unassigned" && detail === "Payments"));
  const unreadable = await buildTimedTeamMemMeetingArtifactV2(buildInput(segments, projectOnly(), { knownProjects: null }));
  assert.deepEqual(unreadable.artifact.projects, []);
  await assert.rejects(buildTimedTeamMemMeetingArtifactV2(buildInput(segments, projectOnly(), { knownProjects: ["payments"] })),
    /window 2 of \d+ cites evidence_segment_ids outside the window/);
  await assert.rejects(buildTimedTeamMemMeetingArtifactV2(buildInput(segments, projectOnly())), /window 2 of \d+ cites evidence_segment_ids outside the window/);
});

test("every window carries each of its segments whole", async () => {
  const segments = meeting(45);
  const { runtime, calls } = sdkRuntime();
  const built = await buildTimedTeamMemMeetingArtifactV2(buildInput(segments, runtime));
  const sent = calls.flatMap((call) => (JSON.parse(call.input) as { transcript?: unknown[] }).transcript ?? []);
  const expected = built.artifact.transcript.map(({ segment_id, text, speaker, started_at, ended_at, provenance }) =>
    ({ segment_id, text, speaker, started_at, ended_at, provenance }));
  assert.deepEqual(sent, expected);
});

test("42 windows is the last meeting that builds, in three reduce rounds; 43 fails before any call", async () => {
  const sized = (utterances: number) => meeting(utterances * 8 / 60, { textBytes: 3_500 });
  const fits = sdkRuntime();
  const built = await buildTimedTeamMemMeetingArtifactV2(buildInput(sized(84), fits.runtime));
  assert.equal(windowIds(fits.calls).length, 42);
  // 42 summaries, then 7 merges, then 2, then 1: 52 calls, 62 if every merge were retried.
  assert.deepEqual(reduceSpans(fits.calls).map((spans) => spans.length), [6, 6, 6, 6, 6, 6, 6, 3, 4, 2]);
  assert.equal(fits.calls.length, 52);
  assert.equal(built.artifact.summary, "Merged 2 parts, windows 1-42.");
  assert.equal(built.artifact.processing_warnings.at(-2)!.detail, "the 42 window summaries were merged by the model in 3 reduce round(s) of 7, 2, 1 call(s)");
  const over = sdkRuntime();
  await assert.rejects(buildTimedTeamMemMeetingArtifactV2(buildInput(sized(86), over.runtime)),
    /needs 43 synthesis windows and 11 reduce calls, up to 65 calls with retries; at most 64 are allowed/);
  assert.equal(over.calls.length, 0);
});

test("each window is filled up to the cap counting the comma between entries, and never past it", async () => {
  // Short final-batch entries only, so none overlaps another and each window
  // ends where the next entry would not fit. Growing the first entry a byte at
  // a time walks every window's last fit across the cap, comma included.
  const base = meeting(10, { utteranceMs: 2_000 }).filter(({ segmentId }) => segmentId.startsWith("final-")).map((segment) => ({ ...segment, text: "Agreed." }));
  for (let pad = 0; pad <= 160; pad += 1) {
    const { runtime, calls } = sdkRuntime();
    await buildTimedTeamMemMeetingArtifact(buildInput([{ ...base[0]!, text: `Agreed${"!".repeat(pad)}.` }, ...base.slice(1)], runtime));
    const windows = calls.filter((call) => parsed(call).transcript !== undefined).map((call) => JSON.parse(call.input) as { transcript: unknown[] });
    assert.ok(windows.length > 1);
    for (const [index, input] of windows.slice(0, -1).entries()) {
      assert.ok(Buffer.byteLength(JSON.stringify({ ...input, transcript: [...input.transcript, windows[index + 1]!.transcript[0]] })) > MAX_PROCESSING_INPUT_BYTES,
        `pad ${pad}: window ${index + 1} is full`);
    }
  }
});

test("a merge answer that adds a person no window summarized is retried once, then a visible build failure", async () => {
  const stranger = { person_id: "ou_eve", display_name: "Eve Synthetic", text: "Invented." };
  const always = sdkRuntime({ reduce: (answer) => ({ ...answer, person_summaries: [...answer.person_summaries, stranger] }) });
  await assert.rejects(buildTimedTeamMemMeetingArtifactV2(buildInput(meeting(45), always.runtime)),
    /synthesis reduce round 1 of 2, windows 1-5: the answer did not return exactly the people the windows summarized/);
  assert.equal(reduceCalls(always.calls).length, 2);
  assert.match(reduceCalls(always.calls)[1]!.instructions, /An earlier answer to this request did not return exactly the people given\.$/);
  assert.equal(reduceCalls(always.calls)[1]!.input, reduceCalls(always.calls)[0]!.input);
  const once = sdkRuntime({ reduce: (answer, _parts, call) => call === 0 ? { ...answer, person_summaries: [...answer.person_summaries, stranger] } : answer });
  const built = await buildTimedTeamMemMeetingArtifactV2(buildInput(meeting(45), once.runtime));
  assert.equal(once.calls.length, 17 + 4 + 1);
  assert.deepEqual(built.artifact.person_summaries.map(({ person_id }) => person_id), ["ou_ada", "ou_ben"]);
});

test("a merge answer that drops or renames a person is retried once, then a visible build failure", async () => {
  const drop = (answer: Answer) => ({ ...answer, person_summaries: answer.person_summaries.filter(({ person_id }) => person_id !== "ou_ben") });
  const rename = (answer: Answer) => ({ ...answer, person_summaries: answer.person_summaries.map((entry) => ({ ...entry, display_name: `${entry.display_name} Jr` })) });
  for (const change of [drop, rename]) {
    const always = sdkRuntime({ reduce: change });
    await assert.rejects(buildTimedTeamMemMeetingArtifactV2(buildInput(meeting(45), always.runtime)), /did not return exactly the people the windows summarized/);
    assert.equal(reduceCalls(always.calls).length, 2);
  }
  // The final merge drops a person once; the retry keeps both.
  const once = sdkRuntime({ reduce: (answer, _parts, call) => call === 3 ? drop(answer) : answer });
  const built = await buildTimedTeamMemMeetingArtifactV2(buildInput(meeting(45), once.runtime));
  assert.equal(reduceCalls(once.calls).length, 5);
  assert.deepEqual(built.artifact.person_summaries.map(({ person_id }) => person_id), ["ou_ada", "ou_ben"]);
});

test("a merged list over 500 items is a visible build failure naming the field", async () => {
  const many = sdkRuntime({ window: (answer, window, index) => ({ ...answer, decisions: Array.from({ length: 30 }, (_, item) =>
    ({ text: `Decision ${index}.${item}.`, evidence_segment_ids: [window.transcript[0]!.segment_id] })) }) });
  await assert.rejects(buildTimedTeamMemMeetingArtifactV2(buildInput(meeting(45), many.runtime)), /^Error: merged synthesis decisions has 510 items; the artifact allows at most 500$/);
  assert.equal(reduceCalls(many.calls).length, 0, "the merge fails before any reduce call");
});

test("action items with the same text merge only when owner and due date match too: none is dropped", async () => {
  const due = (date: string) => ({ date, explicitly_stated: true as const });
  const ada = { person_id: PEOPLE[0].id, display_name: PEOPLE[0].name, explicitly_stated: true as const };
  const variants = [{ owner: null, due_date: due("2026-11-10") }, { owner: null, due_date: due("2026-11-17") }, { owner: ada, due_date: due("2026-11-10") },
    { owner: null, due_date: null }, { owner: null, due_date: due("2026-11-10") }];
  const { runtime, calls } = sdkRuntime({ window: (answer, window, index) => ({ ...answer, action_items: index < variants.length
    ? [{ text: "Ship the release.", ...variants[index]!, evidence_segment_ids: [window.transcript[0]!.segment_id] }] : [] }) });
  const built = await buildTimedTeamMemMeetingArtifactV2(buildInput(meeting(45), runtime));
  const windows = windowIds(calls);
  // Windows 1 and 5 agree on everything, so they merge; the other three differ in owner or due date and stay.
  assert.deepEqual(built.artifact.action_items.map(({ owner, due_date, evidence_segment_ids }) => [owner?.person_id ?? null, due_date?.date ?? null, evidence_segment_ids]), [
    [null, "2026-11-10", [windows[0]![0], windows[4]![0]]], [null, "2026-11-17", [windows[1]![0]]], [PEOPLE[0].id, "2026-11-10", [windows[2]![0]]], [null, null, [windows[3]![0]]]]);
});

const firstOf = (count: number) => (window: WindowInput) => window.transcript.slice(0, count).map(({ segment_id }) => segment_id);
/** What spreadEvidence keeps of seven IDs cited in each of the 17 windows: the
 * first 15 windows keep six, the last two keep five. */
const spreadOfSeven = (windows: readonly string[][]) => windows.flatMap((ids, index) => (index < 15 ? [0, 1, 2, 4, 5, 6] : [0, 2, 3, 4, 6]).map((at) => ids[at]!));

test("a merged item citing more than 100 evidence IDs keeps 100 spread across its windows, with a warning, in every list", async () => {
  const seven = firstOf(7);
  const repeated = (answer: Answer, window: WindowInput) => ({ ...answer,
    projects: [{ name: "payments", evidence_segment_ids: seven(window) }],
    decisions: [{ text: "Keep the weekly sync.", evidence_segment_ids: seven(window) }],
    action_items: [{ text: `Follow up on ${window.transcript[0]!.segment_id}.`, owner: null, due_date: null, evidence_segment_ids: [window.transcript[0]!.segment_id] },
      { text: "Send the notes.", owner: null, due_date: null, evidence_segment_ids: seven(window) }],
    discussion_points: [{ text: "The release plan.", evidence_segment_ids: seven(window) }] });
  const { runtime, calls } = sdkRuntime({ window: repeated });
  const built = await buildTimedTeamMemMeetingArtifactV2(buildInput(meeting(45), runtime, { knownProjects: ["Payments"] }));
  const windows = windowIds(calls), kept = spreadOfSeven(windows);
  assert.equal(windows.length, 17);
  assert.equal(calls.length, 17 + 4, "no extra model call");
  // The items, their names and their text stay; only the citations are thinned.
  assert.deepEqual(built.artifact.projects, [{ name: "Payments", evidence_segment_ids: kept }]);
  assert.deepEqual(built.artifact.decisions, [{ text: "Keep the weekly sync.", evidence_segment_ids: kept }]);
  assert.deepEqual(built.artifact.action_items.map(({ text }) => text), [`Follow up on ${windows[0]![0]}.`, "Send the notes.", ...windows.slice(1).map((ids) => `Follow up on ${ids[0]}.`)]);
  assert.deepEqual(built.artifact.action_items[1], { text: "Send the notes.", owner: null, due_date: null, evidence_segment_ids: kept });
  assert.deepEqual(built.artifact.discussion_points, [{ text: "The release plan.", evidence_segment_ids: kept }]);
  const order = new Map(built.artifact.transcript.map(({ segment_id }, index) => [segment_id, index]));
  assert.deepEqual(kept, [...kept].sort((a, b) => order.get(a)! - order.get(b)!), "in transcript order");
  const detail = (item: string) => `${item}: kept 100 of 119 evidence segment IDs, spread across the 17 windows that cite it`;
  assert.deepEqual(built.artifact.processing_warnings.slice(-6), [
    { code: "evidence_thinned", detail: detail('projects item "Payments"') },
    { code: "evidence_thinned", detail: detail("decisions item 1 of 1") },
    { code: "evidence_thinned", detail: detail("action_items item 2 of 18") },
    { code: "evidence_thinned", detail: detail("discussion_points item 1 of 1") },
    { code: "synthesis_reduced", detail: "the 17 window summaries were merged by the model in 2 reduce round(s) of 3, 1 call(s)" },
    { code: "synthesis_windowed", detail: "transcript synthesized in 17 windows covering all 674 segments" },
  ]);
});

test("a merged item citing exactly 100 evidence IDs keeps them all without a warning; 101 drops one", async () => {
  const exact = sdkRuntime({ cite: (window, index) => firstOf(index < 16 ? 6 : 4)(window) });
  const all = await buildTimedTeamMemMeetingArtifactV2(buildInput(meeting(45), exact.runtime, { knownProjects: ["Payments"] }));
  const windows = windowIds(exact.calls);
  assert.deepEqual(all.artifact.projects, [{ name: "Payments", evidence_segment_ids: windows.flatMap((ids, index) => ids.slice(0, index < 16 ? 6 : 4)) }]);
  assert.ok(!all.artifact.processing_warnings.some(({ code }) => code === "evidence_thinned"));
  const over = sdkRuntime({ cite: (window, index) => firstOf(index < 16 ? 6 : 5)(window) });
  const thinned = await buildTimedTeamMemMeetingArtifactV2(buildInput(meeting(45), over.runtime, { knownProjects: ["Payments"] }));
  // The last window keeps its 5; window 16 is the first the remainder does not reach and drops its third ID.
  const expected = windows.flatMap((ids, index) => index < 15 ? ids.slice(0, 6) : index === 15 ? [0, 1, 3, 4, 5].map((at) => ids[at]!) : ids.slice(0, 5));
  assert.deepEqual(thinned.artifact.projects, [{ name: "Payments", evidence_segment_ids: expected }]);
  assert.deepEqual(thinned.artifact.decisions.find(({ text }) => text === "Keep the weekly sync.")!.evidence_segment_ids, expected);
  assert.deepEqual(thinned.artifact.processing_warnings.filter(({ code }) => code === "evidence_thinned").map(({ detail }) => detail), [
    'projects item "Payments": kept 100 of 101 evidence segment IDs, spread across the 17 windows that cite it',
    "decisions item 2 of 18: kept 100 of 101 evidence segment IDs, spread across the 17 windows that cite it",
  ]);
  // An unpublished project is dropped whatever it cites, so it is neither thinned nor named.
  const unpublished = await buildTimedTeamMemMeetingArtifactV2(buildInput(meeting(45), sdkRuntime({ cite: firstOf(7) }).runtime, { knownProjects: ["Other"] }));
  assert.deepEqual(unpublished.artifact.projects, []);
  assert.ok(!unpublished.artifact.processing_warnings.some(({ detail }) => detail.startsWith("projects ")));
});

test("thinning warnings count toward the 500-warning bound: a build they would take past it is a visible failure", async () => {
  const thinnedDecisions = (count: number) => sdkRuntime({ window: (answer, window) => ({ ...answer,
    decisions: Array.from({ length: count }, (_, item) => ({ text: `Decision ${item}.`, evidence_segment_ids: firstOf(7)(window) })) }) }).runtime;
  const one = await buildTimedTeamMemMeetingArtifactV2(buildInput(meeting(45), thinnedDecisions(1)));
  const others = one.artifact.processing_warnings.length - 1;
  const full = await buildTimedTeamMemMeetingArtifactV2(buildInput(meeting(45), thinnedDecisions(500 - others)));
  assert.equal(full.artifact.processing_warnings.length, 500);
  assert.equal(full.artifact.processing_warnings.filter(({ code }) => code === "evidence_thinned").length, 500 - others);
  await assert.rejects(buildTimedTeamMemMeetingArtifactV2(buildInput(meeting(45), thinnedDecisions(501 - others))), /^Error: processing warning limit exceeded$/);
});

test("an item cited by only some windows is spread across those windows, and the warning counts only them", async () => {
  const citing = [0, 1, 2, 14, 15, 16];
  const { runtime, calls } = sdkRuntime({ window: (answer, window, index) => ({ ...answer,
    discussion_points: citing.includes(index) ? [{ text: "The release plan.", evidence_segment_ids: firstOf(20)(window) }] : [] }) });
  const built = await buildTimedTeamMemMeetingArtifactV2(buildInput(meeting(45), runtime));
  const windows = windowIds(calls);
  // Six citing windows of 20 share 100: 16 each, and the 4 left over go to the first four.
  const seventeen = [0, 1, 2, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 17, 18, 19], sixteen = [0, 1, 3, 4, 5, 6, 8, 9, 10, 11, 13, 14, 15, 16, 18, 19];
  const expected = citing.flatMap((index, order) => (order < 4 ? seventeen : sixteen).map((at) => windows[index]![at]!));
  assert.deepEqual(built.artifact.discussion_points, [{ text: "The release plan.", evidence_segment_ids: expected }]);
  assert.deepEqual(built.artifact.processing_warnings.filter(({ code }) => code === "evidence_thinned"), [{ code: "evidence_thinned",
    detail: "discussion_points item 1 of 1: kept 100 of 120 evidence segment IDs, spread across the 6 windows that cite it" }]);
});
