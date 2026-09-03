// The deterministic invocation gate: the single decision point behind the
// product's loudest requirement -- the agent listens continuously and
// speaks only when called by name. The measured acceptance gate is zero
// unprompted spoken responses across a real hour-long two-human meeting, so
// this suite is organized around the boundary between a genuine vocative
// invocation and everything that merely mentions the agent's name.
//
// ROUND 5 (R43) is the current rule: a clause beside the alias is an
// address only if it is a REQUEST -- interrogative ("?"/"？"), or opening
// with an explicit request marker ("please", "kindly", "请", "麻烦",
// "帮我"). The address-cue lexicon rounds 2-4 used (wh-words, modals, and a
// growing anti-cue list of exclamative idioms in front of it) is deleted:
// English exclamatives share their opening word with questions, so the
// opening word was never the signal, and each round found a fresh crop of
// counter-examples. The separator requirement (R41) and the anti-cue list
// survive as outer guards -- see the tests named for each.
//
// Rounds 2-4 (still pinned below): the matcher must not fire inside
// hyphenated names/identifiers ("Mei-Ling", "Meetbot-api", "eng-meetbot")
// or possessives ("Mei's"), must not treat an appositive or agenda label
// as an address ("Meetbot, the note taker, is broken again.",
// "Agenda: Meetbot"), and must not accept a cue-shaped word that merely
// appears somewhere in the segment.
//
// Matrices covered: configured name/aliases at utterance boundaries,
// punctuation variants, casing, accents, multilingual (CJK, which has no
// whitespace word boundaries) text, partial transcripts, quoted mentions,
// third-person discussion, appositive/agenda-style mentions, hyphenated
// names/identifiers containing an alias as a substring, a human participant
// name that contains a configured alias as a substring, leading-filler
// address ("Hey Meetbot, ..."), repeated segments, unrelated background
// speech, and a documented known-limitation case. Plus two property tests.

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

test("alias at the start, comma-separated, with an address cue, authorizes", () => {
  assertPositive(decide(segment("Meetbot, can you summarize that?"), IDENTITY), "Meetbot");
});

test("alias at the end, comma-separated, with an address cue, authorizes", () => {
  assertPositive(decide(segment("Can you summarize that, Meetbot?"), IDENTITY), "Meetbot");
});

test("alias at the start, colon-separated, with an address cue, authorizes", () => {
  assertPositive(decide(segment("Meetbot: can you summarize?"), IDENTITY), "Meetbot");
});

test("a short configured alias at a boundary, with an address cue, authorizes", () => {
  assertPositive(decide(segment("Mei, can you take a note?"), IDENTITY), "Mei");
});

test("KNOWN LIMITATION (R41): no separator at all, even with a leading cue word, does not authorize", () => {
  // Round 2/3 treated this as a required positive (whitespace as the
  // boundary, the cue word "what" as the sole disambiguator). Round 4's
  // R41 ruling removed that path entirely: two rounds of false positives
  // both traced back to "alias directly touching more text with only a
  // cue-lexicon check standing between that and authorize" -- exactly
  // this shape. A real separator (comma/colon) is now mandatory before a
  // cue lookup is even attempted, so this segment -- structurally
  // identical in shape to the pinned negative "Meetbot usually handles
  // the notes." -- is deliberately, structurally negative now too.
  const decision = decide(segment("Meetbot what did we decide"), IDENTITY);
  assertNegative(decision, "incidental_mention");
  assert.equal(decision.matchedAlias, "Meetbot");
});

