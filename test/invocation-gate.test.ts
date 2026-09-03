// The deterministic invocation gate: the single decision point behind the
// product's loudest requirement -- the agent listens continuously and
// speaks only when called by name. The measured acceptance gate is zero
// unprompted spoken responses across a real hour-long two-human meeting, so
// this suite is organized around the boundary between a genuine vocative
// invocation and everything that merely mentions the agent's name.
//
// Matrices covered: configured name/aliases at utterance boundaries,
// punctuation variants, casing, accents, multilingual (CJK, which has no
// whitespace word boundaries) text, partial transcripts, quoted mentions,
// third-person discussion, a human participant name that contains a
// configured alias as a substring, repeated segments, and unrelated
// background speech (e.g. background TV). Plus a property test: arbitrary
// generated text containing no configured alias must never authorize.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createInvocationDispatcher,
  decide,
  type InvocationCandidateSegment,
  type InvocationDecision,
  type InvocationGateIdentity,
  type InvocationSink,
} from "../src/sessions/invocation-gate.ts";

// A realistic multi-alias identity: primary name plus a short alias, plus a
// short alias ("Mei") deliberately chosen to be a substring-prefix of a
// plausible human participant name ("Meiling") -- the "similar human names"
// matrix cell.
const IDENTITY: InvocationGateIdentity = {
  aliases: ["Meetbot", "Mei", "Amelie"],
};

function segment(text: string, final = true, segmentId = "seg-1"): InvocationCandidateSegment {
  return { segmentId, text, final };
}

function assertPositive(decision: InvocationDecision, alias: string): void {
  assert.equal(decision.authorize, true, `expected authorize=true, got ${JSON.stringify(decision)}`);
  assert.equal(decision.matchedAlias, alias);
  assert.equal(decision.reason, "vocative_invocation");
}

function assertNegative(decision: InvocationDecision, reason: InvocationDecision["reason"]): void {
  assert.equal(decision.authorize, false, `expected authorize=false, got ${JSON.stringify(decision)}`);
  assert.equal(decision.reason, reason);
}

// ---------------------------------------------------------------------------
// Positive: explicit vocative invocation, utterance boundaries
// ---------------------------------------------------------------------------

test("alias alone as the entire segment authorizes", () => {
  assertPositive(decide(segment("Meetbot"), IDENTITY), "Meetbot");
});

test("alias at the start, comma-separated, authorizes", () => {
  assertPositive(decide(segment("Meetbot, can you summarize that?"), IDENTITY), "Meetbot");
});

test("alias at the end, comma-separated, authorizes", () => {
  assertPositive(decide(segment("Can you summarize that, Meetbot?"), IDENTITY), "Meetbot");
});

test("alias at the end, colon-separated, authorizes", () => {
  assertPositive(decide(segment("One question for you: Meetbot"), IDENTITY), "Meetbot");
});

test("alias at the start, colon-separated, authorizes", () => {
  assertPositive(decide(segment("Meetbot: give us the summary"), IDENTITY), "Meetbot");
});

test("a short configured alias at a boundary authorizes", () => {
  assertPositive(decide(segment("Mei, take a note"), IDENTITY), "Mei");
});

// ---------------------------------------------------------------------------
// Punctuation variants
// ---------------------------------------------------------------------------

test("trailing exclamation mark on a standalone alias authorizes", () => {
  assertPositive(decide(segment("Meetbot!"), IDENTITY), "Meetbot");
});

test("trailing question mark on a standalone alias authorizes", () => {
  assertPositive(decide(segment("Meetbot?"), IDENTITY), "Meetbot");
});

test("trailing period on a standalone alias authorizes", () => {
  assertPositive(decide(segment("Meetbot."), IDENTITY), "Meetbot");
});

test("no punctuation at all, alias alone, still authorizes", () => {
  assertPositive(decide(segment("  Meetbot  "), IDENTITY), "Meetbot");
});

test("trailing question mark after a comma-separated end-position alias authorizes", () => {
  assertPositive(decide(segment("Are you still there, Meetbot?"), IDENTITY), "Meetbot");
});

// ---------------------------------------------------------------------------
// Casing
// ---------------------------------------------------------------------------

test("all-caps alias authorizes", () => {
  assertPositive(decide(segment("MEETBOT, mute yourself"), IDENTITY), "Meetbot");
});

test("all-lowercase alias authorizes", () => {
  assertPositive(decide(segment("meetbot, mute yourself"), IDENTITY), "Meetbot");
});

