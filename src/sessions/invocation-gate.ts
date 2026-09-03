// The deterministic invocation gate: the single decision point behind the
// product's loudest requirement -- the agent listens continuously and
// speaks only when called by name. Pure text and configuration in, a
// decision out: no I/O, no clock, no network, and (deliberately) no
// parameter of any kind for speaker identity or participant rank -- the
// type signature itself makes the rule impossible to loosen by who is
// talking, only by what they explicitly said.
//
// The minimum positive rule: an explicit vocative invocation in a
// FINALIZED segment. Getting the boundary right is the whole module:
//   - A bare incidental mention ("I asked Meetbot about it yesterday") is
//     negative -- somebody talking ABOUT the agent, not TO it.
//   - Third-person discussion ("Meetbot usually handles the notes", "Meetbot
//     said he can help with that") is negative for the same reason.
//   - An appositive/agenda-style mention ("Meetbot, the note taker, is
//     broken again.", "Agenda: Meetbot") is negative -- the alias sits at
//     a segment edge with a separator, but the adjoining clause is not a
//     request.
//   - An exclamatory idiom ("Meetbot, what a mess.", "Meetbot, how
//     ridiculous.", "Meetbot, will you look at that.") is negative -- it is
//     not interrogative and carries no request marker, and the small
//     anti-cue list below catches the ones a transcriber writes with a
//     question mark anyway.
//   - A quoted mention (somebody reading a sentence aloud that happens to
//     contain the name) is negative.
//   - A short alias must never fire merely because it is a textual prefix
//     or suffix of a longer, unrelated token -- a human name ("Mei" vs
//     "Meiling"), a possessive ("Mei's"), or a compound identifier
//     ("Meetbot-api", "eng-meetbot").
//   - A mention with NO real separator between the alias and the adjoining
//     text is negative, full stop -- see R41 below. This is what "Meetbot
//     usually handles the notes" and "Please don't blame Meetbot." both
//     fail on, and it is also why two formerly-required positives
//     ("Meetbot what did we decide", "会议机器人总结一下") are documented
//     known limitations instead of authorizing.
//   - A partial transcript NEVER authorizes, whatever it contains. This is
//     structural: finality is the first thing decide() checks, and nothing
//     below that check can produce a positive outcome for a partial
//     segment -- see decide() below.
//
// R41 (round 4): authorize requires EITHER the alias to be the whole
// utterance, OR an actual separator character (comma, colon, or their CJK
// full-width forms -- REQUIRED_SEPARATOR) immediately on the side of the
// alias facing the adjoining clause. No separator, no authorize, whatever
// the adjoining clause says. This single requirement also subsumes the
// word-continuation adjacency guard on both sides in both scripts (a real
// separator is never a letter/digit/hyphen/underscore/apostrophe), and it
// kills an entire class of Chinese false positives on its own (ordinary
// declaratives with the alias as subject and no comma after it, e.g.
// "会议机器人可以处理很多任务") with no Han-specific carve-out.
//
// R43 (round 5): THE ADDRESS-CUE LEXICON IS GONE. Rounds 2-4 decided
// "is the adjoining clause an address?" by looking at the word that OPENS
// it -- wh-words, modals, "please", and Chinese equivalents -- with a
// growing anti-cue list of exclamative idioms in front of it. That rule
// cannot work, and each round proved it again with a fresh crop of
// counter-examples ("Meetbot, what nonsense.", "Meetbot, will you look at
// that.", "Meetbot, how ridiculous.", "会议机器人，可以处理很多任务",
// "会议机器人，怎么老是这样"): English exclamatives share their opening word
// with questions, so the opening word is simply not the signal.
//
// The clause now has to pass a REQUEST TEST instead. It is an address only
// if it is a request, and a request is:
//   1. INTERROGATIVE -- it ends with "?" or "？". For a LEADING vocative
//      that is the terminator of the clause immediately after the alias;
//      for a TRAILING vocative the question mark falls after the alias, so
//      the segment's own terminal punctuation is what is tested.
//   2. Or it OPENS WITH AN EXPLICIT REQUEST MARKER from a small closed set
//      (DEFAULT_REQUEST_MARKERS: "please", "kindly", "请", "麻烦", "帮我"
//      and obvious siblings) -- words whose only job is to mark a request.
//      Deployment-extensible via additionalRequestMarkers.
// Interrogative punctuation is a real signal ASR emits, and it is precisely
// what exclamatives lack: "what a mess", "how ridiculous", "will you look
// at that", "可以处理很多任务" and "怎么老是这样" all fail both tests, while
// every required positive passes one.
//
// One carve-out, added by round 5's own adversarial probing rather than by
// the ruling: the interrogative half of the test applies only to a clause
// that is NOT Chinese. Chinese fronts a topic before a comma as ordinary
// grammar, so "会议机器人，是不是又坏了？" ("as for Meetbot, is it broken
// again?") is structurally identical to a vocative question and the
// question mark discriminates nothing there. A Chinese clause must carry an
// explicit request marker. See clauseIsRequest for the evidence and the
// false negative it costs.
//
// R47 (round 7) narrows the interrogative branch once more. Round 6 already
// required the clause to carry EVIDENCE OF ADDRESS before a question mark
// could mean "request" -- a wh-word, a second-person pronoun or a request
// marker, anywhere in it. A bare wh-word is not that evidence: English opens
// a rhetorical or exclamatory fragment ABOUT something with the same words
// ("what garbage", "how awful", "why bother", "who cares"), and a
// transcriber who punctuates one of those with a question mark had the agent
// speaking into a conversation it was not part of. A wh-word now counts only
// when an AUXILIARY OR MODAL immediately follows it -- the subject-auxiliary
// inversion (or copula) that makes a genuine wh-question and that a
// rhetorical fragment has nowhere to put. Closed grammatical class, not
// another idiom list. See AUXILIARIES / AUXILIARY_CLITICS, and the false
// negative it costs ("who broke it?", "what happened?" -- subject
// wh-questions carry no auxiliary at all).
//
// The separator requirement (R41) and the anti-cue list stay as OUTER
// guards around the request test, and both still carry weight:
//   - The separator is what rejects "Please don't blame Meetbot." -- a
//     preceding clause that does open with a request marker, but whose
//     alias has no separator beside it.
//   - The anti-cues (DEFAULT_ANTI_CUES) are the answer to an exclamation a
//     transcriber wrote with a question mark ("Meetbot, what a mess?",
//     "会议机器人，什么鬼？"), which the interrogative test alone would let
//     through. They are checked FIRST, in both positions.
//
// Multilingual note: a "word boundary" only exists as whitespace in
// space-delimited languages, and Chinese has none at all. This module
// therefore uses two mechanisms for "does the clause OPEN with this
// phrase" depending on the script -- a first-token test for Latin, a raw
// string prefix for Han -- but ONE mechanism for everything else (the
// separator requirement, clause truncation at the next real punctuation
// boundary, the interrogative test), applied identically to both.
// Coverage: the shipped defaults distinguish request from mention in
// English and Chinese; an operator deploying a third language passes
// additionalRequestMarkers/additionalLeadingFillers/additionalAntiCues with
// that language's request markers, greeting fillers, and exclamatory
// idioms. Interrogative punctuation needs no per-language configuration.

