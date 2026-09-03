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
//     said he can help with that") is negative for the same reason, EVEN
//     WHEN a cue word appears somewhere later in the sentence -- the cue
//     must OPEN the clause immediately adjoining the alias, not merely
//     occur anywhere in it.
//   - An appositive/agenda-style mention ("Meetbot, the note taker, is
//     broken again.", "Agenda: Meetbot") is negative -- the alias sits at
//     a segment edge with a separator, but the adjoining clause never
//     actually opens with an address to it.
//   - An exclamatory idiom that happens to start with a cue word ("Meetbot,
//     what a mess.", "Meetbot, how dare you.") is negative -- see ROUND 4's
//     anti-cue list below.
//   - A quoted mention (somebody reading a sentence aloud that happens to
//     contain the name) is negative.
//   - A short alias must never fire merely because it is a textual prefix
//     or suffix of a longer, unrelated token -- a human name ("Mei" vs
//     "Meiling"), a possessive ("Mei's"), or a compound identifier
//     ("Meetbot-api", "eng-meetbot").
//   - A mention with NO real separator between the alias and the adjoining
//     text is negative, full stop -- see ROUND 4 (R41) below. This is what
//     "Meetbot usually handles the notes" and "Please don't blame
//     Meetbot." both fail on, and it is also why two formerly-required
//     positives ("Meetbot what did we decide", "会议机器人总结一下") are now
//     documented known limitations instead of authorizing.
//   - A partial transcript NEVER authorizes, whatever it contains. This is
//     structural: finality is the first thing decide() checks, and nothing
//     below that check can produce a positive outcome for a partial
//     segment -- see decide() below.
//
// ROUND 4 (R41, third post-review pass): the no-separator authorize path
// was itself the recurring root cause across rounds 2 and 3 -- both
// Critical findings traced back to "alias directly touching more text,
// with only a cue-lexicon check standing between that and authorize."
// R41 removes that path entirely: authorize now requires EITHER the alias
// to be the whole utterance, OR an actual separator character (comma,
// colon, or their CJK full-width forms -- REQUIRED_SEPARATOR) immediately
// on the side of the alias facing the adjoining clause. No separator, no
// authorize, regardless of what cue words follow. This is strictly
// narrower than round 3: two formerly-required positives no longer
// authorize --
//   - "Meetbot what did we decide" (no punctuation at all)
//   - "会议机器人总结一下" (no punctuation at all)
// -- and are pinned as documented known limitations (see the test file)
// rather than silently dropped. The upside: this single change also
// eliminates an entire class of Chinese false positives on its own
// (ordinary declarative sentences with the alias as subject and no comma
// after it, e.g. "会议机器人可以处理很多任务") without any Han-specific
// carve-out, because a required separator is by definition never a
// word-continuation character in EITHER script -- so R41 also removes the
// last vestige of Han/Latin branching in the boundary-adjacency check
// itself (only clauseIsAddress's OPENS-WITH check remains script-specific).
//
// R41 also removes "总结" from the Chinese cue list: it existed only to
// make the now-removed unpunctuated positive reachable, and keeping it
// would let a punctuated but non-address clause like "会议机器人，总结起来
// 都是问题" ("summarizing, it's all problems" -- an idiom, not a request)
// authorize on the same ambiguity the English cue list already avoids by
// excluding copulas.
//
// A second, independent fix this round: an ANTI-CUE list
// (DEFAULT_ANTI_CUES). A comma-separated clause that opens with a cue WORD
// used as ordinary exclamatory vocabulary ("Meetbot, what a mess.",
// "Meetbot, how dare you.", "What a mess, Meetbot.") is not an address,
// whatever cue word starts it. Anti-cues are checked BEFORE cues, in both
// leading and trailing positions, and are a small, closed, stable set of
// idioms -- a narrower and more stable surface than the cue list itself,
// and (like the cue/filler lists) extendable via
// InvocationGateIdentity.additionalAntiCues.
//
// Multilingual note: a "word boundary" only exists as whitespace in
// space-delimited languages, and Chinese has none at all. This module
// therefore uses two different mechanisms for "does the cue open the
// clause" depending on the alias's own script (Script=Han vs not) --
// clauseIsAddress's token-based check for Latin, prefix-based for Han --
// but ONE mechanism for everything else (the separator requirement, clause
// truncation at the next real punctuation boundary, anti-cue matching),
// applied identically to both. Coverage: the shipped defaults distinguish
// address from mention in English and Chinese; an operator deploying a
// third language passes additionalAddressCues/additionalLeadingFillers/
// additionalAntiCues with that language's question words, request modals,
// greeting fillers, and exclamatory idioms.

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
 * `additionalAddressCues`, `additionalLeadingFillers`, and
 * `additionalAntiCues` EXTEND the shipped defaults (see DEFAULT_ADDRESS_CUES
 * / DEFAULT_LEADING_FILLERS / DEFAULT_ANTI_CUES below) -- they never
 * replace them. This is deployment configuration, the same class of thing
 * the aliases already are: closed lists of literal words/phrases, not a
 * pattern language, not a scoring model. */
