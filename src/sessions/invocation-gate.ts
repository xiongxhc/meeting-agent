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
//   - Third-person discussion ("Meetbot usually handles the notes") is
//     negative for the same reason.
//   - An appositive/agenda-style mention ("Meetbot, the note taker, is
//     broken again.", "Agenda: Meetbot") is negative -- the alias sits at
//     a segment edge with a separator, but the adjoining clause never
//     actually addresses it.
//   - A quoted mention (somebody reading a sentence aloud that happens to
//     contain the name) is negative.
//   - A short alias must never fire merely because it is a textual prefix
//     or suffix of a longer, unrelated token -- a human name ("Mei" vs
//     "Meiling") or a compound identifier ("Meetbot-api", "eng-meetbot").
//   - A partial transcript NEVER authorizes, whatever it contains. This is
//     structural: finality is the first thing decide() checks, and nothing
//     below that check can produce a positive outcome for a partial
//     segment -- see decide() below.
//
// ROUND 2 (post-review) design: telling a genuine command/question
// ("Meetbot, what did we decide?", "Meetbot what did we decide") apart
// from a third-person or appositive mention that merely happens to sit at
// a segment edge with a separator ("Meetbot, the note taker, is broken
// again.") cannot be done from punctuation and position alone -- both
// shapes are "alias at a segment edge, comma nearby, more clause
// attached." The disambiguator is a small, closed, deployment-configured
// ADDRESS CUE lexicon (question words, request modals, "please") checked
// in the clause immediately adjoining the alias -- the same class of
// configuration the aliases themselves already are, not NLP, not fuzzy
// matching, not a scoring model. A short LEADING FILLER lexicon ("hey",
// "so", "OK", "um", ...) similarly lets a filler word precede a leading
// vocative ("Hey Meetbot, ...") without defeating the start-boundary
// check. Both lexicons ship English and Chinese defaults and can be
// extended (not replaced) by the caller's identity -- see
// InvocationGateIdentity.
//
// Multilingual note, revised: a "word boundary" only exists as whitespace
// in space-delimited languages, and Chinese has none at all -- there is no
// character that reliably separates "the alias" from "the next word" the
// way a Latin space does. Requiring an explicit non-letter character
// immediately next to a CJK alias (as round 1 did) makes an unpunctuated
// Chinese vocative ("会议机器人总结一下") permanently unreachable, because
// in continuous CJK text the character after the alias is essentially
// always another CJK letter. This module therefore treats a
// Script=Han-only alias differently at exactly one point: the
// "must-not-embed-in-a-longer-token" adjacency guard (see WORD_CONTINUATION
// below) is skipped for it, and disambiguation is carried entirely by the
// address-cue lexicon instead. For a Latin/other-script alias the
// adjacency guard still applies, which is what keeps "Mei-Ling" or
// "Meetbot-api" from ever being treated as an edge match at all. Coverage:
// the shipped defaults distinguish address from mention in English and
// Chinese; an operator deploying a third language passes
// additionalAddressCues/additionalLeadingFillers with that language's
// question words, request modals, and greeting fillers.

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
      /** Populated whenever a configured alias was textually found in the
       * segment -- including negative outcomes like "incidental_mention"
       * and "quoted_mention" -- because an operator debugging "why did it
       * not answer me" needs to see that the name WAS heard, just not
       * addressed. Null when no configured alias appears in the text at
       * all, or when the segment was not final and the text was never
       * inspected. */
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
 *      alias appears inside -- someone reading text aloud -- -> negative,
 *      "quoted_mention".
 *   3. An alias sits at a genuine vocative boundary: the whole segment, or
 *      the segment's start/end (optionally preceded, at the start, by a
 *      single recognized leading filler word) where the adjoining clause
 *      either is empty or carries a recognized address cue -> positive,
 *      "vocative_invocation".
 *   4. An alias appears anywhere else as a real word -> negative,
 *      "incidental_mention" (covers third-person discussion, appositive/
 *      agenda mentions, and "I asked X about it yesterday").
 *   5. No alias anywhere -> negative, "no_alias_match".
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
    const quotedAlias = aliases.find(({ folded }) => containsWord(foldedInner, folded));
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

  const incidentalAlias = aliases.find(({ folded }) => containsWord(foldedText, folded));
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
 * per alias, whether the strict Latin word-continuation adjacency guard
 * applies (see module doc's multilingual note). */
function isHanText(folded: string): boolean {
  return HAN_CHAR.test(folded);
}

// Letters, digits, hyphen, and underscore all COUNT AS the same token: a
// character immediately touching a candidate match that is one of these
// means the match is embedded in a longer identifier, not a standalone
// occurrence of the alias. Including hyphen/underscore here is what keeps
// "Mei" out of "Mei-Ling", "Meetbot" out of "Meetbot-api", and "meetbot"
// out of "eng-meetbot" -- the exact false-positive class round 1 missed by
// treating a bare hyphen as a valid clause separator.
const WORD_CONTINUATION = /[\p{L}\p{N}\-_]/u;

function isWordContinuation(ch: string | undefined): boolean {
  return ch !== undefined && ch !== "" && WORD_CONTINUATION.test(ch);
}

/** True if `needle` occurs anywhere in `haystack` as a real word -- neither
 * character immediately adjacent to the match continues the same token
 * (see WORD_CONTINUATION). This is what keeps a short alias like "Mei"
 * from firing inside a longer word like "Meiling", and now also keeps a
 * hyphenated compound like "Meetbot-api" or "eng-meetbot" from registering
 * as a mention of the bare alias at all. Both arguments must already be
 * folded. */
function containsWord(haystack: string, needle: string): boolean {
  if (needle === "") return false;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return false;
    const before = idx > 0 ? haystack[idx - 1] : undefined;
    const afterIdx = idx + needle.length;
    const after = afterIdx < haystack.length ? haystack[afterIdx] : undefined;
    if (!isWordContinuation(before) && !isWordContinuation(after)) {
      return true;
    }
    from = idx + 1;
  }
}