/** A candidate transcript segment, exactly as decide() needs it. Deliberately
 * NOT the Conversation Runtime port's segment shape -- that port is Task 5's
 * deliverable and its shape is still settling in another repository. Any
 * object with these three fields satisfies this type structurally, so
 * Task 5's adapter can map the real runtime segment onto it without this
 * module importing anything from that port. */
export type InvocationCandidateSegment = {
  readonly segmentId: string;
  readonly text: string;
  /** Whether the ASR engine has finalized this segment. `false` short-
   * circuits the whole decision to negative before any text is even
   * inspected (see decide()), so a partial transcript structurally cannot
   * authorize speech, regardless of what it contains. */
  readonly final: boolean;
};

/** The configured agent identity decide() needs -- structurally compatible
 * with (but not imported from) `MeetingAgentConfig["agentIdentity"]` in
 * src/config.ts, so callers can pass that object directly without coupling
 * this module to config.ts.
 *
 * `additionalRequestMarkers`, `additionalLeadingFillers`, and
 * `additionalAntiCues` EXTEND the shipped defaults (see
 * DEFAULT_REQUEST_MARKERS / DEFAULT_LEADING_FILLERS / DEFAULT_ANTI_CUES
 * below) -- they never replace them. This is deployment configuration, the
 * same class of thing the aliases already are: closed lists of literal
 * words/phrases, not a pattern language, not a scoring model. */
export type InvocationGateIdentity = {
  readonly aliases: readonly string[];
  readonly additionalRequestMarkers?: readonly string[];
  readonly additionalLeadingFillers?: readonly string[];
  readonly additionalAntiCues?: readonly string[];
};

export type InvocationDecisionReason =
  | "vocative_invocation"
  | "non_final_segment"
  | "quoted_mention"
  | "incidental_mention"
  | "no_alias_match";

/** A discriminated union, not a flat optional field: a positive decision
 * carries a non-null `matchedAlias` by CONSTRUCTION, not by convention, so
 * there is no reachable state where authorize is true and matchedAlias is
 * null for a caller (or the sink below) to have to guard against.
 *
 * `segmentId` is carried ON the decision (not passed separately when
 * applying it) so a caller cannot apply one segment's decision under a
 * different segment's id -- see createInvocationDispatcher. */
export type InvocationDecision =
  | {
      readonly segmentId: string;
      readonly authorize: true;
      readonly matchedAlias: string;
      readonly reason: "vocative_invocation";
    }
  | {
      readonly segmentId: string;
      readonly authorize: false;
      /** Populated whenever a configured alias's text was found in the
       * segment -- including negative outcomes like "incidental_mention"
       * and "quoted_mention" -- because an operator debugging "why did it
       * not answer me" needs to see that the name WAS heard, just not
       * addressed. This check has NO adjacency guard: it also populates for
       * a hyphenated/possessive/longer-word occurrence that never had a
       * chance to authorize. Null only when no configured alias's text
       * appears anywhere in the segment at all, or when the segment was
       * not final and the text was never inspected. */
      readonly matchedAlias: string | null;
      readonly reason: Exclude<InvocationDecisionReason, "vocative_invocation">;
    };