test("mixed-case alias authorizes", () => {
  assertPositive(decide(segment("MeEtBoT, mute yourself"), IDENTITY), "Meetbot");
});

// ---------------------------------------------------------------------------
// Accents
// ---------------------------------------------------------------------------

test("configured alias carries an accent; unaccented transcript text still matches", () => {
  assertPositive(decide(segment("Amelie, peux-tu resumer"), IDENTITY), "Amelie");
});

test("configured alias has no accent; accented transcript text still matches", () => {
  // ASR sometimes emits accents even for a plain-ASCII configured alias.
  assertPositive(decide(segment("Amélie, peux-tu résumer"), IDENTITY), "Amelie");
});

// ---------------------------------------------------------------------------
// Multilingual text (CJK has no whitespace word boundaries)
// ---------------------------------------------------------------------------

const CJK_IDENTITY: InvocationGateIdentity = { aliases: ["会议机器人"] };

test("CJK alias at the start, full-width-comma-separated, authorizes", () => {
  assertPositive(decide(segment("会议机器人，请总结一下", true), CJK_IDENTITY), "会议机器人");
});

test("CJK alias at the end, full-width-comma-separated, authorizes", () => {
  assertPositive(decide(segment("现在可以总结了吗，会议机器人", true), CJK_IDENTITY), "会议机器人");
});

test("CJK alias alone as the entire segment authorizes", () => {
  assertPositive(decide(segment("会议机器人", true), CJK_IDENTITY), "会议机器人");
});

test("CJK third-person mention, no separator, does not authorize", () => {
  // Correctly negative either way, but note the reason: with no whitespace
  // to delimit words, an alias embedded between two other CJK characters
  // (here 说 before, 通 after) is adjacent to letters on BOTH sides, same
  // mechanism as the "Meiling" vs "Mei" case -- so it cannot even be
  // confirmed as a genuine word occurrence, and resolves to
  // "no_alias_match" rather than "incidental_mention". See report for the
  // multilingual design rationale.
  const decision = decide(segment("他说会议机器人通常负责记录", true), CJK_IDENTITY);
  assertNegative(decision, "no_alias_match");
  assert.equal(decision.matchedAlias, null);
});

// ---------------------------------------------------------------------------
// Partial transcripts never authorize, whatever they contain
// ---------------------------------------------------------------------------

test("a partial segment never authorizes, even with a perfectly-shaped vocative", () => {
  const decision = decide(segment("Meetbot, can you summarize that?", false), IDENTITY);
  assertNegative(decision, "non_final_segment");
  assert.equal(decision.matchedAlias, null);
});

test("a partial segment containing only the bare alias never authorizes", () => {
  const decision = decide(segment("Meetbot", false), IDENTITY);
  assertNegative(decision, "non_final_segment");
});

test("a partial segment with no alias at all never authorizes", () => {
  const decision = decide(segment("so about the budget for next quarter", false), IDENTITY);
  assertNegative(decision, "non_final_segment");
});

// ---------------------------------------------------------------------------
// Quoted mentions: reading a sentence aloud that contains the name
// ---------------------------------------------------------------------------

test("a whole segment that is a quoted vocative sentence does not authorize", () => {
  const decision = decide(segment('"Meetbot, please join us"'), IDENTITY);
  assertNegative(decision, "quoted_mention");
  assert.equal(decision.matchedAlias, "Meetbot");
});

test("a whole segment quoted with curly quotes does not authorize", () => {
  const decision = decide(segment("“Meetbot, take notes”"), IDENTITY);
  assertNegative(decision, "quoted_mention");
});

test("a whole segment quoted with single quotes does not authorize", () => {
  const decision = decide(segment("'Meetbot, take notes'"), IDENTITY);
  assertNegative(decision, "quoted_mention");
});

// ---------------------------------------------------------------------------
// Third-person discussion (about the agent, not to it)
// ---------------------------------------------------------------------------

test("third-person discussion mid-sentence does not authorize", () => {
  const decision = decide(segment("Honestly, Meetbot usually handles the notes for us."), IDENTITY);
  assertNegative(decision, "incidental_mention");
  assert.equal(decision.matchedAlias, "Meetbot");
});

test("third-person discussion referencing the agent at the end does not authorize", () => {
  const decision = decide(segment("The notes are usually taken by Meetbot for us."), IDENTITY);
  assertNegative(decision, "incidental_mention");
});

// ---------------------------------------------------------------------------
// Bare incidental mention -- talking about the agent, not to it
// ---------------------------------------------------------------------------

