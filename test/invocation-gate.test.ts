// The deterministic invocation gate: the single decision point behind the
// product's loudest requirement -- the agent listens continuously and
// speaks only when called by name. The measured acceptance gate is zero
// unprompted spoken responses across a real hour-long two-human meeting, so
// this suite is organized around the boundary between a genuine vocative
// invocation and everything that merely mentions the agent's name.
//
// ROUND 2 (post-review): a round-1 reviewer ran the matcher against real
// utterances and found it authorized on hyphenated names/identifiers ("Mei-
// Ling", "Meetbot-api", "eng-meetbot") and refused genuine leading-filler
// and bare-imperative vocatives ("Hey Meetbot, ...", "Meetbot what did we
// decide"), while also authorizing on appositive/agenda-style mentions
// ("Meetbot, the note taker, is broken again.", "Agenda: Meetbot"). This
// suite pins the reviewer's exact fixture lists (see the two "acceptance
// matrix" blocks below) in addition to the original matrices, plus a
// second property test targeting the exact defect class the first property
// test could not catch (it only samples alias-FREE text; the bugs above
// all contain the alias).
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

test("alias with no punctuation at all but a leading question-word cue authorizes", () => {
  // No comma anywhere in this segment -- the boundary is whitespace, and
  // the disambiguator is the cue word "what", not punctuation.
  assertPositive(decide(segment("Meetbot what did we decide"), IDENTITY), "Meetbot");
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

test("CJK alias at the end, full-width-comma-separated, authorizes", () => {
  assertPositive(decide(segment("可以总结了吗，会议机器人", true), CJK_IDENTITY), "会议机器人");
});

test("CJK alias alone as the entire segment authorizes", () => {
  assertPositive(decide(segment("会议机器人", true), CJK_IDENTITY), "会议机器人");
});

test("CJK alias with NO separator at all still authorizes via the '一下' request-softener cue", () => {
  // Chinese has no whitespace, so there is no punctuation-free "boundary"
  // the way English has one; the disambiguator here is the address-cue
  // lexicon (一下), not adjacency to a non-letter character.
  assertPositive(decide(segment("会议机器人总结一下", true), CJK_IDENTITY), "会议机器人");
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
// ROUND 3 (found by adversarial probing, not the review): a wh-word
// contraction ("what's", "who's", "where's", ...) is an extremely common
// way to open a real question and must still count as the cue "what" /
// "who" / "where" even though the apostrophe survives token-edge
// stripping (it's internal to the token, not at either edge).
// ---------------------------------------------------------------------------

test("a wh-word contraction still counts as its cue", () => {
  assertPositive(decide(segment("Meetbot: what's the plan?"), IDENTITY), "Meetbot");
});

test("a different wh-word contraction still counts as its cue", () => {
  assertPositive(decide(segment("Meetbot, who's next?"), IDENTITY), "Meetbot");
});

test("a non-contracted misspelling ('whats', no apostrophe) does not get the contraction leniency", () => {
  // Deliberately NOT extended to bare misspellings -- the contraction
  // fix targets a specific, unambiguous apostrophe shape, not fuzzy
  // matching.
  const decision = decide(segment("Meetbot: whats the plan?"), IDENTITY);
  assertNegative(decision, "incidental_mention");
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

test("additionalAddressCues extends (not replaces) the default lexicon", () => {
  // "summarize" is not in the shipped default cue list -- without the
  // extension this stays negative, same as the pinned known-limitation
  // case above.
  const baseline = decide(segment("Meetbot, summarize the decisions."), IDENTITY);
  assertNegative(baseline, "incidental_mention");

  const extended: InvocationGateIdentity = {
    ...IDENTITY,
    additionalAddressCues: ["summarize"],
  };
  assertPositive(decide(segment("Meetbot, summarize the decisions."), extended), "Meetbot");

  // The built-in cues still work under the extended identity too --
  // proving the extension is additive, not a replacement.
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
// Every entry here comes directly from the round-2 review's acceptance
// list. False positives are zero-tolerance for this gate; every one of
// these must never authorize, regardless of the reason token it resolves
// to.
// ---------------------------------------------------------------------------

const REQUIRED_NEGATIVES: ReadonlyArray<{ readonly text: string; readonly note: string }> = [
  { text: "I asked Meetbot about it yesterday.", note: "bare incidental mention, mid-sentence" },
  { text: "Meetbot usually handles the notes.", note: "third-person discussion" },
  {
    text: "Meetbot, the note taker, is broken again.",
    note: "appositive: alias at a comma-separated start, no address cue follows",
  },
  {
    text: "Meetbot, yeah, it keeps dropping the audio.",
    note: "filler-shaped word ('yeah') after the alias is not an address cue",
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
  // ROUND 3, Critical 1 (reproduced as confirmed round-2 false positives
  // by the second review): a cue word appearing anywhere in the unbounded
  // rest of the segment is not enough -- it must open the clause
  // immediately adjoining the alias.
  { text: "Meetbot said he can help with that.", note: "cue 'can' is past the first clause boundary, reported speech" },
  { text: "Meetbot mentioned he will join later.", note: "cue 'will' does not open the adjoining clause" },
  {
    text: "Meetbot broke it, and honestly nobody will fix it.",
    note: "cue 'will' is beyond the first comma boundary",
  },
  {
    text: "Please don't blame Meetbot.",
    note: "cue 'please' opens the SENTENCE, but the alias is a trailing object with no separator before it",
  },
  {
    text: "Meetbot, the note taker, did leave early.",
    note: "same appositive shape as the pinned copula fixture, with 'did' beyond the first comma",
  },
  // ROUND 3, Critical 2: apostrophe is now a word-continuation character.
  { text: "Mei's phone is ringing, can someone check?", note: "possessive using the short alias" },
  { text: "Meetbot's log shows what happened.", note: "possessive using the primary alias" },
];

for (const { text, note } of REQUIRED_NEGATIVES) {
  test(`acceptance matrix (negative): "${text}" does not authorize -- ${note}`, () => {
    const decision = decide(segment(text), IDENTITY);
    assert.equal(
      decision.authorize,
      false,
      `expected authorize=false for ${JSON.stringify(text)}, got ${JSON.stringify(decision)}`,
    );
  });
}

test("acceptance matrix (negative): any non-final segment does not authorize, whatever its text", () => {
  for (const { text } of REQUIRED_NEGATIVES) {
    const decision = decide(segment(text, false), IDENTITY);
    assertNegative(decision, "non_final_segment");
  }
  // Also the required positive texts, made partial -- the hardest version
  // of "whatever its text": a perfectly-shaped vocative that is not final.
  for (const text of [
    "Meetbot",
    "Meetbot, what did we decide?",
    "Hey Meetbot, can you summarize?",
    "会议机器人总结一下",
  ]) {
    const decision = decide(segment(text, false), IDENTITY.aliases.includes("会议机器人") ? IDENTITY : CJK_IDENTITY);
    assertNegative(decision, "non_final_segment");
  }
});

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
    note: "comma + wh-word cue",
  },
  {
    text: "Meetbot what did we decide",
    identity: IDENTITY,
    matchedAlias: "Meetbot",
    note: "no punctuation, wh-word cue alone disambiguates",
  },
  {
    text: "Hey Meetbot, can you summarize?",
    identity: IDENTITY,
    matchedAlias: "Meetbot",
    note: "leading filler + modal cue",
  },
  {
    text: "So, Meetbot, can you summarize?",
    identity: IDENTITY,
    matchedAlias: "Meetbot",
    note: "leading filler with its own comma + modal cue",
  },
  {
    text: "OK Meetbot, what did we decide?",
    identity: IDENTITY,
    matchedAlias: "Meetbot",
    note: "leading filler + wh-word cue",
  },
  {
    text: "Meetbot, please summarize the decisions.",
    identity: IDENTITY,
    matchedAlias: "Meetbot",
    note: "politeness cue",
  },
  {
    text: "Can you take a note, Meetbot?",
    identity: IDENTITY,
    matchedAlias: "Meetbot",
    note: "end position, preceding clause carries the modal cue",
  },
  {
    text: "会议机器人，请总结一下",
    identity: CJK_IDENTITY,
    matchedAlias: "会议机器人",
    note: "CJK, full-width comma + request marker",
  },
  {
    text: "会议机器人总结一下",
    identity: CJK_IDENTITY,
    matchedAlias: "会议机器人",
    note: "CJK, no separator at all, '一下' softener is the sole cue",
  },
];

for (const { text, identity, matchedAlias, note } of REQUIRED_POSITIVES) {
  test(`acceptance matrix (positive): "${text}" authorizes -- ${note}`, () => {
    assertPositive(decide(segment(text), identity), matchedAlias);
  });
}

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
// Property test 2: an alias embedded in random filler at a NON-vocative
// position (real, non-empty content on both sides) never authorizes. This
// is the property that would have caught round 1's exact defect class: the
// hyphen-as-separator bug and the appositive/agenda bug both involve the
// alias sitting where random filler surrounds it on both sides, not where
// it's alone or at a true segment edge.
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
  // Round 3: added the straight and typographic apostrophe -- the exact
  // joiner class Critical 2 found missing from WORD_CONTINUATION.
  const joiners = ["-", " ", ", ", ": ", "", "'", "\u2019"];
  return joiners[Math.floor(rng() * joiners.length)] ?? " ";
}

// Round 3: ordinary filler words a real appositive/reported-speech
// sentence would use, deliberately disjoint from BURIED_CUE_POOL below.
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

// The same cue words decide() recognizes -- placed deliberately at a
// NON-OPENING position by randomBuriedCuePhrase below, so this directly
// targets round 2's Critical 1 defect class (a cue word anywhere in the
// unbounded remainder used to be enough; now it must open the clause).
const BURIED_CUE_POOL = ["can", "could", "would", "will", "do", "does", "did", "what", "who", "where", "when", "why", "how", "please"];

function randomWord(rng: () => number, pool: readonly string[]): string {
  return pool[Math.floor(rng() * pool.length)] ?? pool[0]!;
}

/** A multi-word phrase with a real cue word buried at position 1 or 2 --
 * never position 0 -- so if the matcher incorrectly treats "a cue anywhere"
 * as sufficient (round 2's Critical 1 bug), this phrase would wrongly
 * authorize; if the matcher correctly requires the cue to OPEN the clause,
 * it never does. */
function randomBuriedCuePhrase(rng: () => number): string {
  const leadWordCount = 1 + Math.floor(rng() * 2);
  const words: string[] = [];
  for (let i = 0; i < leadWordCount; i += 1) words.push(randomWord(rng, WORD_POOL));
  words.push(randomWord(rng, BURIED_CUE_POOL));
  const trailWordCount = Math.floor(rng() * 3);
  for (let i = 0; i < trailWordCount; i += 1) words.push(randomWord(rng, WORD_POOL));
  return words.join(" ");
}

function randomEmbeddingText(rng: () => number): string {
  // Half character noise (catches generic/hyphen/apostrophe-class issues),
  // half a buried-cue word phrase (catches the clause-scope class).
  return rng() < 0.5 ? randomNonEmptyText(rng, 1, 25) : randomBuriedCuePhrase(rng);
}

test("property 2: an alias embedded in random filler on both sides (never at a segment edge) never authorizes", () => {
  const SEED = 0x656d_6265; // "embe", arbitrary fixed constant -- deterministic across runs
  const rng = mulberry32(SEED);
  const SAMPLES = 300;
  const identity = IDENTITY;
  const alias = "Meetbot";

  for (let i = 0; i < SAMPLES; i += 1) {
    let prefix = randomEmbeddingText(rng);
    let suffix = randomEmbeddingText(rng);
    let guard = 0;
    // Guard against: (a) the random prefix/suffix accidentally spelling out
    // another occurrence of a configured alias, which would make the
    // "no alias elsewhere" premise false, and (b) the prefix folding down
    // to exactly a recognized leading filler word, which would legitimately
    // make this a real (non-embedded) vocative and defeat the point of the
    // test.
    const foldedFillers = new Set(["hey", "hi", "hello", "so", "ok", "okay", "um", "uh"]);
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
    assert.ok(!isProblematic(), `seed=${SEED} sample=${i}: could not generate a clean embedding after ${guard} retries`);

    const text = `${prefix}${randomJoiner(rng)}${alias}${randomJoiner(rng)}${suffix}`;
    const decision = decide({ segmentId: `embed-${i}`, text, final: true }, identity);
    assert.equal(
      decision.authorize,
      false,
      `seed=${SEED} sample=${i} text=${JSON.stringify(text)}: expected authorize=false but got ${JSON.stringify(decision)}`,
    );
  }
});