/**
 * Decide whether `segment` authorizes a spoken response.
 *
 * Order of checks, each structurally unable to be overridden by a later
 * one:
 *   1. Not final -> negative, "non_final_segment". Nothing below this
 *      point runs for a partial segment.
 *   2. The entire segment is wrapped in matching quotation marks and an
 *      alias's text appears inside -- someone reading text aloud --
 *      -> negative, "quoted_mention".
 *   3. An alias sits at a genuine vocative boundary: the whole segment; or
 *      the segment's start (optionally preceded by a single recognized
 *      leading filler word) immediately followed by a real separator
 *      character (R41 -- see REQUIRED_SEPARATOR) and then a clause that
 *      either is empty or is a REQUEST (R43: interrogative, or opening
 *      with a request marker, and not opening with an anti-cue); or
 *      symmetrically the segment's end, immediately preceded by a real
 *      separator character and a request clause before it -> positive,
 *      "vocative_invocation".
 *   4. An alias's text appears anywhere else in the segment -> negative,
 *      "incidental_mention" (covers third-person discussion, appositive/
 *      agenda mentions, unpunctuated mentions, exclamatory idioms and
 *      non-interrogative statements beside the alias, "I asked X about it
 *      yesterday", and any hyphenated/possessive/longer-word occurrence
 *      that never had a chance to authorize).
 *   5. No alias's text anywhere -> negative, "no_alias_match".
 */
export function decide(
  segment: InvocationCandidateSegment,
  identity: InvocationGateIdentity,
): InvocationDecision {
  const segmentId = segment.segmentId;

  if (!segment.final) {
    return { segmentId, authorize: false, matchedAlias: null, reason: "non_final_segment" };
  }

  const trimmed = segment.text.trim();
  const aliases = identity.aliases
    .map((alias) => ({ alias, folded: fold(alias) }))
    .filter(({ folded }) => folded !== "");

  if (trimmed === "" || aliases.length === 0) {
    return { segmentId, authorize: false, matchedAlias: null, reason: "no_alias_match" };
  }

  const requestMarkers = [...DEFAULT_REQUEST_MARKERS, ...(identity.additionalRequestMarkers ?? [])]
    .map(fold)
    .filter((marker) => marker !== "");
  const leadingFillers = [...DEFAULT_LEADING_FILLERS, ...(identity.additionalLeadingFillers ?? [])]
    .map(fold)
    .filter((filler) => filler !== "");
  const antiCues = [...DEFAULT_ANTI_CUES, ...(identity.additionalAntiCues ?? [])]
    .map(fold)
    .filter((phrase) => phrase !== "");

  const quotedInner = stripMatchingQuotes(trimmed);
  if (quotedInner !== null) {
    const foldedInner = fold(quotedInner);
    const quotedAlias = aliases.find(({ folded }) => containsPlainSubstring(foldedInner, folded));
    if (quotedAlias) {
      return {
        segmentId,
        authorize: false,
        matchedAlias: quotedAlias.alias,
        reason: "quoted_mention",
      };
    }
  }

  const foldedText = fold(trimmed);

  const vocativeAlias = aliases.find(({ folded }) =>
    isVocativeBoundary(foldedText, folded, requestMarkers, antiCues, leadingFillers),
  );
  if (vocativeAlias) {
    return {
      segmentId,
      authorize: true,
      matchedAlias: vocativeAlias.alias,
      reason: "vocative_invocation",
    };
  }

  // Diagnostic-only fallback: NO adjacency guard here. The authorize
  // decision above is already final and negative; this only decides which
  // negative reason, and whether matchedAlias is populated, so an operator
  // sees when the configured text was present even embedded inside a
  // longer token.
  const incidentalAlias = aliases.find(({ folded }) => containsPlainSubstring(foldedText, folded));
  if (incidentalAlias) {
    return {
      segmentId,
      authorize: false,
      matchedAlias: incidentalAlias.alias,
      reason: "incidental_mention",
    };
  }

  return { segmentId, authorize: false, matchedAlias: null, reason: "no_alias_match" };
}

// ---------------------------------------------------------------------------
// The sink: apply a decision to a runtime exactly once per segmentId
// ---------------------------------------------------------------------------

/** A minimal two-method sink a decision is applied to. The real
 * implementation adapts the Conversation Runtime client (Task 5); tests use
 * an in-repo fake. Deliberately narrow -- this module does not know, and
 * does not need to know, anything about how the runtime actually speaks or
 * stays silent. */
export type InvocationSink = {
  skipVoiceResponse(segmentId: string, reason: InvocationDecisionReason): void;
  authorizeVoiceResponse(segmentId: string, matchedAlias: string): void;
};

export type InvocationDispatcher = {
  /** Applies `decision` to the sink -- exactly once per `decision.segmentId`.
   * A second call for a segmentId already applied (the runtime redelivering
   * the same finalized segment, a retry, an at-least-once duplicate) is a
   * silent no-op: it neither re-skips nor re-authorizes. The segmentId is
   * read from the decision itself, not taken as a separate argument, so a
   * caller cannot apply one segment's decision under a different segment's
   * id. */
  apply(decision: InvocationDecision): void;
};