test("R41 is still load-bearing at the START under R43: no separator, even with an interrogative clause", () => {
  // R43 made most of the old no-separator false positives negative for a
  // second, independent reason (they are not requests). These two are not:
  // both are genuine interrogatives, so ONLY the separator requirement
  // keeps them out. Without this test, deleting R41's leading-position
  // check would break nothing else in the suite.
  assertNegative(decide(segment("Meetbot what did we decide?"), IDENTITY), "incidental_mention");
  assertNegative(decide(segment("Meetbot can you summarize?"), IDENTITY), "incidental_mention");
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

test("trailing question mark after a comma-separated end-position alias with a cue authorizes", () => {
  assertPositive(decide(segment("Can you still hear us, Meetbot?"), IDENTITY), "Meetbot");
});

// ---------------------------------------------------------------------------
// Casing
// ---------------------------------------------------------------------------

test("all-caps alias authorizes", () => {
  assertPositive(decide(segment("MEETBOT, can you mute yourself?"), IDENTITY), "Meetbot");
});

test("all-lowercase alias authorizes", () => {
  assertPositive(decide(segment("meetbot, can you mute yourself?"), IDENTITY), "Meetbot");
});

test("mixed-case alias authorizes", () => {
  assertPositive(decide(segment("MeEtBoT, can you mute yourself?"), IDENTITY), "Meetbot");
});

// ---------------------------------------------------------------------------
// Accents
// ---------------------------------------------------------------------------

test("configured alias carries an accent; unaccented transcript text still matches", () => {
  const accentIdentity: InvocationGateIdentity = { aliases: ["Amélie"] };
  assertPositive(decide(segment("Amelie, can you help us?"), accentIdentity), "Amélie");
});

test("configured alias has no accent; accented transcript text still matches", () => {
  // ASR sometimes emits accents even for a plain-ASCII configured alias.
  assertPositive(decide(segment("Amélie, can you help us?"), IDENTITY), "Amelie");
});

// ---------------------------------------------------------------------------
// Leading fillers: "Hey Meetbot, ..." must not be defeated by the filler word
// ---------------------------------------------------------------------------

test("a leading 'Hey' filler before the alias does not defeat the start boundary", () => {
  assertPositive(decide(segment("Hey Meetbot, can you summarize?"), IDENTITY), "Meetbot");
});

test("a leading 'So,' filler before the alias does not defeat the start boundary", () => {
  assertPositive(decide(segment("So, Meetbot, can you summarize?"), IDENTITY), "Meetbot");
});

test("a leading 'OK' filler before the alias does not defeat the start boundary", () => {
  assertPositive(decide(segment("OK Meetbot, what did we decide?"), IDENTITY), "Meetbot");
});

// ---------------------------------------------------------------------------
// Multilingual text (CJK has no whitespace word boundaries)
// ---------------------------------------------------------------------------

const CJK_IDENTITY: InvocationGateIdentity = { aliases: ["会议机器人"] };

test("CJK alias at the start, full-width-comma-separated, with a request marker, authorizes", () => {
  assertPositive(decide(segment("会议机器人，请总结一下", true), CJK_IDENTITY), "会议机器人");
});

test("CJK alias at the end, full-width-comma-separated, with a request marker, authorizes", () => {
  assertPositive(decide(segment("请总结一下，会议机器人", true), CJK_IDENTITY), "会议机器人");
});

test("KNOWN LIMITATION (R43, CJK): a marker-free Chinese question does not authorize", () => {
  // Round 4 authorized this through the cue "可以" ("can"). R43 deletes the
  // cue lexicon, and round 5's Han carve-out (see clauseIsRequest) does not
  // let interrogative punctuation stand in for a marker in Chinese either,
  // because Chinese topic-comment fronting ("会议机器人，是不是又坏了？" --
  // a question ABOUT the agent) is structurally identical to a vocative
  // question. A Chinese request must say 请 / 麻烦 / 帮我, or the operator
  // adds their own marker via additionalRequestMarkers. Documented false
  // negative, per the zero-tolerance-on-false-positives rule.
  assertNegative(decide(segment("可以总结了吗，会议机器人", true), CJK_IDENTITY), "incidental_mention");
  assertNegative(decide(segment("会议机器人，能总结一下吗？", true), CJK_IDENTITY), "incidental_mention");
});

test("KNOWN LIMITATION (R43, CJK): the operator's own marker restores a marker-free phrasing", () => {
  const extended: InvocationGateIdentity = {
    ...CJK_IDENTITY,
    additionalRequestMarkers: ["能"],
  };
  assertPositive(decide(segment("会议机器人，能总结一下吗？", true), extended), "会议机器人");
});

test("CJK alias alone as the entire segment authorizes", () => {
  assertPositive(decide(segment("会议机器人", true), CJK_IDENTITY), "会议机器人");
});

test("KNOWN LIMITATION (R41, CJK): no separator at all does not authorize, even with a would-be cue prefix", () => {
  // Round 3 special-cased this authorize via the cue "总结" (since
  // removed from the default lexicon -- it existed only for this case).
  // R41 removes the whole no-separator path uniformly for both scripts:
  // Chinese has no whitespace to mark a boundary the way English does, so
  // "the next character is a letter" was never a meaningful signal here
  // in the first place -- exactly why round 4 requires a real separator
  // instead. This single change is also what makes an entire class of
  // Chinese false positives (ordinary declarative sentences with the
  // alias as subject and no comma after it) structurally unreachable --
  // see the CJK declarative fixtures in the acceptance matrix below.
  const decision = decide(segment("会议机器人总结一下", true), CJK_IDENTITY);
  assertNegative(decision, "incidental_mention");
  assert.equal(decision.matchedAlias, "会议机器人");
});

test("CJK third-person mention, no separator, no cue in the following clause, does not authorize", () => {
  // The alias's text IS present (round 3: matchedAlias/reason for the
  // negative fallback come from a plain, no-adjacency-guard substring
  // check -- see module doc point 5), it just never opens the adjoining
  // clause with a recognized cue ("今天" comes first, not a cue).
  const decision = decide(segment("会议机器人今天没来", true), CJK_IDENTITY);
  assertNegative(decision, "incidental_mention");
  assert.equal(decision.matchedAlias, "会议机器人");
});

test("CJK third-person mention, embedded mid-sentence, does not authorize", () => {
  // The alias's text is embedded between two other CJK characters (说
  // before, 通 after) with no whitespace to delimit words -- structurally
  // never a boundary candidate for authorize purposes -- but round 3's
  // diagnostic fallback (a plain substring check with no adjacency guard)
  // still surfaces that the text WAS present, matching this module's own
  // stated goal ("an operator debugging 'why did it not answer me' needs
  // to see that the name WAS heard, just not addressed").
  const decision = decide(segment("他说会议机器人通常负责记录", true), CJK_IDENTITY);
  assertNegative(decision, "incidental_mention");
  assert.equal(decision.matchedAlias, "会议机器人");
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
// Bare incidental mention -- talking about the agent, not to it
// ---------------------------------------------------------------------------

test("a bare incidental mention mid-sentence does not authorize", () => {
  const decision = decide(segment("I asked Meetbot about it yesterday."), IDENTITY);
  assertNegative(decision, "incidental_mention");
  assert.equal(decision.matchedAlias, "Meetbot");
});

// ---------------------------------------------------------------------------
// ROUND 3, Critical 1: the cue must be BOUNDED to the clause immediately
// adjoining the alias, and must OPEN it -- not merely appear anywhere in
// the (unbounded) rest of the segment. Every fixture below is a confirmed
// round-2 false positive, reproduced directly against the round-2 source
// before this fix, per the second review.
// ---------------------------------------------------------------------------

test("ROUND 3 Critical 1: a cue word deep in the sentence does not authorize (reported speech)", () => {
  const decision = decide(segment("Meetbot said he can help with that."), IDENTITY);
  assertNegative(decision, "incidental_mention");
  assert.equal(decision.matchedAlias, "Meetbot");
});

test("ROUND 3 Critical 1: a cue word deep in the sentence does not authorize (reported intent)", () => {
  const decision = decide(segment("Meetbot mentioned he will join later."), IDENTITY);
  assertNegative(decision, "incidental_mention");
});

test("ROUND 3 Critical 1: a cue word past the first clause boundary does not authorize", () => {
  // The comma after "it" truncates the adjoining clause to "broke it" --
  // "will" (in the second clause) is never reached.
  const decision = decide(segment("Meetbot broke it, and honestly nobody will fix it."), IDENTITY);
  assertNegative(decision, "incidental_mention");
});

test("ROUND 3 Critical 1: a leading cue word addressing a THIRD PARTY about the agent does not authorize", () => {
  // "Please" opens the clause, but the alias is the OBJECT of "blame", not
  // an addressee -- there is no separator before "Meetbot" at all, so the
  // mandatory-trailing-separator rule (module doc point 3) rejects this
  // before the cue check even runs.
  const decision = decide(segment("Please don't blame Meetbot."), IDENTITY);
  assertNegative(decision, "incidental_mention");
});

test("ROUND 3 Critical 1: an appositive with a non-copula verb past the first comma still does not authorize", () => {
  // Same appositive shape as the pinned "Meetbot, the note taker, is
  // broken again." fixture, with "is" swapped for "did" specifically to
  // bypass the copula exclusion list -- the fix here is scope (the first
  // comma truncates the clause to "the note taker", so "did" is never
  // reached), not vocabulary.
  const decision = decide(segment("Meetbot, the note taker, did leave early."), IDENTITY);
  assertNegative(decision, "incidental_mention");
});

test("ROUND 3 Critical 1 (CJK): a cue word deep in the sentence does not authorize", () => {
  const decision = decide(segment("会议机器人说他可以处理这个问题", true), CJK_IDENTITY);
  assertNegative(decision, "incidental_mention");
  assert.equal(decision.matchedAlias, "会议机器人");
});

test("ROUND 3 Critical 1 (CJK): a cue word not at the very start of the clause does not authorize", () => {
  // "什么" (a cue) appears in the clause, but "今天" opens it -- the Han
  // check is a strict PREFIX test, not "contains anywhere".
  const decision = decide(segment("会议机器人今天什么都没做", true), CJK_IDENTITY);
  assertNegative(decision, "incidental_mention");
});

// ---------------------------------------------------------------------------
// ROUND 3, Critical 2: the apostrophe (straight and typographic) is now a
// word-continuation character, so a possessive does not authorize -- same
// mechanism as the hyphen fix, same false-positive class ("Mei" recurring
// inside "Mei's", the brief's own headline scenario).
// ---------------------------------------------------------------------------

test("ROUND 3 Critical 2: a possessive using a short alias does not authorize", () => {
  const decision = decide(segment("Mei's phone is ringing, can someone check?"), IDENTITY);
  assertNegative(decision, "incidental_mention");
  assert.equal(decision.matchedAlias, "Mei");
});

test("ROUND 3 Critical 2: a possessive using the primary alias does not authorize", () => {
  const decision = decide(segment("Meetbot's log shows what happened."), IDENTITY);
  assertNegative(decision, "incidental_mention");
  assert.equal(decision.matchedAlias, "Meetbot");
});

test("ROUND 3 Critical 2: a possessive with a typographic (curly) apostrophe does not authorize", () => {
  const decision = decide(segment("Meetbot\u2019s log shows what happened."), IDENTITY);
  assertNegative(decision, "incidental_mention");
});

// ---------------------------------------------------------------------------
// ROUND 5 (R43): questions open however a speaker likes. Round 3 needed a
// special case so that a wh-word CONTRACTION ("what's") still matched the
// cue "what"; R43 deletes the cue lexicon and with it that special case --
// what makes these questions is the question mark, so a contraction, a
// missing apostrophe, and an ASR misspelling all behave the same.
// ---------------------------------------------------------------------------

test("a wh-word contraction opens a question and authorizes", () => {
  assertPositive(decide(segment("Meetbot: what's the plan?"), IDENTITY), "Meetbot");
});

test("a different wh-word contraction opens a question and authorizes", () => {
  assertPositive(decide(segment("Meetbot, who's next?"), IDENTITY), "Meetbot");
});

test("an ASR misspelling of the same question still authorizes -- punctuation, not vocabulary, decides", () => {
  // Round 3/4 rejected this (the token "whats" was not in the cue list).
  // Under R43 the missing apostrophe is irrelevant: the clause ends in a
  // question mark, so it is a request.
  assertPositive(decide(segment("Meetbot: whats the plan?"), IDENTITY), "Meetbot");
});

// ---------------------------------------------------------------------------
// ROUND 3: a trailing mention needs a REAL separator, not just whitespace
// ---------------------------------------------------------------------------

test("ROUND 3: a trailing mention with only whitespace before it (no comma) does not authorize", () => {
  // Contrast with the required positive "Can you take a note, Meetbot?",
  // which has a comma. Word-adjacency alone is too weak a signal at the
  // END of an utterance -- the name is at least as likely to be a
  // grammatical object as an addressee.
  const decision = decide(segment("I will ask Meetbot"), IDENTITY);
  assertNegative(decision, "incidental_mention");
});

// ---------------------------------------------------------------------------
// ROUND 4, Critical: exclamatory idioms open with an ordinary cue word but
// are never a genuine address -- checked via a closed anti-cue list,
// BEFORE the cue list, in both leading and trailing positions. Every
// fixture below is a confirmed round-3 false positive, reproduced
// directly against the round-3 source by the third review.
// ---------------------------------------------------------------------------

test("ROUND 4: an exclamatory 'what a' idiom does not authorize (leading)", () => {
  const decision = decide(segment("Meetbot, what a mess."), IDENTITY);
  assertNegative(decision, "incidental_mention");
});

test("ROUND 4: an exclamatory 'what a' idiom does not authorize (a different noun)", () => {
  const decision = decide(segment("Meetbot, what a day."), IDENTITY);
  assertNegative(decision, "incidental_mention");
});

test("ROUND 4: an exclamatory 'how about' idiom does not authorize", () => {
  const decision = decide(segment("Meetbot, how about that game last night."), IDENTITY);
  assertNegative(decision, "incidental_mention");
});

test("ROUND 4: an exclamatory 'how dare' idiom does not authorize", () => {
  const decision = decide(segment("Meetbot, how dare you."), IDENTITY);
  assertNegative(decision, "incidental_mention");
});

test("ROUND 4: an exclamatory 'why me' idiom does not authorize", () => {
  const decision = decide(segment("Meetbot, why me."), IDENTITY);
  assertNegative(decision, "incidental_mention");
});

test("ROUND 4: an exclamatory 'do tell' idiom does not authorize (checked before the 'do' cue)", () => {
  // "do" alone is a recognized cue -- the anti-cue check must run FIRST,
  // or this would incorrectly authorize.
  const decision = decide(segment("Meetbot, do tell."), IDENTITY);
  assertNegative(decision, "incidental_mention");
});

test("ROUND 4: an exclamatory 'what a' idiom does not authorize (trailing position)", () => {
  const decision = decide(segment("What a mess, Meetbot."), IDENTITY);
  assertNegative(decision, "incidental_mention");
});

test("ROUND 4: an exclamatory 'would you look at that' idiom does not authorize (checked before the 'would' cue)", () => {
  const decision = decide(segment("Meetbot, would you look at that."), IDENTITY);
  assertNegative(decision, "incidental_mention");
});

test("ROUND 4 adversarial finding (fixed): a genuine 'would you look into X' request still authorizes", () => {
  // Found during this round's own adversarial pass: the reviewer's named
  // anti-cue was the bare phrase "would you look", which also swallowed a
  // real request. Narrowed to the full idiom "would you look at that" --
  // this is what proves the narrowing actually fixed the collateral
  // damage rather than just moving it.
  assertPositive(decide(segment("Meetbot, would you look into this bug?"), IDENTITY), "Meetbot");
  assertPositive(decide(segment("Meetbot, would you look over the report?"), IDENTITY), "Meetbot");
});

test("ROUND 4 adversarial finding (fixed, CJK): exclamatory slang starting with the '什么' cue does not authorize", () => {
  // Found during this round's own adversarial pass, not named by the
  // review: the same anti-cue bug class as "what a mess", but in Chinese.
  // Neither "什么鬼" nor "什么玩意" has a literal-question reading in
  // ordinary usage -- both are unambiguous exclamatory slang.
  assertNegative(decide(segment("会议机器人，什么鬼", true), CJK_IDENTITY), "incidental_mention");
  assertNegative(decide(segment("会议机器人，什么玩意", true), CJK_IDENTITY), "incidental_mention");
});

test("ROUND 5 (R43) corrects a round-4 claim: '什么都行' is not a request and no longer authorizes", () => {
  // Round 4 pinned this as a POSITIVE, on the argument that the cue "什么"
  // fired for a genuine question. That was wrong on its own terms:
  // "什么都行" means "anything works" -- a statement, not a question and
  // not a request. R43 rejects it, which is the correct outcome, and this
  // test now pins the correction rather than the earlier claim.
  assertNegative(decide(segment("会议机器人，什么都行", true), CJK_IDENTITY), "incidental_mention");
});

test("ROUND 5 (R43): the Chinese anti-cues match as a raw prefix, so a trailing particle does not escape them", () => {
  // Round 4 matched anti-cues with a Latin word boundary, so "什么鬼啊"
  // (the same slang with an exclamative particle) slipped past the "什么鬼"
  // entry. clauseStartsWithPhrase now uses a raw prefix for a Han phrase.
  assertNegative(decide(segment("会议机器人，什么鬼啊？", true), CJK_IDENTITY), "incidental_mention");
});

test("ROUND 4: the anti-cue phrase must be a whole phrase, not a bare string prefix", () => {
  // "what another day" is NOT the anti-cue idiom "what a" -- "another" is
  // a different, real word. clauseStartsWithPhrase requires a word
  // boundary after the phrase, not merely a character-level prefix match.
  // ("what" is still a recognized cue, so this authorizes.)
  assertPositive(decide(segment("Meetbot, what another day looks like?"), IDENTITY), "Meetbot");
});

test("additionalAntiCues extends (not replaces) the default anti-cue lexicon", () => {
  // The question mark is what would authorize this one -- an anti-cue is
  // the only thing that can still suppress it, which is exactly the job
  // the list has left under R43.
  const baselineWithoutExtension = decide(segment("Meetbot, can we not do this today?"), IDENTITY);
  assertPositive(baselineWithoutExtension, "Meetbot");

  const extended: InvocationGateIdentity = {
    ...IDENTITY,
    additionalAntiCues: ["can we not"],
  };
  assertNegative(decide(segment("Meetbot, can we not do this today?"), extended), "incidental_mention");

  // The built-in anti-cues still work under the extended identity too.
  assertNegative(decide(segment("Meetbot, what a mess?", true), extended), "incidental_mention");
});

// ---------------------------------------------------------------------------
// ROUND 4 (R41): Chinese declarative sentences -- the alias as subject with
// no separator after it -- are structurally unreachable now, regardless of
// what cue-shaped words appear later in the sentence. Every fixture below
// is a confirmed round-3 false positive.
// ---------------------------------------------------------------------------

test("ROUND 4 (R41, CJK): a declarative sentence with the alias as subject does not authorize", () => {
  const decision = decide(segment("会议机器人可以处理很多任务", true), CJK_IDENTITY);
  assertNegative(decision, "incidental_mention");
});

test("ROUND 4 (R41, CJK): a declarative sentence using the (now removed) '一下' cue does not authorize", () => {
  const decision = decide(segment("会议机器人一下就修好了", true), CJK_IDENTITY);
  assertNegative(decision, "incidental_mention");
});

test("ROUND 4 (R41, CJK): the idiom '总结起来' (in summary) does not authorize -- '总结' cue was removed", () => {
  const decision = decide(segment("会议机器人总结起来都是问题", true), CJK_IDENTITY);
  assertNegative(decision, "incidental_mention");
});

test("ROUND 4 (R41, CJK): a rhetorical '怎么' question about the agent does not authorize", () => {
  const decision = decide(segment("会议机器人怎么老是这样", true), CJK_IDENTITY);
  assertNegative(decision, "incidental_mention");
});

test("ROUND 4 (R41, CJK): a '为什么' question about the agent, not to it, does not authorize", () => {
  const decision = decide(segment("会议机器人为什么大家都在讨论它", true), CJK_IDENTITY);
  assertNegative(decision, "incidental_mention");
});

test("ROUND 4 (R41, CJK): even WITH a comma, the idiom '总结起来' does not authorize -- '总结' cue removal verified directly", () => {
  // This is the fixture the second review named specifically: with the
  // separator present, only the removal of "总结" from the default cue
  // list prevents this from authorizing (R41's separator requirement
  // alone would not have caught it, since a real comma IS present here).
  const decision = decide(segment("会议机器人，总结起来都是问题", true), CJK_IDENTITY);
  assertNegative(decision, "incidental_mention");
});

// ---------------------------------------------------------------------------
// ROUND 5 (R43): the request test itself. The address-cue lexicon is gone;
// a clause beside the alias is an address only if it is a REQUEST --
// interrogative, or opening with an explicit request marker.
// ---------------------------------------------------------------------------

test("R43: an interrogative clause after the alias authorizes", () => {
  assertPositive(decide(segment("Meetbot, did you catch that?"), IDENTITY), "Meetbot");
});

test("R43: the SAME clause without the question mark does not authorize", () => {
  // The whole point of the redesign in one pair: nothing about the words
  // changed, only the punctuation that makes it a request. ("did" was a
  // recognized cue word in round 4, so this authorized then.)
  assertNegative(decide(segment("Meetbot, did you catch that."), IDENTITY), "incidental_mention");
});

test("R43: a full-width question mark counts", () => {
  const mixed: InvocationGateIdentity = { aliases: ["Meetbot"] };
  assertPositive(decide(segment("Meetbot, can you summarize？"), mixed), "Meetbot");
});

test("R43: the question mark must terminate the ADJOINING clause, not merely appear later", () => {
  // "the note taker" is the clause beside the alias and it ends at the
  // comma; the question mark belongs to a later clause and cannot reach
  // back. This is what keeps an appositive negative even when the sentence
  // it sits in happens to be a question.
  assertNegative(decide(segment("Meetbot, the note taker, did anyone configure it?"), IDENTITY), "incidental_mention");
});

test("R43: a request marker authorizes without any question mark", () => {
  assertPositive(decide(segment("Meetbot, kindly send the notes."), IDENTITY), "Meetbot");
});

test("R43: the request marker must OPEN the clause, not merely appear in it", () => {
  assertNegative(decide(segment("Meetbot, someone should please fix this."), IDENTITY), "incidental_mention");
});

test("R43: a trailing vocative reads the SEGMENT's terminal question mark", () => {
  assertPositive(decide(segment("So what should we do here, Meetbot?"), IDENTITY), "Meetbot");
});

test("R43: the same trailing vocative with a full stop does not authorize", () => {
  assertNegative(decide(segment("So that is the plan, Meetbot."), IDENTITY), "incidental_mention");
});

test("R43: a trailing vocative authorizes on a request marker with no question mark", () => {
  assertPositive(decide(segment("Please take a note, Meetbot."), IDENTITY), "Meetbot");
});

test("R43: a terminal question mark inside a closing quote still counts", () => {
  assertPositive(decide(segment("Can you summarize, Meetbot?”"), IDENTITY), "Meetbot");
});

test("R43: the anti-cue list still earns its place -- an exclamative written with a question mark", () => {
  // Without the anti-cue list these would pass the interrogative test.
  // This is the one hole the punctuation signal cannot cover on its own,
  // and the reason the list is kept as an outer guard rather than deleted
  // along with the cue lexicon.
  assertNegative(decide(segment("Meetbot, what a mess?"), IDENTITY), "incidental_mention");
  assertNegative(decide(segment("Meetbot, how dare you?"), IDENTITY), "incidental_mention");
  assertNegative(decide(segment("What a mess, Meetbot?"), IDENTITY), "incidental_mention");
});

test("R43: the deleted cue words no longer authorize anything on their own", () => {
  // One per word class the old DEFAULT_ADDRESS_CUES list carried: wh-word,
  // modal, auxiliary, and the CJK cues 可以 / 怎么 / 一下 / 总结. Each of
  // these authorized in round 4 as soon as it opened the adjoining clause.
  for (const text of [
    "Meetbot, what nonsense.",
    "Meetbot, will you look at that.",
    "Meetbot, would you believe it.",
    "Meetbot, how ridiculous.",
    "Meetbot, do tell.",
    "Meetbot, did that ever work.",
    "Meetbot, who knows.",
  ]) {
    assertNegative(decide(segment(text), IDENTITY), "incidental_mention");
  }
  for (const text of [
    "会议机器人，可以处理很多任务",
    "会议机器人，怎么老是这样",
    "会议机器人，一下就修好了",
    "会议机器人，总结起来都是问题",
  ]) {
    assertNegative(decide(segment(text, true), CJK_IDENTITY), "incidental_mention");
  }
});

test("KNOWN LIMITATION (R43): an imperative with no question mark and no request marker does not authorize", () => {
  // The reviewer's named limitation. "tell us what we decided" is a
  // genuine instruction, but it is neither interrogative nor marked as a
  // request, and no closed lexicon can tell it apart from the appositive
  // "Meetbot, the note taker, ..." without parsing it as a verb phrase.
  // Documented false negative; add "tell" via additionalRequestMarkers to
  // recover it in a deployment that needs it.
  const decision = decide(segment("Meetbot, tell us what we decided."), IDENTITY);
  assertNegative(decision, "incidental_mention");
  assert.equal(decision.matchedAlias, "Meetbot");
});

test("KNOWN LIMITATION (R43): a disfluency inside the adjoining clause truncates it before the question mark", () => {
  // "Meetbot, can you, uh, summarize?" -- the clause beside the alias ends
  // at the first comma ("can you"), so the terminating punctuation the
  // interrogative test reads is that comma, not the question mark. Found
  // by round 5's own adversarial probing. Kept as a false negative rather
  // than widening the clause, because widening it is exactly what lets an
  // appositive reach a later question mark (see the R43 clause-boundary
  // test above).
  assertNegative(decide(segment("Meetbot, can you, uh, summarize?"), IDENTITY), "incidental_mention");
});

// ---------------------------------------------------------------------------
// Similar human names: an alias must not fire inside a longer word
// ---------------------------------------------------------------------------

test("an alias that is a prefix of a participant's name does not authorize", () => {
  // authorize is still false -- the START/END boundary checks reject this
  // outright (the character after "Mei" is "l", a word-continuation
  // character). Round 3 changed only the DIAGNOSTIC fallback: matchedAlias
  // now surfaces "Mei" via the plain substring check (see module doc point
  // 5), rather than staying null, because the text genuinely was present
  // even though it could never have authorized.
  const decision = decide(segment("Meiling, can you send the notes?"), IDENTITY);
  assertNegative(decision, "incidental_mention");
  assert.equal(decision.matchedAlias, "Mei");
});

test("an alias that is a prefix of a participant's name still never authorizes, regardless of surrounding cues", () => {
  const decision = decide(segment("Meiling usually takes the notes."), IDENTITY);
  assertNegative(decision, "incidental_mention");
  assert.equal(decision.matchedAlias, "Mei");
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
// A known, documented limitation: an open-class imperative with no
// recognized cue word cannot be distinguished from a third-person/
// appositive mention by a closed lexicon, and the acceptance rule for this
// gate is that false positives are zero-tolerance while false negatives may
// have documented exceptions. This is deliberately pinned as a NEGATIVE.
// ---------------------------------------------------------------------------

test("KNOWN LIMITATION: an open-class imperative with no recognized cue word does not authorize", () => {
  // Contrast with the required positive "Meetbot, please summarize the
  // decisions." (has the cue word "please"). Without "please" (or a
  // wh-word/modal), this segment is structurally indistinguishable, by
  // pure lexicon lookup, from a third-person or appositive mention that
  // must stay negative -- e.g. "Meetbot, the note taker, is broken
  // again." Telling them apart would require parsing "summarize the
  // decisions" as an imperative verb phrase, which is exactly the NLP/
  // scoring this task is scoped to avoid. Documented false negative, kept
  // per the "false positives are zero-tolerance" acceptance rule.
  const decision = decide(segment("Meetbot, summarize the decisions."), IDENTITY);
  assertNegative(decision, "incidental_mention");
  assert.equal(decision.matchedAlias, "Meetbot");
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

test("decide() carries the segment's runtime segmentId on the decision", () => {
  const decision = decide(segment("Meetbot, can you help?", true, "seg-42"), IDENTITY);
  assert.equal(decision.segmentId, "seg-42");
});

test("a partial segment's decision still carries its segmentId", () => {
  const decision = decide(segment("anything", false, "seg-partial"), IDENTITY);
  assert.equal(decision.segmentId, "seg-partial");
});

test("a positive decision authorizes the runtime segmentId on the sink", () => {
  const sink = createFakeSink();
  const dispatcher = createInvocationDispatcher(sink);
  const decision = decide(segment("Meetbot, can you help?", true, "seg-42"), IDENTITY);

  dispatcher.apply(decision);

  assert.deepEqual(sink.authorized, [{ segmentId: "seg-42", matchedAlias: "Meetbot" }]);
  assert.deepEqual(sink.skipped, []);
});

test("a negative decision skips the runtime segmentId on the sink", () => {
  const sink = createFakeSink();
  const dispatcher = createInvocationDispatcher(sink);
  const decision = decide(segment("I asked Meetbot about it yesterday.", true, "seg-7"), IDENTITY);

  dispatcher.apply(decision);

  assert.deepEqual(sink.skipped, [{ segmentId: "seg-7", reason: "incidental_mention" }]);
  assert.deepEqual(sink.authorized, []);
});

test("applying the same segmentId twice authorizes only once", () => {
  const sink = createFakeSink();
  const dispatcher = createInvocationDispatcher(sink);
  const decision = decide(segment("Meetbot, can you help?", true, "seg-99"), IDENTITY);

  dispatcher.apply(decision);
  dispatcher.apply(decision);
  dispatcher.apply(decision);

  assert.equal(sink.authorized.length, 1);
  assert.deepEqual(sink.authorized, [{ segmentId: "seg-99", matchedAlias: "Meetbot" }]);
});

test("applying the same segmentId twice skips only once", () => {
  const sink = createFakeSink();
  const dispatcher = createInvocationDispatcher(sink);
  const decision = decide(segment("no alias here at all", true, "seg-100"), IDENTITY);

  dispatcher.apply(decision);
  dispatcher.apply(decision);

  assert.equal(sink.skipped.length, 1);
});

test("a repeated final segment (retry/redelivery) is applied exactly once end to end", () => {
  const sink = createFakeSink();
  const dispatcher = createInvocationDispatcher(sink);
  // The Conversation Runtime redelivers the exact same finalized segment
  // (retry after a dropped ack, at-least-once delivery, etc).
  for (let i = 0; i < 5; i += 1) {
    const decision = decide(segment("Meetbot, please summarize.", true, "seg-dup"), IDENTITY);
    dispatcher.apply(decision);
  }
  assert.equal(sink.authorized.length, 1);
  assert.equal(sink.skipped.length, 0);
});

test("different segmentIds are independent -- applying one does not suppress another", () => {
  const sink = createFakeSink();
  const dispatcher = createInvocationDispatcher(sink);
  dispatcher.apply(decide(segment("Meetbot, can you help?", true, "seg-a"), IDENTITY));
  dispatcher.apply(decide(segment("Meetbot, can you help again?", true, "seg-b"), IDENTITY));
  assert.equal(sink.authorized.length, 2);
});

test("a caller cannot apply one segment's decision under a different segment's id", () => {
  // decide()'s output carries its own segmentId; apply() takes only the
  // decision, so there is no separate id parameter through which a caller
  // could mismatch them. Verified structurally: apply() has arity 1.
  const sink = createFakeSink();
  const dispatcher = createInvocationDispatcher(sink);
  assert.equal(dispatcher.apply.length, 1);

  const decision = decide(segment("Meetbot, can you help?", true, "seg-real"), IDENTITY);
  dispatcher.apply(decision);
  assert.deepEqual(sink.authorized, [{ segmentId: "seg-real", matchedAlias: "Meetbot" }]);
});

// ---------------------------------------------------------------------------
// Configuration extends the default cue lexicons, does not replace them
// ---------------------------------------------------------------------------

test("additionalRequestMarkers extends (not replaces) the default markers", () => {
  // "summarize" is not a shipped request marker -- without the extension
  // this stays negative, same as the pinned known-limitation case above.
  const baseline = decide(segment("Meetbot, summarize the decisions."), IDENTITY);
  assertNegative(baseline, "incidental_mention");

  const extended: InvocationGateIdentity = {
    ...IDENTITY,
    additionalRequestMarkers: ["summarize"],
  };
  assertPositive(decide(segment("Meetbot, summarize the decisions."), extended), "Meetbot");

  // The built-in markers still work under the extended identity too --
  // proving the extension is additive, not a replacement.
  assertPositive(decide(segment("Meetbot, please help."), extended), "Meetbot");
  // And so does the interrogative half of the request test.
  assertPositive(decide(segment("Meetbot, can you help?"), extended), "Meetbot");
});

test("additionalLeadingFillers extends (not replaces) the default lexicon", () => {
  const baseline = decide(segment("Yo Meetbot, can you help?"), IDENTITY);
  assertNegative(baseline, "incidental_mention");

  const extended: InvocationGateIdentity = {
    ...IDENTITY,
    additionalLeadingFillers: ["yo"],
  };
  assertPositive(decide(segment("Yo Meetbot, can you help?"), extended), "Meetbot");

  // The built-in fillers still work under the extended identity too.
  assertPositive(decide(segment("Hey Meetbot, can you help?"), extended), "Meetbot");
});

// ---------------------------------------------------------------------------
// Acceptance matrix -- required NEGATIVE fixtures
//
// The reviewer's acceptance list, cumulative across rounds 2-5. False
// positives are zero-tolerance for this gate; every one of these must never
// authorize, regardless of the reason token it resolves to.
// ---------------------------------------------------------------------------

type Fixture = {
  readonly text: string;
  readonly identity?: InvocationGateIdentity;
  readonly note: string;
};

const REQUIRED_NEGATIVES: ReadonlyArray<Fixture> = [
  { text: "I asked Meetbot about it yesterday.", note: "bare incidental mention, mid-sentence" },
  { text: "Meetbot usually handles the notes.", note: "third-person discussion" },
  {
    text: "Meetbot, the note taker, is broken again.",
    note: "appositive: the adjoining clause is a noun phrase, not a request",
  },
  {
    text: "Meetbot, the note taker, did leave early.",
    note: "same appositive shape, verb past the first comma",
  },
  {
    text: "Meetbot, yeah, it keeps dropping the audio.",
    note: "filler-shaped word ('yeah') after the alias is not a request",
  },
  {
    text: "Meetbot, our transcription tool, costs too much.",
    note: "appositive describing the agent, not addressing it",
  },
  {
    text: "We evaluated three: Fireflies, Otter, Meetbot.",
    note: "alias is the last item in a list, not addressed",
  },
  { text: "Agenda: Meetbot", note: "alias is an agenda item, not addressed" },
  { text: "Next topic, Meetbot.", note: "alias is a topic label, not addressed" },
  { text: "the slack channel is eng-meetbot", note: "alias is a substring of a hyphenated identifier" },
  { text: "Mei-Ling usually takes the notes.", note: "alias is a substring of a hyphenated human name" },
  { text: "Meetbot-api is throwing 500s.", note: "alias is a substring of a hyphenated identifier" },
  { text: "Amelie-Rose, are you there?", note: "alias is a substring of a hyphenated human name" },
  { text: "Meetbot said he can help with that.", note: "reported speech, no separator" },
  { text: "Meetbot mentioned he will join later.", note: "reported intent, no separator" },
  { text: "Meetbot broke it, and honestly nobody will fix it.", note: "adjoining clause is a statement" },
  {
    text: "Please don't blame Meetbot.",
    note: "R41: the preceding clause DOES open with a request marker, but the alias has no separator beside it",
  },
  { text: "Mei's phone is ringing, can someone check?", note: "possessive using the short alias" },
  { text: "Meetbot's log shows what happened.", note: "possessive using the primary alias" },
  { text: "Did Meetbot get that?", note: "a question ABOUT the agent; the alias is mid-segment" },
  { text: "Can Meetbot do that?", note: "a question ABOUT the agent; the alias is mid-segment" },
  { text: "Should we ask Meetbot what it thinks?", note: "a question about the agent, alias mid-segment" },
  // R43: exclamatives. Every one of these opens with a word the deleted
  // cue lexicon recognized, and none of them is interrogative.
  { text: "Meetbot, what a mess.", note: "exclamative opening with the old cue 'what'" },
  { text: "Meetbot, what a day.", note: "exclamative opening with the old cue 'what'" },
  { text: "Meetbot, what nonsense.", note: "exclamative opening with the old cue 'what'" },
  { text: "Meetbot, how about that game last night.", note: "exclamative opening with the old cue 'how'" },
  { text: "Meetbot, how dare you.", note: "exclamative opening with the old cue 'how'" },
  { text: "Meetbot, how ridiculous.", note: "exclamative opening with the old cue 'how'" },
  { text: "Meetbot, why me.", note: "exclamative opening with the old cue 'why'" },
  { text: "Meetbot, do tell.", note: "exclamative opening with the old cue 'do'" },
  { text: "Meetbot, will you look at that.", note: "exclamative opening with the old cue 'will'" },
  { text: "Meetbot, would you believe it.", note: "exclamative opening with the old cue 'would'" },
  { text: "What a mess, Meetbot.", note: "same exclamative, trailing position" },
  {
    text: "I told Meetbot, can you believe it?",
    note: "interrogative, but the alias is mid-segment with no separator beside it",
  },
  { text: "Ask Meetbot, will you?", note: "interrogative; the alias is a grammatical object, mid-segment" },
  { text: "Forget Meetbot, can we move on?", note: "interrogative; the alias is a grammatical object" },
  { text: "So much for Meetbot, what a waste.", note: "alias mid-segment behind a filler-shaped opener" },
  // R43 (CJK). The first seven have no separator at all (R41); the last
  // two DO carry a full-width comma and are rejected by the request test
  // -- they open with the deleted cues 可以 / 怎么 and carry no marker.
  { text: "会议机器人说他可以处理这个问题", identity: CJK_IDENTITY, note: "reported speech, no separator" },
  { text: "会议机器人今天什么都没做", identity: CJK_IDENTITY, note: "third-person statement, no separator" },
  { text: "会议机器人可以处理很多任务", identity: CJK_IDENTITY, note: "declarative, no separator" },
  { text: "会议机器人一下就修好了", identity: CJK_IDENTITY, note: "declarative, no separator" },
  { text: "会议机器人总结起来都是问题", identity: CJK_IDENTITY, note: "the idiom 总结起来, no separator" },
  { text: "会议机器人怎么老是这样", identity: CJK_IDENTITY, note: "rhetorical complaint, no separator" },
  { text: "会议机器人为什么大家都在讨论它", identity: CJK_IDENTITY, note: "question about the agent, no separator" },
  {
    text: "会议机器人，可以处理很多任务",
    identity: CJK_IDENTITY,
    note: "R43: has a separator, opens with the deleted cue 可以, carries no request marker",
  },
  {
    text: "会议机器人，怎么老是这样",
    identity: CJK_IDENTITY,
    note: "R43: has a separator, opens with the deleted cue 怎么, carries no request marker",
  },
];

for (const { text, identity, note } of REQUIRED_NEGATIVES) {
  test(`acceptance matrix (negative): "${text}" does not authorize -- ${note}`, () => {
    const decision = decide(segment(text), identity ?? IDENTITY);
    assert.equal(
      decision.authorize,
      false,
      `expected authorize=false for ${JSON.stringify(text)}, got ${JSON.stringify(decision)}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Acceptance matrix -- required POSITIVE fixtures
// ---------------------------------------------------------------------------

const REQUIRED_POSITIVES: ReadonlyArray<{
  readonly text: string;
  readonly identity: InvocationGateIdentity;
  readonly matchedAlias: string;
  readonly note: string;
}> = [
  { text: "Meetbot", identity: IDENTITY, matchedAlias: "Meetbot", note: "alias alone" },
  {
    text: "Meetbot, what did we decide?",
    identity: IDENTITY,
    matchedAlias: "Meetbot",
    note: "separator + interrogative clause",
  },
  {
    text: "Hey Meetbot, can you summarize?",
    identity: IDENTITY,
    matchedAlias: "Meetbot",
    note: "leading filler + interrogative clause",
  },
  {
    text: "So, Meetbot, can you summarize?",
    identity: IDENTITY,
    matchedAlias: "Meetbot",
    note: "leading filler with its own comma + interrogative clause",
  },
  {
    text: "OK Meetbot, what did we decide?",
    identity: IDENTITY,
    matchedAlias: "Meetbot",
    note: "leading filler + interrogative clause",
  },
  {
    text: "Meetbot, please summarize the decisions.",
    identity: IDENTITY,
    matchedAlias: "Meetbot",
    note: "request marker, no question mark",
  },
  {
    text: "Meetbot, can you hear me?",
    identity: IDENTITY,
    matchedAlias: "Meetbot",
    note: "interrogative clause",
  },
  {
    text: "Meetbot, could you repeat that?",
    identity: IDENTITY,
    matchedAlias: "Meetbot",
    note: "interrogative clause",
  },
  {
    text: "Hey Meetbot, please take a note.",
    identity: IDENTITY,
    matchedAlias: "Meetbot",
    note: "leading filler + request marker",
  },
  {
    text: "Can you take a note, Meetbot?",
    identity: IDENTITY,
    matchedAlias: "Meetbot",
    note: "trailing vocative; the question mark falls after the alias",
  },
  {
    text: "Could you summarize, Meetbot?",
    identity: IDENTITY,
    matchedAlias: "Meetbot",
    note: "trailing vocative; the question mark falls after the alias",
  },
  {
    text: "What did we decide, Meetbot?",
    identity: IDENTITY,
    matchedAlias: "Meetbot",
    note: "trailing vocative; the question mark falls after the alias",
  },
  {
    text: "会议机器人，请总结一下",
    identity: CJK_IDENTITY,
    matchedAlias: "会议机器人",
    note: "CJK, full-width comma + the request marker 请",
  },
  {
    text: "会议机器人：请总结",
    identity: CJK_IDENTITY,
    matchedAlias: "会议机器人",
    note: "CJK, full-width colon + the request marker 请",
  },
  {
    text: "会议机器人，帮我总结一下",
    identity: CJK_IDENTITY,
    matchedAlias: "会议机器人",
    note: "CJK, full-width comma + the request marker 帮我",
  },
];

for (const { text, identity, matchedAlias, note } of REQUIRED_POSITIVES) {
  test(`acceptance matrix (positive): "${text}" authorizes -- ${note}`, () => {
    assertPositive(decide(segment(text), identity), matchedAlias);
  });
}

test("acceptance matrix (negative): any non-final segment does not authorize, whatever its text", () => {
  for (const { text, identity } of REQUIRED_NEGATIVES) {
    assertNegative(decide(segment(text, false), identity ?? IDENTITY), "non_final_segment");
  }
  // And every required POSITIVE text, made partial -- the hardest version
  // of "whatever its text": a perfectly-shaped vocative that is not final.
  for (const { text, identity } of REQUIRED_POSITIVES) {
    assertNegative(decide(segment(text, false), identity), "non_final_segment");
  }
});


// ---------------------------------------------------------------------------
// Property test 1: arbitrary segments containing no configured alias never
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
  "，",
  "。",
  "！",
  "？",
  "、",
  "你",
  "好",
  "会",
  "议",
  "机",
  "器",
  "人",
  "的",
  "了",
  "在",
  "是",
  "我",
  "他",
  "们",
  "这",
  "个",
  "有",
  "和",
  "é",
  "ñ",
  "ü",
  "ö",
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

test("property 1: arbitrary generated text containing no configured alias never authorizes", () => {
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

// ---------------------------------------------------------------------------
// Property test 2: an alias that is NOT the target of a request never
// authorizes -- whether it is buried mid-segment, or sitting at a genuine
// segment edge behind a real separator with a non-request clause beside it.
//
// Three generation modes, round-robin by sample index. Modes 1-3 put the
// alias exactly where isVocativeBoundary looks (offset 0 followed by a
// separator, or the segment's end preceded by one), so clauseIsRequest is
// genuinely invoked on generated content -- which is what lets this
// property fail on the defect classes it names:
//   - a request marker ANYWHERE in the clause counting as "opens with"
//     (the generators put the marker at token index 2 or later, and never
//     at the opening);
//   - a question mark anywhere in the SEGMENT counting as "this clause is
//     interrogative" for a leading vocative (mode 3 puts a question mark
//     past the adjoining clause's own boundary);
//   - the request test collapsing to "any adjoining clause is an address".
// Mode 0 keeps round 3's fully-embedded case, which exercises the
// hyphen/apostrophe/word-continuation adjacency guard instead; it does not
// reach clauseIsRequest, and does not claim to.
// ---------------------------------------------------------------------------

const EMBED_ALPHABET = [
  ..."abcdefghijklmnopqrstuvwxyz",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  ..."0123456789",
  " ",
  " ",
  ",",
  ".",
  "-",
  "!",
  "?",
  ":",
  ";",
];

function randomNonEmptyText(rng: () => number, minLength: number, maxLength: number): string {
  const length = minLength + Math.floor(rng() * (maxLength - minLength + 1));
  let out = "";
  for (let i = 0; i < length; i += 1) {
    const idx = Math.floor(rng() * EMBED_ALPHABET.length);
    out += EMBED_ALPHABET[idx];
  }
  return out;
}

function randomJoiner(rng: () => number): string {
  // The joiner set includes the straight and typographic apostrophe -- the
  // exact class round 3's Critical 2 found missing from WORD_CONTINUATION.
  const joiners = ["-", " ", ", ", ": ", "", "'", "’"];
  return joiners[Math.floor(rng() * joiners.length)] ?? " ";
}

// Ordinary filler words a real appositive/reported-speech sentence would
// use, deliberately disjoint from BURIED_MARKER_POOL below.
const WORD_POOL = [
  "the",
  "team",
  "report",
  "update",
  "meeting",
  "status",
  "today",
  "later",
  "again",
  "broke",
  "said",
  "mentioned",
  "honestly",
  "nobody",
  "yesterday",
  "costs",
  "tool",
  "our",
  "transcription",
  "notes",
  "audio",
  "call",
  "topic",
];

// The request markers decide() ships with.
const BURIED_MARKER_POOL = ["please", "kindly"];

function randomWord(rng: () => number, pool: readonly string[]): string {
  return pool[Math.floor(rng() * pool.length)] ?? pool[0]!;
}

/** A multi-word phrase carrying a request marker at token index 2 or later
 * -- never opening the phrase. Used as the CLAUSE in the boundary modes,
 * where it is what clauseIsRequest actually evaluates, so it fails if and
 * only if the marker check regresses from "opens with" to "contains". */
function randomBuriedMarkerPhrase(rng: () => number): string {
  const leadWordCount = 2 + Math.floor(rng() * 2);
  const words: string[] = [];
  for (let i = 0; i < leadWordCount; i += 1) words.push(randomWord(rng, WORD_POOL));
  words.push(randomWord(rng, BURIED_MARKER_POOL));
  const trailWordCount = Math.floor(rng() * 3);
  for (let i = 0; i < trailWordCount; i += 1) words.push(randomWord(rng, WORD_POOL));
  return words.join(" ");
}

function randomEmbeddingText(rng: () => number): string {
  // Half character noise, half a word-shaped phrase. Neither reaches
  // clauseIsRequest in the embedded mode -- see the mode-0 branch below.
  return rng() < 0.5 ? randomNonEmptyText(rng, 1, 25) : randomBuriedMarkerPhrase(rng);
}

const BOUNDARY_SEPARATORS = [",", ":"];

function randomBoundarySeparator(rng: () => number): string {
  return BOUNDARY_SEPARATORS[Math.floor(rng() * BOUNDARY_SEPARATORS.length)] ?? ",";
}

// Deliberately never "?" -- a question mark is what would legitimately
// authorize these, and the property is about clauses that are NOT requests.
const NON_INTERROGATIVE_TERMINATORS = [".", "!", ""];

function randomTerminator(rng: () => number): string {
  return NON_INTERROGATIVE_TERMINATORS[Math.floor(rng() * NON_INTERROGATIVE_TERMINATORS.length)] ?? ".";
}

test("property 2: an alias beside a non-request clause never authorizes, at a real segment edge or embedded", () => {
  const SEED = 0x656d_6265; // "embe", arbitrary fixed constant -- deterministic across runs
  const rng = mulberry32(SEED);
  const SAMPLES = 400;
  const identity = IDENTITY;
  const alias = "Meetbot";
  const foldedFillers = new Set(["hey", "hi", "hello", "so", "ok", "okay", "um", "uh"]);

  for (let i = 0; i < SAMPLES; i += 1) {
    // 0. EMBEDDED: non-empty content on BOTH sides, so the alias never
    //    reaches a segment edge and clauseIsRequest is never invoked --
    //    this mode covers the adjacency guard, not the request test.
    // 1. LEADING BOUNDARY: alias at offset 0, real separator, non-request
    //    clause, non-interrogative terminator.
    // 2. TRAILING BOUNDARY: the mirror image, alias at the segment's end.
    // 3. LEADING BOUNDARY WITH A LATER QUESTION: same as mode 1, plus a
    //    second clause that DOES end in "?" -- the question mark must not
    //    reach back across the clause boundary.
    const mode = i % 4;

    if (mode === 0) {
      let prefix = randomEmbeddingText(rng);
      let suffix = randomEmbeddingText(rng);
      let guard = 0;
      function isProblematic(): boolean {
        if (containsAnyAliasSubstring(prefix, identity) || containsAnyAliasSubstring(suffix, identity)) {
          return true;
        }
        const foldedPrefix = foldForContainmentCheck(prefix).trim().replace(/[,.\-!?:;]+$/u, "");
        return foldedFillers.has(foldedPrefix);
      }
      while (isProblematic() && guard < 15) {
        prefix = randomEmbeddingText(rng);
        suffix = randomEmbeddingText(rng);
        guard += 1;
      }
      assert.ok(!isProblematic(), `seed=${SEED} sample=${i} (embedded): could not generate a clean case after ${guard} retries`);

      const text = `${prefix}${randomJoiner(rng)}${alias}${randomJoiner(rng)}${suffix}`;
      const decision = decide({ segmentId: `embed-${i}`, text, final: true }, identity);
      assert.equal(
        decision.authorize,
        false,
        `seed=${SEED} sample=${i} (embedded) text=${JSON.stringify(text)}: expected authorize=false but got ${JSON.stringify(decision)}`,
      );
      continue;
    }

    let clause = randomBuriedMarkerPhrase(rng);
    let guard = 0;
    while (containsAnyAliasSubstring(clause, identity) && guard < 15) {
      clause = randomBuriedMarkerPhrase(rng);
      guard += 1;
    }
    assert.ok(
      !containsAnyAliasSubstring(clause, identity),
      `seed=${SEED} sample=${i} (boundary): could not generate a clean clause after ${guard} retries`,
    );

    const sep = randomBoundarySeparator(rng);
    let text: string;
    if (mode === 1) {
      text = `${alias}${sep} ${clause}${randomTerminator(rng)}`;
    } else if (mode === 2) {
      text = `${clause}${sep} ${alias}${randomTerminator(rng)}`;
    } else {
      let tail = randomBuriedMarkerPhrase(rng);
      let tailGuard = 0;
      while (containsAnyAliasSubstring(tail, identity) && tailGuard < 15) {
        tail = randomBuriedMarkerPhrase(rng);
        tailGuard += 1;
      }
      assert.ok(
        !containsAnyAliasSubstring(tail, identity),
        `seed=${SEED} sample=${i} (later question): could not generate a clean tail after ${tailGuard} retries`,
      );
      text = `${alias}${sep} ${clause}, ${tail}?`;
    }

    const decision = decide({ segmentId: `boundary-${i}`, text, final: true }, identity);
    assert.equal(
      decision.authorize,
      false,
      `seed=${SEED} sample=${i} (mode=${mode}) text=${JSON.stringify(text)}: expected authorize=false but got ${JSON.stringify(decision)}`,
    );
  }
});