export type InvocationGateIdentity = {
  readonly aliases: readonly string[];
  readonly additionalAddressCues?: readonly string[];
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
 *      either is empty or is an address (opens with a cue and does not
 *      open with an anti-cue); or symmetrically the segment's end,
 *      immediately preceded by a real separator character and an address
 *      clause before it -> positive, "vocative_invocation".
 *   4. An alias's text appears anywhere else in the segment -> negative,
 *      "incidental_mention" (covers third-person discussion, appositive/
 *      agenda mentions, unpunctuated mentions, exclamatory idioms, "I asked
 *      X about it yesterday", and any hyphenated/possessive/longer-word
 *      occurrence that never had a chance to authorize).
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

  const addressCues = [...DEFAULT_ADDRESS_CUES, ...(identity.additionalAddressCues ?? [])]
    .map(fold)
    .filter((cue) => cue !== "");
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
    isVocativeBoundary(foldedText, folded, addressCues, antiCues, leadingFillers),
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
// InvocationGateIdentity.additionalAddressCues / additionalLeadingFillers /
// additionalAntiCues. Cover English and Chinese; an operator deploying a
// third language adds that language's question words / request modals /
// greeting fillers / exclamatory idioms.
// ---------------------------------------------------------------------------

/** Words that mark the clause immediately adjoining the alias as an actual
 * address -- a question or a request -- rather than a third-person or
 * appositive mention. A cue only counts when it OPENS the (already
 * boundary-truncated) clause AND the clause does not open with an
 * anti-cue -- see clauseIsAddress. Deliberately excludes generic copulas
 * ("is"/"are"): including them would turn appositive mentions like
 * "Meetbot, the note taker, is broken again." into false positives even
 * with clause truncation.
 *
 * "总结" (summarize) was removed in round 4 (R41): it existed only to
 * make an unpunctuated CJK positive reachable, and that positive itself
 * was removed as a required case -- keeping the cue would have let a
 * punctuated idiom ("总结起来", "in summary") falsely authorize instead. */
const DEFAULT_ADDRESS_CUES: readonly string[] = [
  // English: wh-question words, yes/no-question modals/auxiliaries, and
  // the one politeness marker that reliably signals a request.
  "what",
  "who",
  "where",
  "when",
  "why",
  "how",
  "can",
  "could",
  "would",
  "will",
  "do",
  "does",
  "did",
  "please",
  // Chinese: question particles/words and request markers. "吗"/"呢" are
  // grammatically clause-final in ordinary Chinese and so rarely satisfy
  // the strict-prefix Han rule below in practice (a known, documented
  // limitation -- see the test file) -- kept anyway since they are
  // harmless and occasionally fire in unusual phrasing.
  "请",
  "一下",
  "可以",
  "能不能",
  "能否",
  "什么",
  "谁",
  "哪里",
  "为什么",
  "怎么",
  "吗",
  "呢",
];

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

/** ROUND 4: a closed set of exclamatory idioms that open with an ordinary
 * cue WORD but are never a genuine address, whatever follows --
 * "Meetbot, what a mess." opens with "what" (a cue) but is not a question
 * to Meetbot. Checked BEFORE the cue list, in both leading and trailing
 * positions -- see clauseIsAddress. A small, closed, stable set of
 * multi-word phrases, deliberately narrower and more stable than the cue
 * list itself (an open class of question words and modals). Matched as a
 * whole-phrase PREFIX of the clause (the phrase itself, or the phrase
 * followed by a word boundary) so "how about" does not fire inside an
 * unrelated longer word. */
const DEFAULT_ANTI_CUES: readonly string[] = [
  "what a",
  "what an",
  "what the",
  "how about",
  "how dare",
  "why me",
  "do tell",
  // Deliberately the FULL idiom "would you look at that", not the bare
  // "would you look" -- found by adversarial probing that the shorter
  // phrase also swallowed a genuine request ("Meetbot, would you look
  // into this bug?"). The full idiom still catches the named exclamatory
  // example while no longer colliding with "look into"/"look over"/etc.
  "would you look at that",
  // Chinese: found by adversarial probing (not named by the review) --
  // both are unambiguous exclamatory slang that happen to open with the
  // cue "什么" ("what"), the same bug class as the English "what a mess"
  // idiom, and just as closed/stable a set.
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

/** Only the text up to (not including) the next clause-boundary character,
 * or the whole string if none exists. Used for a LEADING vocative: the
 * clause immediately after the alias. */
function truncateAtNextClauseBoundary(s: string): string {
  const idx = s.search(CLAUSE_BOUNDARY);
  return idx === -1 ? s : s.slice(0, idx);
}

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

/** True if `clause` (already folded) either equals `phrase` exactly or
 * starts with `phrase` followed by a word boundary (space) -- so "what a"
 * matches "what a mess" but not "what another day" (a real word, not the
 * same phrase, would otherwise falsely match a bare string prefix). */
function clauseStartsWithPhrase(clause: string, phrase: string): boolean {
  if (phrase === "") return false;
  return clause === phrase || clause.startsWith(`${phrase} `);
}

/** True if `clause` (already folded, already bounded to the adjoining
 * clause via truncateAtNext/PreviousClauseBoundary, already trimmed)
 * either has no content at all -- the alias plus an optional filler was
 * essentially the whole utterance -- or is a genuine ADDRESS: it does not
 * open with a recognized anti-cue idiom (checked first -- ROUND 4), and it
 * opens with one of `cues`.
 *
 * "Opens with" means: for a Latin/other-script alias, one of the clause's
 * first two whitespace-separated tokens exactly equals a cue word (not "a
 * cue word appears somewhere in the clause"), or that same token with a
 * trailing wh-word contraction ("'s"/"’s") removed. For a Han-script
 * alias, the clause's raw text starts with a Han cue as a literal prefix,
 * since Chinese has no whitespace to tokenize on. */
function clauseIsAddress(
  clause: string,
  cues: readonly string[],
  antiCues: readonly string[],
  aliasIsHan: boolean,
): boolean {
  if (clause === "") return true;

  if (antiCues.some((phrase) => clauseStartsWithPhrase(clause, phrase))) return false;

  if (aliasIsHan) {
    return cues.some((cue) => cue !== "" && isHanText(cue) && clause.startsWith(cue));
  }

  const tokens = clause
    .split(/\s+/u)
    .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((token) => token !== "");
  const firstTwo = tokens.slice(0, 2);
  return firstTwo.some((token) => {
    if (cues.includes(token)) return true;
    // A wh-word contraction ("what's", "who's", "where's", ...) is an
    // extremely common way to open a real question; the apostrophe
    // survives token-edge stripping since it's internal to the token, not
    // at either edge.
    const contracted = token.replace(/['’]s$/u, "");
    return contracted !== token && cues.includes(contracted);
  });
}

/**
 * True when `foldedAlias` sits at a genuine vocative boundary of
 * `foldedText`: either the alias IS the entire segment (after stripping
 * edge whitespace/punctuation); or the alias is at the segment's start
 * (optionally preceded by a single recognized leading filler word) with
 * either nothing else following at all, or a REAL separator character
 * (REQUIRED_SEPARATOR -- R41) immediately after it and then a clause that
 * is an address; or symmetrically the segment's end, with a real separator
 * character immediately before it and an address clause before that.
 *
 * A real separator is, by construction, never a word-continuation
 * character in either script, so no additional Han/Latin-specific
 * adjacency guard is needed here at all -- see REQUIRED_SEPARATOR.
 */
function isVocativeBoundary(
  foldedText: string,
  foldedAlias: string,
  addressCues: readonly string[],
  antiCues: readonly string[],
  leadingFillers: readonly string[],
): boolean {
  if (foldedAlias === "") return false;

  const core = foldedText.replace(EDGE_STRIP, "");
  if (core === foldedAlias) return true;

  const aliasIsHan = isHanText(foldedAlias);

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
      // means zero risk of the cue-anywhere/bare-adjacency abuse R41
      // exists to close, so this is treated the same as the whole-segment
      // case rather than requiring a separator that has nothing to
      // separate.
      return true;
    }
    const separatorChar = trimmedRemainder.charAt(0);
    if (!REQUIRED_SEPARATOR.test(separatorChar)) continue;
    const stripped = trimmedRemainder.replace(LEADING_CLAUSE_STRIP, "");
    const clause = truncateAtNextClauseBoundary(stripped).trim();
    if (clauseIsAddress(clause, addressCues, antiCues, aliasIsHan)) return true;
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
      if (clauseIsAddress(clause, addressCues, antiCues, aliasIsHan)) return true;
    }
  }

  return false;
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