/** Creates a dispatcher that applies decisions to `sink`, tracking which
 * segmentIds have already been applied so a repeated segment (see the
 * module doc) can never authorize -- or skip -- twice. */
export function createInvocationDispatcher(sink: InvocationSink): InvocationDispatcher {
  const applied = new Set<string>();

  return {
    apply(decision: InvocationDecision): void {
      if (applied.has(decision.segmentId)) return;
      applied.add(decision.segmentId);

      if (decision.authorize) {
        sink.authorizeVoiceResponse(decision.segmentId, decision.matchedAlias);
      } else {
        sink.skipVoiceResponse(decision.segmentId, decision.reason);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Text matching internals
// ---------------------------------------------------------------------------

const DIACRITIC = /\p{M}/gu;

/** Case- and accent-insensitive normalization, applied identically to
 * configured aliases, cues, fillers, anti-cues, and transcript text so
 * "José"/"jose"/"JOSÉ" all compare equal. */
function fold(s: string): string {
  return s.normalize("NFD").replace(DIACRITIC, "").toLowerCase();
}

const HAN_CHAR = /\p{Script=Han}/u;

/** True if `folded` contains any Han (Chinese) character. Used to decide,
 * per alias, whether the cue must open the clause as a whitespace TOKEN
 * (Latin/other scripts) or as a raw string PREFIX (Han, which has no
 * whitespace to tokenize on) -- see the module doc's multilingual note. */
function isHanText(folded: string): boolean {
  return HAN_CHAR.test(folded);
}

// Letters, digits, hyphen, underscore, and the apostrophe (straight and
// typographic) all COUNT AS the same token: a character immediately
// touching a candidate match that is one of these means the match is
// embedded in a longer identifier or a possessive, not a standalone
// occurrence of the alias. This is what keeps "Mei" out of "Mei-Ling" and
// "Mei's", "Meetbot" out of "Meetbot-api", and "meetbot" out of
// "eng-meetbot".
const WORD_CONTINUATION = /[\p{L}\p{N}\-_'’]/u;

function isWordContinuation(ch: string | undefined): boolean {
  return ch !== undefined && ch !== "" && WORD_CONTINUATION.test(ch);
}

/** A plain, folded, NO-adjacency-guard substring containment check. Used
 * ONLY on the negative/diagnostic path -- never to decide whether to
 * authorize. Deliberately the loosest possible check: it finds "mei"
 * inside "meiling" or "meetbot" inside "eng-meetbot", which is exactly the
 * point -- the alias's TEXT was present, even though it never had a chance
 * to be treated as a standalone word by the authorize-side adjacency
 * guard. */
function containsPlainSubstring(haystack: string, needle: string): boolean {
  if (needle === "") return false;
  return haystack.includes(needle);
}

// ---------------------------------------------------------------------------
// Default lexicons -- deployment configuration, extended (not replaced) by
// InvocationGateIdentity.additionalRequestMarkers / additionalLeadingFillers
// / additionalAntiCues. Cover English and Chinese; an operator deploying a
// third language adds that language's request markers, greeting fillers,
// and exclamatory idioms. The interrogative half of the request test needs
// no per-language configuration at all.
// ---------------------------------------------------------------------------

/** R43: the small, closed set of words whose only job is to MARK A
 * REQUEST. A clause that opens with one of these is an address even
 * without a question mark ("Meetbot, please summarize the decisions.",
 * "会议机器人，帮我总结一下").
 *
 * This is NOT the old address-cue lexicon under a new name. That list held
 * wh-words and modals -- "what", "how", "will", "do", "可以", "怎么" --
 * every one of which English and Chinese also use to open an exclamation or
 * a third-person remark, which is why three rounds of anti-cue patching
 * never converged. Nothing below has a non-request reading when it opens a
 * clause. Kept deliberately small and deployment-extensible via
 * InvocationGateIdentity.additionalRequestMarkers.
 *
 * The other half of the request test is punctuation, not vocabulary: a
 * clause that ends in "?"/"？" is a request whatever it opens with -- see
 * clauseIsRequest and isVocativeBoundary. */
const DEFAULT_REQUEST_MARKERS: readonly string[] = [
  "please",
  "kindly",
  "请",
  "麻烦",
  "帮我",
  "帮忙",
];

/** R43 refinement (round 6): the evidence a clause must carry, ANYWHERE in
 * it, before interrogative punctuation is allowed to mean "request".
 *
 * A question mark alone says a question was asked; it does not say who was
 * asked. "Meetbot, is it broken?" and "Meetbot, did you catch that?" are
 * the same shape, and the difference between them is one word: "it" versus
 * "you". A clause with no wh-word, no second-person pronoun and no request
 * marker carries no evidence that anybody was addressed at all --
 * "seriously?", "right?", "the note taker?", "or Otter?", "next topic" --
 * and those are precisely the false positives the punctuation test let
 * through on its own.
 *
 * Both lists are closed grammatical classes, not idiom enumerations. That
 * is the whole difference between this conjunct and the address-cue
 * lexicon R43 deleted: the cue list asked which word OPENS the clause (an
 * exclamative opens the same way a question does), while this asks whether
 * the clause contains, anywhere, a word that can only be doing deictic or
 * interrogative work.
 *
 * R47 (round 7) narrows the wh half only: a wh-word evidences address ONLY
 * when an auxiliary or modal immediately follows it. See AUXILIARIES. */
const WH_WORDS: readonly string[] = [
  "what",
  "when",
  "where",
  "who",
  "whom",
  "whose",
  "which",
  "why",
  "how",
];

/** Second-person reference: the clearest evidence in English that a clause
 * addresses somebody. "yourselves" is the one entry beyond the four the
 * ruling named -- same closed class, same job. */
const SECOND_PERSON: readonly string[] = ["you", "your", "yours", "yourself", "yourselves"];

/** R47 (round 7): the closed set of auxiliaries and modals that must
 * IMMEDIATELY follow a wh-word before it counts as evidence of address.
 *
 * Round 6 accepted a wh-word anywhere in an interrogative clause. It is not
 * evidence on its own: English uses the same wh-words to open a rhetorical
 * or exclamatory fragment ABOUT something -- "what garbage", "how awful",
 * "why bother", "who cares" -- and a transcriber who punctuates one of
 * those with a question mark had the agent speaking into a conversation it
 * was not part of. Every one of those authorized before this rule.
 *
 * The discriminator is grammar, not another idiom list: a genuine wh-
 * question inverts the subject and the auxiliary ("what DID we decide") or
 * uses the copula ("what IS it"), so an auxiliary sits immediately after
 * the wh-word. A rhetorical fragment is wh + noun or wh + bare verb and has
 * nowhere for one to go. This list is exactly the ruling's, unextended. */
const AUXILIARIES: readonly string[] = [
  "do",
  "does",
  "did",
  "is",
  "are",
  "was",
  "were",
  "am",
  "can",
  "could",
  "will",
  "would",
  "shall",
  "should",
  "have",
  "has",
  "had",
  "may",
  "might",
  "must",
];

/** The contracted forms of the same auxiliaries, as they survive the
 * apostrophe split: "what's" -> what + s (is/has), "who're" -> who + re
 * (are), "what'll" -> what + ll (will), "what'd" -> what + d (had/would),
 * "what've" -> what + ve (have).
 *
 * These are not an extension of the ruling's list, they ARE that list: the
 * clitic is the auxiliary, merely written joined. Without them "Meetbot:
 * what's the plan?" and "Meetbot, who's next?" -- two genuine questions the
 * suite already pinned -- would have become collateral of R47. As closed a
 * class as the auxiliaries themselves. */
const AUXILIARY_CLITICS: readonly string[] = ["s", "re", "ll", "d", "ve"];

/** Short address/greeting fillers that may precede a leading vocative
 * ("Hey Meetbot, ...") without defeating the start-boundary check. Only
 * recognized as a whole leading token -- see the filler-matching loop in
 * isVocativeBoundary. */
const DEFAULT_LEADING_FILLERS: readonly string[] = [
  "hey",
  "hi",
  "hello",
  "so",
  "ok",
  "okay",
  "um",
  "uh",
  "嗯",
  "那",
  "好",
  "喂",
];

/** A closed set of exclamatory idioms that are never a genuine address.
 *
 * Under R43 these are the answer to ONE specific hole in the interrogative
 * test: an exclamation a transcriber (or an over-eager ASR punctuator)
 * wrote with a question mark -- "Meetbot, what a mess?",
 * "会议机器人，什么鬼？". Without the question mark the request test already
 * rejects every one of them, so this list is now a narrow guard on a
 * punctuation accident rather than the load-bearing rule it was in round 4.
 * Checked FIRST, before the interrogative and marker tests, in both leading
 * and trailing positions. Matched as a whole-phrase prefix of the clause
 * (see clauseStartsWithPhrase) and extendable via
 * InvocationGateIdentity.additionalAntiCues. */
const DEFAULT_ANTI_CUES: readonly string[] = [
  "what a",
  "what an",
  "what the",
  "how about",
  "how dare",
  "why me",
  "do tell",
  // Deliberately the FULL idiom "would you look at that", not the bare
  // "would you look" -- round 4's adversarial probing found that the
  // shorter phrase also swallowed a genuine request ("Meetbot, would you
  // look into this bug?").
  "would you look at that",
  // Chinese exclamatory slang. Matched as a raw prefix (Chinese has no
  // whitespace), so "什么鬼啊" is caught too -- see clauseStartsWithPhrase.
  "什么鬼",
  "什么玩意",
];

// A REAL clause separator: comma, colon, or their CJK full-width forms.
// R41: this is now the ONLY thing that opens the door to a cue-lexicon
// check at all, on EITHER side of the alias -- deliberately narrower than
// "any non-word-continuation character" (round 2/3's rule), which is what
// let bare word-adjacency ("Meetbot usually handles...", "Please don't
// blame Meetbot.") stand in for a real address signal. Because a real
// separator is by construction never a letter/digit/hyphen/underscore/
// apostrophe, this single requirement also subsumes round 1-3's
// word-continuation adjacency guard for BOTH the start and end position,
// in BOTH scripts -- no Han/Latin branching is needed here at all anymore.
const REQUIRED_SEPARATOR = /[,:，：]/u;

// Characters stripped from BOTH edges when testing "the alias is the whole
// segment": whitespace, sentence-final punctuation, quote/bracket
// characters (straight, curly, CJK corner/guillemet), and clause
// separators (comma/colon/semicolon, plus their CJK full-width/
// ideographic equivalents). Deliberately does NOT include hyphen/dash or
// apostrophe -- see WORD_CONTINUATION.
const EDGE_STRIP =
  /^[\s.,!?…:;'"“”‘’「」『』«»()[\]、，。！？：；]+|[\s.,!?…:;'"“”‘’«»「」『』()[\]、，。！？：；]+$/gu;

// Only the trailing run, used before an end-position check so a trailing
// "?"/"!"/closing quote after the alias doesn't block the match while
// still leaving a real preceding separator (a comma) intact for
// inspection.
const TRAILING_EDGE = /[\s.,!?…:;'"“”‘’«»「」『』()[\]、，。！？：；]+$/u;

// Leading/trailing separator runs stripped when extracting the clause that
// adjoins a matched alias, so "  , what did we decide?" -> "what did we
// decide?" and "can you take a note,  " -> "can you take a note".
const LEADING_CLAUSE_STRIP = /^[\s,:;、，：；.!?]+/u;
const TRAILING_CLAUSE_STRIP = /[\s,:;、，：；.!?]+$/u;

// A clause-boundary character: comma, period, semicolon, colon, question
// mark, exclamation mark, or their CJK full-width equivalents. Used to
// BOUND how much of the segment is even eligible for a cue lookup -- this
// is what stops "Meetbot, the note taker, did leave early." from ever
// considering "did" (in the clause beyond the first comma) at all.
const CLAUSE_BOUNDARY = /[,.;:?!，。；：？！]/u;

// R43: the interrogative half of the request test. A question mark --
// straight or CJK full-width -- is the one punctuation mark ASR emits that
// genuinely separates a question from an exclamation, and it is what
// "what a mess", "how ridiculous", "will you look at that",
// "可以处理很多任务" and "怎么老是这样" all lack.
const INTERROGATIVE_TERMINATOR = /[?？]/u;

/** Only the text after the LAST clause-boundary character, or the whole
 * string if none exists. Used for a TRAILING vocative: the clause
 * immediately before the alias, even when an earlier sentence precedes it
 * ("We talked yesterday, can you take a note, Meetbot?" -> "can you take a
 * note", not the whole preceding sentence). */
function truncateAtPreviousClauseBoundary(s: string): string {
  let lastIdx = -1;
  for (let i = 0; i < s.length; i += 1) {
    if (CLAUSE_BOUNDARY.test(s.charAt(i))) lastIdx = i;
  }
  return lastIdx === -1 ? s : s.slice(lastIdx + 1);
}

/** True if `clause` (already folded) opens with `phrase`.
 *
 * For a Latin phrase that means the clause equals it exactly or is followed
 * by a space -- so "what a" matches "what a mess" but not "what another
 * day". For a phrase containing Han characters there is no whitespace to
 * anchor on, so a raw string prefix is the boundary: "什么鬼" matches both
 * "什么鬼" and "什么鬼啊". */
function clauseStartsWithPhrase(clause: string, phrase: string): boolean {
  if (phrase === "") return false;
  if (isHanText(phrase)) return clause.startsWith(phrase);
  return clause === phrase || clause.startsWith(`${phrase} `);
}

/** The whitespace-delimited WORDS of `clause`, each split at any internal
 * apostrophe into its pieces and stripped of leading and trailing non-
 * alphanumerics: "what's" -> ["what", "s"], "plan?" -> ["plan"]. Empty
 * pieces and empty words are dropped.
 *
 * Word structure is preserved (rather than flattened straight to a token
 * list) because R47 asks what immediately FOLLOWS a wh-word, and because a
 * contraction's second piece is a clitic auxiliary attached to the first
 * piece, not a free-standing word of its own. */
function clauseWords(clause: string): string[][] {
  return clause
    .split(/\s+/u)
    .map((token) =>
      token
        .split(/['\u2019]/u)
        .map((piece) => piece.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
        .filter((piece) => piece !== ""),
    )
    .filter((word) => word.length > 0);
}

/** True when `clause` carries evidence that somebody was addressed -- the
 * conjunct the interrogative branch of the request test requires:
 *
 *   - a second-person pronoun or a request marker, anywhere (unchanged);
 *   - a wh-word IMMEDIATELY followed by an auxiliary or modal, either as
 *     the next word or as its own contracted clitic (R47).
 *
 * See WH_WORDS / SECOND_PERSON / AUXILIARIES / AUXILIARY_CLITICS. */
function clauseCarriesAddressEvidence(clause: string, requestMarkers: readonly string[]): boolean {
  const words = clauseWords(clause);

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === undefined) continue;

    for (const piece of word) {
      if (SECOND_PERSON.includes(piece) || requestMarkers.includes(piece)) return true;
    }

    const stem = word[0];
    if (stem === undefined || !WH_WORDS.includes(stem)) continue;

    // "what's" / "who're" / "what'll": the auxiliary is the clitic itself.
    const clitic = word[1];
    if (clitic !== undefined && AUXILIARY_CLITICS.includes(clitic)) return true;

    // "what did" / "how should": the auxiliary is the very next word. Not a
    // later one -- "who cares, is anyone reading these" must not have
    // "cares" rescued by an "is" in a different clause.
    const nextStem = words[i + 1]?.[0];
    if (nextStem !== undefined && AUXILIARIES.includes(nextStem)) return true;
  }

  return false;
}

/** The first whitespace-delimited token of `clause`, stripped of leading and
 * trailing non-alphanumerics. "" when the clause has no such token. */
function firstToken(clause: string): string {
  const raw = clause.split(/\s+/u)[0] ?? "";
  return raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/**
 * R43 -- the request test. True if `clause` (already folded, already
 * bounded to the clause adjoining the alias, already trimmed) is a REQUEST,
 * and therefore an address rather than a mention.
 *
 * In order:
 *   1. An EMPTY clause -- the alias plus an optional filler was essentially
 *      the whole utterance -- is an address. There is no clause content for
 *      anything to hide in.
 *   2. A clause opening with a recognized exclamatory anti-cue is NOT an
 *      address, whatever else is true of it. This is the guard against an
 *      exclamation someone punctuated as a question.
 *   3. A Chinese clause must carry an explicit request marker, matched as a
 *      raw prefix -- see THE HAN CARVE-OUT below.
 *   4. Otherwise an INTERROGATIVE clause is a request IF it also carries
 *      evidence that somebody was addressed -- a wh-word, a second-person
 *      pronoun, or a request marker, anywhere in the clause (round 6\'s
 *      refinement; see clauseCarriesAddressEvidence). `interrogative` is
 *      computed by the caller, because where the question mark lives
 *      depends on which side of the alias the clause is on -- see
 *      isVocativeBoundary.
 *   5. So is a clause whose first token is a request marker, question mark
 *      or not.
 * Anything else is a mention.
 *
 * The script test is on the CLAUSE, not on the alias: how to read a clause
 * follows from the language the clause is written in, not from the language
 * the agent happens to be named in.
 *
 * THE HAN CARVE-OUT (round 5, from this round's own adversarial probing,
 * not from the ruling). Chinese fronts a topic before a comma as a matter
 * of ordinary grammar: "会议机器人，是不是又坏了？" is "as for Meetbot, is it
 * broken again?", a question ABOUT the agent put to a human, and it is
 * structurally identical to a vocative followed by a question.
 * Interrogative punctuation therefore does not discriminate in Chinese the
 * way it does in English, and accepting it authorized a whole family of
 * probed false positives ("会议机器人，怎么老是这样？",
 * "会议机器人，可以处理很多任务吗？", "会议机器人，为什么大家都在讨论它？").
 * Requiring a marker closes that class outright rather than shrinking it by
 * enumeration, and it costs no required positive -- every Chinese positive
 * in the acceptance list is marker-based. What it does cost is a documented
 * false negative: "会议机器人，能总结一下吗？" (a genuine marker-free polite
 * question) no longer authorizes, and an operator whose meetings phrase
 * requests that way adds their own marker via additionalRequestMarkers.
 * That trade is the standing ruling applied literally: false positives are
 * zero-tolerance, documented false negatives are acceptable.
 */
function clauseIsRequest(
  clause: string,
  interrogative: boolean,
  requestMarkers: readonly string[],
  antiCues: readonly string[],
): boolean {
  if (clause === "") return true;

  if (antiCues.some((phrase) => clauseStartsWithPhrase(clause, phrase))) return false;

  if (isHanText(clause)) {
    return requestMarkers.some((marker) => marker !== "" && clause.startsWith(marker));
  }

  if (interrogative && clauseCarriesAddressEvidence(clause, requestMarkers)) return true;

  const opener = firstToken(clause);
  return opener !== "" && requestMarkers.includes(opener);
}

/**
 * True when `foldedAlias` sits at a genuine vocative boundary of
 * `foldedText`: either the alias IS the entire segment (after stripping
 * edge whitespace/punctuation); or the alias is at the segment's start
 * (optionally preceded by a single recognized leading filler word) with
 * either nothing else following at all, or a REAL separator character
 * (REQUIRED_SEPARATOR -- R41) immediately after it and then a clause that
 * passes the request test (R43 -- clauseIsRequest); or symmetrically the
 * segment's end, with a real separator character immediately before it and
 * a request clause before that.
 *
 * The interrogative half of the request test is computed here, per
 * position, because the question mark of a vocative question does not sit
 * in the same place on the two sides:
 *   - LEADING ("Meetbot, can you hear me?") -- the clause runs from the
 *     separator to the next clause boundary, and THAT boundary character is
 *     the clause's terminator. It is interrogative if it is "?" or "？".
 *   - TRAILING ("Can you take a note, Meetbot?") -- the question mark falls
 *     after the alias, at the very end of the segment, so the segment's own
 *     terminal punctuation is what is tested.
 *
 * A real separator is, by construction, never a word-continuation
 * character in either script, so no additional Han/Latin-specific
 * adjacency guard is needed here at all -- see REQUIRED_SEPARATOR.
 */
function isVocativeBoundary(
  foldedText: string,
  foldedAlias: string,
  requestMarkers: readonly string[],
  antiCues: readonly string[],
  leadingFillers: readonly string[],
): boolean {
  if (foldedAlias === "") return false;

  const core = foldedText.replace(EDGE_STRIP, "");
  if (core === foldedAlias) return true;

  // START: try the segment's literal start, then (for each recognized
  // leading filler) the text immediately after that filler.
  const startOffsets: number[] = [0];
  for (const filler of leadingFillers) {
    if (filler === "" || !foldedText.startsWith(filler)) continue;
    const afterFiller = foldedText.slice(filler.length);
    const nextChar = afterFiller.charAt(0);
    // The filler itself must be a whole token, not a prefix of a longer
    // word (e.g. "hello" must not match inside "hellofriends").
    if (nextChar !== "" && isWordContinuation(nextChar)) continue;
    const skipped = afterFiller.replace(LEADING_CLAUSE_STRIP, "");
    startOffsets.push(foldedText.length - skipped.length);
  }

  for (const offset of startOffsets) {
    const candidate = foldedText.slice(offset);
    if (!candidate.startsWith(foldedAlias)) continue;
    const remainder = candidate.slice(foldedAlias.length);
    const trimmedRemainder = remainder.replace(/^\s+/u, "");
    if (trimmedRemainder === "") {
      // A leading filler (if any) plus the alias, with nothing else at
      // all following -- e.g. "Hey Meetbot" alone. Zero clause content
      // means there is nothing for a non-request statement to hide in, so
      // this is treated the same as the whole-segment case rather than
      // requiring a separator that has nothing to separate.
      return true;
    }
    const separatorChar = trimmedRemainder.charAt(0);
    if (!REQUIRED_SEPARATOR.test(separatorChar)) continue;
    const stripped = trimmedRemainder.replace(LEADING_CLAUSE_STRIP, "");
    const boundaryIdx = stripped.search(CLAUSE_BOUNDARY);
    const clause = (boundaryIdx === -1 ? stripped : stripped.slice(0, boundaryIdx)).trim();
    const terminator = boundaryIdx === -1 ? "" : stripped.charAt(boundaryIdx);
    const interrogative = INTERROGATIVE_TERMINATOR.test(terminator);
    if (clauseIsRequest(clause, interrogative, requestMarkers, antiCues)) return true;
  }

  // END: the segment's literal end (after stripping trailing terminal
  // punctuation/quotes), requiring an actual separator character
  // immediately before the alias (R41).
  const textEnd = foldedText.replace(TRAILING_EDGE, "");
  if (textEnd.endsWith(foldedAlias)) {
    const prefixFull = textEnd.slice(0, textEnd.length - foldedAlias.length);
    // The character that must be a real separator is the last NON-
    // WHITESPACE character before the alias, not merely the last
    // character -- "that, Meetbot" has a space between the comma and the
    // alias.
    const trimmedPrefix = prefixFull.replace(/\s+$/u, "");
    const separatorChar = trimmedPrefix.length > 0 ? trimmedPrefix.charAt(trimmedPrefix.length - 1) : "";
    if (separatorChar !== "" && REQUIRED_SEPARATOR.test(separatorChar)) {
      const stripped = prefixFull.replace(TRAILING_CLAUSE_STRIP, "");
      const clause = truncateAtPreviousClauseBoundary(stripped).trim();
      const interrogative = segmentIsInterrogative(foldedText);
      if (clauseIsRequest(clause, interrogative, requestMarkers, antiCues)) return true;
    }
  }

  return false;
}

// Closing wrappers stripped before reading a segment's terminal
// punctuation: whitespace and closing quote/bracket characters, but NOT
// punctuation itself -- the punctuation is exactly what is being read.
const TRAILING_WRAPPER = /[\s'"“”‘’«»」』)\]]+$/u;

/** True when the whole segment ends in a question mark (straight or CJK
 * full-width), ignoring any closing quote/bracket after it. This is the
 * interrogative signal for a TRAILING vocative, where the question mark
 * falls after the alias rather than inside the clause. */
function segmentIsInterrogative(foldedText: string): boolean {
  const unwrapped = foldedText.replace(TRAILING_WRAPPER, "");
  return INTERROGATIVE_TERMINATOR.test(unwrapped.charAt(unwrapped.length - 1));
}

// Matching open/close quote pairs recognized when they wrap the ENTIRE
// trimmed segment: straight and curly double/single quotes, guillemets,
// and CJK corner brackets.
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"], // “ ”
  ["‘", "’"], // ‘ ’
  ["«", "»"], // « »
  ["「", "」"], // 「 」
  ["『", "』"], // 『 』
];

/** If `trimmed` is entirely wrapped in a matching quote pair (with at least
 * one character of content inside), returns the trimmed inner content.
 * Otherwise returns null. Used to catch "somebody reading a sentence aloud
 * that contains the name": the whole segment IS the quoted sentence. */
function stripMatchingQuotes(trimmed: string): string | null {
  for (const [open, close] of QUOTE_PAIRS) {
    if (
      trimmed.length > open.length + close.length &&
      trimmed.startsWith(open) &&
      trimmed.endsWith(close)
    ) {
      return trimmed.slice(open.length, trimmed.length - close.length).trim();
    }
  }
  return null;
}
