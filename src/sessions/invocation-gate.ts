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
//     occur anywhere in it. See ROUND 3 below.
//   - An appositive/agenda-style mention ("Meetbot, the note taker, is
//     broken again.", "Agenda: Meetbot") is negative -- the alias sits at
//     a segment edge with a separator, but the adjoining clause never
//     actually opens with an address to it.
//   - A quoted mention (somebody reading a sentence aloud that happens to
//     contain the name) is negative.
//   - A short alias must never fire merely because it is a textual prefix
//     or suffix of a longer, unrelated token -- a human name ("Mei" vs
//     "Meiling"), a possessive ("Mei's"), or a compound identifier
//     ("Meetbot-api", "eng-meetbot").
//   - A trailing mention with no real separator before it ("Please don't
//     blame Meetbot.") is negative -- word-adjacency alone (as opposed to
//     comma/colon/semicolon) is too weak a signal at the END of an
//     utterance, where the name is at least as likely to be a grammatical
//     object as an addressee. See ROUND 3 below.
//   - A partial transcript NEVER authorizes, whatever it contains. This is
//     structural: finality is the first thing decide() checks, and nothing
//     below that check can produce a positive outcome for a partial
//     segment -- see decide() below.
//
// ROUND 3 (post-second-review) design, replacing round 2's "cue anywhere in
// the unbounded remainder" check: two post-review passes each reproduced
// real false positives round 1/round 2's fixture lists never contained.
// The lesson taken: bound the scope of every check to exactly the clause
// immediately touching the alias, never "the rest of the segment."
//
//   1. The adjoining clause is truncated at the next clause-boundary
//      character (comma/period/semicolon/colon/question/exclamation, or
//      the CJK full-width equivalents) before any cue lookup runs -- see
//      truncateAtNextClauseBoundary / truncateAtPreviousClauseBoundary.
//      "Meetbot said he can help with that." truncates the adjoining
//      clause to "said he" (English has no boundary character there, so
//      the cue-position rule below is what actually rejects it); "Meetbot,
//      the note taker, did leave early." truncates to "the note taker" at
//      the first comma, so "did" (in the clause beyond it) is never
//      reached at all.
//   2. The cue must OPEN that bounded clause, not merely occur somewhere
//      in it -- checked against the clause's first two whitespace tokens
//      for a Latin/other-script alias (exact token match, so "can" at
//      position 3 of "said he can help" does not count), or as a strict
//      string PREFIX of the clause for a Han-script alias (Chinese has no
//      whitespace to tokenize on, so "prefix" is the closest analogue --
//      "会议机器人总结一下"'s adjoining clause "总结一下" opens with the
//      cue "总结"; "会议机器人今天什么都没做"'s clause "今天什么都没做"
//      does NOT open with "什么", even though it contains it, because
//      "今天" comes first).
//   3. For a TRAILING vocative specifically, an actual clause-separator
//      character (comma/colon/semicolon, or their CJK full-width/
//      ideographic equivalents) is now REQUIRED immediately before the
//      alias -- plain whitespace is no longer sufficient. This is
//      asymmetric with the LEADING position on purpose: a name that opens
//      an utterance is, in ordinary speech, overwhelmingly likely to be a
//      genuine address ("Meetbot what did we decide" needs no comma to be
//      understood as a vocative); a name that merely trails the last word
//      of a sentence with no separator at all is at least as likely to be
//      a grammatical OBJECT ("Please don't blame Meetbot.") as an
//      addressee, and every required trailing-position positive fixture
//      already carries a comma. Because this requirement is itself a
//      punctuation character, it is automatically also a stronger
//      word-continuation guard than round 2's "next char is not a letter"
//      check -- no hyphen, apostrophe, or letter can ever satisfy it.
//   4. `WORD_CONTINUATION` (the guard that keeps a short alias from firing
//      inside a longer token, e.g. "Mei" inside "Meiling" or
//      "Meetbot-api") now also includes the apostrophe/typographic
//      apostrophe, so a possessive ("Mei's phone") is treated the same way
//      as a hyphenated compound: the alias is embedded in a longer token,
//      not a standalone occurrence, and is never even considered as a
//      boundary candidate.
//   5. `matchedAlias` and the `incidental_mention`/`no_alias_match`
//      distinction, for the FINAL fallback only (i.e. after the authorize
//      decision has already been made and is negative), now come from a
//      plain folded substring containment check with NO adjacency guard --
//      the same class of check used to guard the property test's random
//      generator. This changes no authorize decision (that guard remains
//      solely on the authorize path, per points 1-4 above); it only makes
//      the diagnostic reason more honest: an operator debugging "why did
//      it not answer me" sees that the configured text WAS present in the
//      segment even when it was embedded inside a longer word (a
//      hyphenated identifier, a longer human name, a possessive) -- the
//      same accuracy this module already gives for a clean mid-sentence
//      mention like "I asked Meetbot about it yesterday."
//
// Multilingual note: a "word boundary" only exists as whitespace in
// space-delimited languages, and Chinese has none at all. This module
// therefore uses two different mechanisms for "does the cue open the
// clause" depending on the alias's own script (Script=Han vs not), but
// ONE mechanism (clause truncation at the next real punctuation boundary)
// for bounding how much text is even eligible to be checked, applied
// identically to both. Coverage: the shipped defaults distinguish address
// from mention in English and Chinese; an operator deploying a third
// language passes additionalAddressCues/additionalLeadingFillers with that
// language's question words, request modals, and greeting fillers.

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
 * `additionalAddressCues` and `additionalLeadingFillers` EXTEND the
 * shipped defaults (see DEFAULT_ADDRESS_CUES / DEFAULT_LEADING_FILLERS
 * below) -- they never replace them. This is deployment configuration, the
 * same class of thing the aliases already are: a closed list of literal
 * words, not a pattern language, not a scoring model. */