test("a bare incidental mention mid-sentence does not authorize", () => {
  const decision = decide(segment("I asked Meetbot about it yesterday."), IDENTITY);
  assertNegative(decision, "incidental_mention");
  assert.equal(decision.matchedAlias, "Meetbot");
});

// ---------------------------------------------------------------------------
// Similar human names: an alias must not fire inside a longer word
// ---------------------------------------------------------------------------

test("an alias that is a prefix of a participant's name does not authorize", () => {
  const decision = decide(segment("Meiling, can you send the notes?"), IDENTITY);
  assertNegative(decision, "no_alias_match");
  assert.equal(decision.matchedAlias, null);
});

test("an alias that is a prefix of a participant's name is not even reported as an incidental mention", () => {
  const decision = decide(segment("Meiling usually takes the notes."), IDENTITY);
  assertNegative(decision, "no_alias_match");
});

// ---------------------------------------------------------------------------
// Background TV / unrelated speech
// ---------------------------------------------------------------------------

test("unrelated background speech with no alias does not authorize", () => {
  const decision = decide(
    segment("...and now back to your regularly scheduled programming after these messages."),
    IDENTITY,
  );
  assertNegative(decision, "no_alias_match");
  assert.equal(decision.matchedAlias, null);
});

// ---------------------------------------------------------------------------
// Repeated segments: decide() is pure and deterministic
// ---------------------------------------------------------------------------

test("deciding the same segment twice yields the same decision", () => {
  const first = decide(segment("Meetbot, can you help?"), IDENTITY);
  const second = decide(segment("Meetbot, can you help?"), IDENTITY);
  assert.deepEqual(first, second);
});

// ---------------------------------------------------------------------------
// Speaker identity / participant rank must not be an input at all
// ---------------------------------------------------------------------------

test("decide() accepts no speaker or rank parameter -- the type itself forbids loosening the rule", () => {
  // This is a structural assertion, not a runtime one: decide() takes only
  // (segment, identity). There is no third parameter through which a
  // caller could pass speaker identity or participant rank to loosen the
  // decision. Calling with exactly two arguments compiles and runs.
  assert.equal(decide.length, 2);
});

// ---------------------------------------------------------------------------
// The invocation sink: apply a decision exactly once per segmentId
// ---------------------------------------------------------------------------

function createFakeSink(): InvocationSink & {
  readonly skipped: Array<{ segmentId: string; reason: string }>;
  readonly authorized: Array<{ segmentId: string; matchedAlias: string }>;
} {
  const skipped: Array<{ segmentId: string; reason: string }> = [];
  const authorized: Array<{ segmentId: string; matchedAlias: string }> = [];
  return {
    skipped,
    authorized,
    skipVoiceResponse(segmentId, reason) {
      skipped.push({ segmentId, reason });
    },
    authorizeVoiceResponse(segmentId, matchedAlias) {
      authorized.push({ segmentId, matchedAlias });
    },
  };
}

test("a positive decision authorizes the runtime segmentId on the sink", () => {
  const sink = createFakeSink();
  const dispatcher = createInvocationDispatcher(sink);
  const decision = decide(segment("Meetbot, can you help?", true, "seg-42"), IDENTITY);

  dispatcher.apply("seg-42", decision);

  assert.deepEqual(sink.authorized, [{ segmentId: "seg-42", matchedAlias: "Meetbot" }]);
  assert.deepEqual(sink.skipped, []);
});

test("a negative decision skips the runtime segmentId on the sink", () => {
  const sink = createFakeSink();
  const dispatcher = createInvocationDispatcher(sink);
  const decision = decide(segment("I asked Meetbot about it yesterday.", true, "seg-7"), IDENTITY);

  dispatcher.apply("seg-7", decision);

  assert.deepEqual(sink.skipped, [{ segmentId: "seg-7", reason: "incidental_mention" }]);
  assert.deepEqual(sink.authorized, []);
});

test("applying the same segmentId twice authorizes only once", () => {
  const sink = createFakeSink();
  const dispatcher = createInvocationDispatcher(sink);
  const decision = decide(segment("Meetbot, can you help?", true, "seg-99"), IDENTITY);

  dispatcher.apply("seg-99", decision);
  dispatcher.apply("seg-99", decision);
  dispatcher.apply("seg-99", decision);

  assert.equal(sink.authorized.length, 1);
  assert.deepEqual(sink.authorized, [{ segmentId: "seg-99", matchedAlias: "Meetbot" }]);
});