// ---------------------------------------------------------------------------
// Default cue lexicons -- deployment configuration, extended (not replaced)
// by InvocationGateIdentity.additionalAddressCues / additionalLeadingFillers.
// Covers English and Chinese; an operator deploying a third language adds
// that language's question words / request modals / greeting fillers.
// ---------------------------------------------------------------------------

/** Words that mark the clause adjoining the alias as an actual address --
 * a question or a request -- rather than a third-person or appositive
 * mention. Deliberately excludes generic copulas ("is"/"are"): including
 * them would turn appositive mentions like "Meetbot, the note taker, is
 * broken again." into false positives. */
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
  // Chinese: question particles/words and request markers. "一下" is the
  // conventional softener that turns a bare verb into a polite request
  // ("总结一下" = "summarize, would you" rather than a bare statement),
  // which is what makes the unpunctuated CJK positive fixture resolvable
  // without a dedicated NLP parser.
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

// Characters stripped from BOTH edges when testing "the alias is the whole
// segment": whitespace, sentence-final punctuation, quote/bracket
// characters (straight, curly, CJK corner/guillemet), and clause
// separators (comma/colon/semicolon, plus their CJK full-width/
// ideographic equivalents). Deliberately does NOT include hyphen/dash --
// see WORD_CONTINUATION and the module doc's critical-fix note.
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

/** True if `clause` (already folded) either has no content at all -- the
 * alias plus an optional filler was essentially the whole utterance -- or
 * contains one of `cues` as a genuine address cue. Chinese cues are
 * matched as plain substrings (Chinese has no whitespace to make a
 * word-boundary check meaningful for a one- or two-character function
 * word); Latin-script cues are matched word-boundary-aware via
 * containsWord, so a cue like "do" cannot fire inside an unrelated longer
 * word. */
function clauseAddressesTheAgent(clause: string, cues: readonly string[]): boolean {
  if (clause === "") return true;
  return cues.some((cue) => {
    if (cue === "") return false;
    if (isHanText(cue)) return clause.includes(cue);
    return containsWord(clause, cue);
  });
}

/**
 * True when `foldedAlias` sits at a genuine vocative boundary of
 * `foldedText`: either the alias IS the entire segment (after stripping
 * edge whitespace/punctuation), or it sits at the segment's start/end --
 * optionally, at the start, preceded by a single recognized leading filler
 * word -- with the adjoining clause either empty or carrying a recognized
 * address cue.
 *
 * For a Latin/other-script alias, the character immediately touching the
 * alias at that edge must not continue the same token (see
 * WORD_CONTINUATION) -- this is what rejects "Meetbot-api" and
 * "eng-meetbot" before the cue check even runs. For a Han-script alias
 * that guard is skipped (see the module doc's multilingual note): CJK has
 * no whitespace, so "the next character is a letter" is true for almost
 * any real continuation and would make an unpunctuated CJK vocative
 * unreachable. Disambiguation for Han aliases is carried entirely by the
 * address-cue lexicon.
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
    const clause = remainder.replace(LEADING_CLAUSE_STRIP, "").trim();
    if (clauseAddressesTheAgent(clause, addressCues)) return true;
  }

  // END: the segment's literal end (after stripping trailing terminal
  // punctuation/quotes).
  const textEnd = foldedText.replace(TRAILING_EDGE, "");
  if (textEnd.endsWith(foldedAlias)) {
    const prefix = textEnd.slice(0, textEnd.length - foldedAlias.length);
    const beforeChar = prefix.length > 0 ? prefix.charAt(prefix.length - 1) : "";
    if (aliasIsHan || beforeChar === "" || !isWordContinuation(beforeChar)) {
      const clause = prefix.replace(TRAILING_CLAUSE_STRIP, "").trim();
      if (clauseAddressesTheAgent(clause, addressCues)) return true;
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