export type InvocationGateIdentity = {
  readonly aliases: readonly string[];
  readonly additionalAddressCues?: readonly string[];
  readonly additionalLeadingFillers?: readonly string[];
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
       * addressed. This check has NO adjacency guard (see module doc,
       * point 5): it also populates for a hyphenated/possessive/longer-word
       * occurrence that never had a chance to authorize. Null only when no
       * configured alias's text appears anywhere in the segment at all, or
       * when the segment was not final and the text was never inspected. */
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
 *   3. An alias sits at a genuine vocative boundary: the whole segment, or
 *      the segment's start (optionally preceded by a single recognized
 *      leading filler word) or end (requiring, at the end specifically, an
 *      actual separator character immediately before it -- see module doc
 *      point 3), where the clause immediately adjoining the alias, bounded
 *      at the next real punctuation boundary, either is empty or OPENS
 *      with a recognized address cue -> positive, "vocative_invocation".
 *   4. An alias's text appears anywhere else in the segment -> negative,
 *      "incidental_mention" (covers third-person discussion, appositive/
 *      agenda mentions, "I asked X about it yesterday", and any
 *      hyphenated/possessive/longer-word occurrence that never had a
 *      chance to authorize).
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
    isVocativeBoundary(foldedText, folded, addressCues, leadingFillers),
  );
  if (vocativeAlias) {
    return {
      segmentId,
      authorize: true,
      matchedAlias: vocativeAlias.alias,
      reason: "vocative_invocation",
    };
  }

  // Diagnostic-only fallback: NO adjacency guard here (see module doc,
  // point 5). The authorize decision above is already final and negative;
  // this only decides which negative reason, and whether matchedAlias is
  // populated, so an operator sees when the configured text was present
  // even embedded inside a longer token.
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
 * configured aliases, cues, fillers, and transcript text so
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
 * ONLY on the negative/diagnostic path (see module doc, point 5) -- never
 * to decide whether to authorize. Deliberately the loosest possible check:
 * it finds "mei" inside "meiling" or "meetbot" inside "eng-meetbot", which
 * is exactly the point -- the alias's TEXT was present, even though it
 * never had a chance to be treated as a standalone word by the
 * authorize-side adjacency guard. */
function containsPlainSubstring(haystack: string, needle: string): boolean {
  if (needle === "") return false;
  return haystack.includes(needle);
}

// ---------------------------------------------------------------------------
// Default cue lexicons -- deployment configuration, extended (not replaced)
// by InvocationGateIdentity.additionalAddressCues / additionalLeadingFillers.
// Covers English and Chinese; an operator deploying a third language adds
// that language's question words / request modals / greeting fillers.
// ---------------------------------------------------------------------------

/** Words that mark the clause immediately adjoining the alias as an actual
 * address -- a question or a request -- rather than a third-person or
 * appositive mention. A cue only counts when it OPENS the (already
 * boundary-truncated) clause; see clauseOpensWithCue. Deliberately
 * excludes generic copulas ("is"/"are"): including them would turn
 * appositive mentions like "Meetbot, the note taker, is broken again."
 * into false positives even with clause truncation. */
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
  // Chinese: question particles/words, request markers, and "总结"
  // (summarize) -- included specifically so an unpunctuated imperative
  // ("会议机器人总结一下") is reachable via a clause-opening PREFIX match,
  // the same discipline English gets from checking its first two tokens.
  // "一下" is the conventional softener that turns a bare verb into a
  // polite request ("总结一下" reads as "summarize, would you" rather
  // than a bare statement).
  "请",
  "总结",
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

// Characters stripped from BOTH edges when testing "the alias is the whole
// segment": whitespace, sentence-final punctuation, quote/bracket
// characters (straight, curly, CJK corner/guillemet), and clause
// separators (comma/colon/semicolon, plus their CJK full-width/
// ideographic equivalents). Deliberately does NOT include hyphen/dash or
// apostrophe -- see WORD_CONTINUATION and the module doc's fixes.
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
// BOUND how much of the segment is even eligible for a cue lookup -- see
// module doc point 1. This is what stops "Meetbot, the note taker, did
// leave early." from ever considering "did" (in the clause beyond the
// first comma) at all.
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