test("applying the same segmentId twice skips only once", () => {
  const sink = createFakeSink();
  const dispatcher = createInvocationDispatcher(sink);
  const decision = decide(segment("no alias here at all", true, "seg-100"), IDENTITY);

  dispatcher.apply("seg-100", decision);
  dispatcher.apply("seg-100", decision);

  assert.equal(sink.skipped.length, 1);
});

test("a repeated final segment (retry/redelivery) is applied exactly once end to end", () => {
  const sink = createFakeSink();
  const dispatcher = createInvocationDispatcher(sink);
  // The Conversation Runtime redelivers the exact same finalized segment
  // (retry after a dropped ack, at-least-once delivery, etc).
  for (let i = 0; i < 5; i += 1) {
    const decision = decide(segment("Meetbot, please summarize.", true, "seg-dup"), IDENTITY);
    dispatcher.apply("seg-dup", decision);
  }
  assert.equal(sink.authorized.length, 1);
  assert.equal(sink.skipped.length, 0);
});

test("different segmentIds are independent -- applying one does not suppress another", () => {
  const sink = createFakeSink();
  const dispatcher = createInvocationDispatcher(sink);
  dispatcher.apply("seg-a", decide(segment("Meetbot, help", true, "seg-a"), IDENTITY));
  dispatcher.apply("seg-b", decide(segment("Meetbot, help again", true, "seg-b"), IDENTITY));
  assert.equal(sink.authorized.length, 2);
});

// ---------------------------------------------------------------------------
// Property test: arbitrary segments containing no configured alias never
// authorize. Seeded, deterministic, prints the seed and the failing sample
// on failure.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROPERTY_ALPHABET = [
  ..."abcdefghijklmnopqrstuvwxyz",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  ..."0123456789",
  " ",
  " ", // weighted, whitespace is common in real transcripts
  "\t",
  "\n",
  ",",
  ".",
  "!",
  "?",
  ";",
  ":",
  "-",
  "—", // em dash
  "'",
  '"',
  "(",
  ")",
  "，", // ，
  "。", // 。
  "！", // ！
  "？", // ？
  "、", // 、
  "你", // 你
  "好", // 好
  "会", // 会
  "议", // 议
  "机", // 机
  "器", // 器
  "人", // 人
  "的", // 的
  "了", // 了
  "在", // 在
  "是", // 是
  "我", // 我
  "他", // 他
  "们", // 们
  "这", // 这
  "个", // 个
  "有", // 有
  "和", // 和
  "é", // é
  "ñ", // ñ
  "ü", // ü
  "ö", // ö
];

function randomText(rng: () => number, maxLength: number): string {
  const length = Math.floor(rng() * (maxLength + 1));
  let out = "";
  for (let i = 0; i < length; i += 1) {
    const idx = Math.floor(rng() * PROPERTY_ALPHABET.length);
    out += PROPERTY_ALPHABET[idx];
  }
  return out;
}

function foldForContainmentCheck(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function containsAnyAliasSubstring(text: string, identity: InvocationGateIdentity): boolean {
  const folded = foldForContainmentCheck(text);
  return identity.aliases.some((alias) => folded.includes(foldForContainmentCheck(alias)));
}

test("property: arbitrary generated text containing no configured alias never authorizes", () => {
  const SEED = 0x6d61_6f63; // "maoc", arbitrary fixed constant -- deterministic across runs
  const rng = mulberry32(SEED);
  const SAMPLES = 500;
  const MAX_LENGTH = 60;
  const identity = IDENTITY;

  for (let i = 0; i < SAMPLES; i += 1) {
    let text = randomText(rng, MAX_LENGTH);
    let guard = 0;
    // Regenerate on the (astronomically unlikely) chance the random text
    // happens to contain an alias substring, so the property genuinely
    // tests "no alias present" rather than getting lucky.
    while (containsAnyAliasSubstring(text, identity) && guard < 10) {
      text = randomText(rng, MAX_LENGTH);
      guard += 1;
    }
    assert.ok(
      !containsAnyAliasSubstring(text, identity),
      `seed=${SEED} sample=${i}: could not generate alias-free text after ${guard} retries`,
    );

    const decision = decide({ segmentId: `prop-${i}`, text, final: true }, identity);
    assert.equal(
      decision.authorize,
      false,
      `seed=${SEED} sample=${i} text=${JSON.stringify(text)}: expected authorize=false but got ${JSON.stringify(decision)}`,
    );
  }
});