// A REAL clause separator -- comma, colon, semicolon, or their CJK
// full-width/ideographic equivalents. Deliberately narrower than "any
// non-word-continuation character": plain whitespace does NOT count. Used
// to gate the TRAILING vocative position specifically -- see module doc
// point 3.
const REQUIRED_TRAILING_SEPARATOR = /[,:;、，：；]/u;

/** True if `clause` (already folded, already bounded to the adjoining
 * clause via truncateAtNext/PreviousClauseBoundary, already trimmed)
 * either has no content at all -- the alias plus an optional filler was
 * essentially the whole utterance -- or OPENS with one of `cues`.
 *
 * "Opens with" means: for a Latin/other-script alias, one of the clause's
 * first two whitespace-separated tokens exactly equals a cue word (not "a
 * cue word appears somewhere in the clause" -- that was round 2's Critical
 * 1 defect). For a Han-script alias, the clause's raw text starts with a
 * Han cue as a literal prefix, since Chinese has no whitespace to
 * tokenize on. */
function clauseOpensWithCue(clause: string, cues: readonly string[], aliasIsHan: boolean): boolean {
  if (clause === "") return true;

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
    // A wh-word contraction ("what's", "who's", "where's", "when's",
    // "why's", "how's" -- folded, so the apostrophe survives token
    // stripping since it's internal, not at either edge) is an extremely
    // common way to open a real question ("Meetbot, what'''s the plan?").
    // Found by adversarial probing after round 3's fix landed; a token
    // ending in an apostrophe-s that becomes a cue once the contraction is
    // removed still counts.
    const contracted = token.replace(/['’]s$/u, "");
    return contracted !== token && cues.includes(contracted);
  });
}

/**
 * True when `foldedAlias` sits at a genuine vocative boundary of
 * `foldedText`: either the alias IS the entire segment (after stripping
 * edge whitespace/punctuation), or it sits at the segment's start --
 * optionally preceded by a single recognized leading filler word -- or end
 * -- requiring, at the end specifically, a real separator character
 * immediately before it (module doc point 3) -- with the clause
 * immediately adjoining the alias, bounded at the next real clause
 * boundary, either empty or opening with a recognized address cue.
 *
 * For the START position, a Latin/other-script alias also requires that
 * the character immediately after it not continue the same token (see
 * WORD_CONTINUATION) -- this is what rejects "Meetbot-api" and "Mei's"
 * before the cue check even runs. That guard is skipped for a Han-script
 * alias at the START position (CJK has no whitespace, so "the next
 * character is a letter" is true for almost any real continuation and
 * would make an unpunctuated CJK vocative unreachable); disambiguation
 * there is carried entirely by the clause-opening-cue check instead. At
 * the END position, both scripts instead require an actual separator
 * character (see REQUIRED_TRAILING_SEPARATOR) -- which is automatically
 * also a stronger word-continuation guard than a bare adjacency check, so
 * no script-specific carve-out is needed there.
 */
function isVocativeBoundary(
  foldedText: string,
  foldedAlias: string,
  addressCues: readonly string[],
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
    const nextChar = remainder.charAt(0);
    if (!aliasIsHan && nextChar !== "" && isWordContinuation(nextChar)) continue;
    const stripped = remainder.replace(LEADING_CLAUSE_STRIP, "");
    const clause = truncateAtNextClauseBoundary(stripped).trim();
    if (clauseOpensWithCue(clause, addressCues, aliasIsHan)) return true;
  }

  // END: the segment's literal end (after stripping trailing terminal
  // punctuation/quotes), requiring an actual separator character (not
  // just whitespace) immediately before the alias -- see module doc
  // point 3 and REQUIRED_TRAILING_SEPARATOR.
  const textEnd = foldedText.replace(TRAILING_EDGE, "");
  if (textEnd.endsWith(foldedAlias)) {
    const prefixFull = textEnd.slice(0, textEnd.length - foldedAlias.length);
    // The character that must be a real separator is the last NON-
    // WHITESPACE character before the alias, not merely the last
    // character -- "that, Meetbot" has a space between the comma and the
    // alias, so checking only the literal last character would miss the
    // comma entirely and wrongly reject every comma-separated trailing
    // vocative that has the conventional space after its comma.
    const trimmedPrefix = prefixFull.replace(/\s+$/u, "");
    const beforeChar = trimmedPrefix.length > 0 ? trimmedPrefix.charAt(trimmedPrefix.length - 1) : "";
    if (beforeChar !== "" && REQUIRED_TRAILING_SEPARATOR.test(beforeChar)) {
      const stripped = prefixFull.replace(TRAILING_CLAUSE_STRIP, "");
      const clause = truncateAtPreviousClauseBoundary(stripped).trim();
      if (clauseOpensWithCue(clause, addressCues, aliasIsHan)) return true;
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
