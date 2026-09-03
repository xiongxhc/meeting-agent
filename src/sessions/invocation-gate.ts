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
//   - A quoted mention (somebody reading a sentence aloud that happens to
//     contain the name) is negative.
//   - A partial transcript NEVER authorizes, whatever it contains. This is
//     structural: finality is the first thing decide() checks, and nothing
//     below that check can produce a positive outcome for a partial
//     segment -- see decide() below.
//
// Multilingual note: a "word boundary" only exists as whitespace in
// space-delimited languages. Chinese (and similar scripts) have none, so a
// regex written for English silently fails to find any boundary at all.
// This module does not special-case CJK: the SAME rule (vocative shape =
// the whole segment, or the alias set off from the rest of the clause by a
// comma/colon/semicolon/dash at a segment edge) is applied uniformly by
// operating on Unicode letter/number adjacency rather than on whitespace.
// The practical effect is that English tolerates a bare space between the
// alias and a following clause-separator token, while CJK -- having no
// whitespace at all -- effectively requires real punctuation (or the alias
// being the entire segment) to form a boundary. That is a deliberately
// conservative, uniform consequence of one mechanism, not two different
// rules; see the report for the specific "Meetbot usually handles the
// notes"-shaped edge case this cannot resolve without semantics, and why
// that gap is closed by conservative fixture/rule design rather than NLP.

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
 * this module to config.ts. */
export type InvocationGateIdentity = {
  readonly aliases: readonly string[];
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
 * null for a caller (or the sink below) to have to guard against. */
export type InvocationDecision =
  | {
      readonly authorize: true;
      readonly matchedAlias: string;
      readonly reason: "vocative_invocation";
    }
  | {
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
 *   3. An alias sits at a genuine vocative boundary (the whole segment, or
 *      set off from the rest of the clause by a comma/colon/semicolon/dash
 *      at the segment's start or end) -> positive, "vocative_invocation".
 *   4. An alias appears anywhere else as a real word -> negative,
 *      "incidental_mention" (covers third-person discussion and "I asked
 *      X about it yesterday").
 *   5. No alias anywhere -> negative, "no_alias_match".
 */
export function decide(
  segment: InvocationCandidateSegment,
  identity: InvocationGateIdentity,
): InvocationDecision {
  if (!segment.final) {
    return { authorize: false, matchedAlias: null, reason: "non_final_segment" };
  }

  const trimmed = segment.text.trim();
  const aliases = identity.aliases
    .map((alias) => ({ alias, folded: fold(alias) }))
    .filter(({ folded }) => folded !== "");

  if (trimmed === "" || aliases.length === 0) {
    return { authorize: false, matchedAlias: null, reason: "no_alias_match" };
  }

  const quotedInner = stripMatchingQuotes(trimmed);
  if (quotedInner !== null) {
    const foldedInner = fold(quotedInner);
    const quotedAlias = aliases.find(({ folded }) => containsWord(foldedInner, folded));
    if (quotedAlias) {
      return { authorize: false, matchedAlias: quotedAlias.alias, reason: "quoted_mention" };
    }
  }

  const foldedText = fold(trimmed);

  const vocativeAlias = aliases.find(({ folded }) => isVocativeBoundary(foldedText, folded));
  if (vocativeAlias) {
    return { authorize: true, matchedAlias: vocativeAlias.alias, reason: "vocative_invocation" };
  }

  const incidentalAlias = aliases.find(({ folded }) => containsWord(foldedText, folded));
  if (incidentalAlias) {
    return { authorize: false, matchedAlias: incidentalAlias.alias, reason: "incidental_mention" };
  }

  return { authorize: false, matchedAlias: null, reason: "no_alias_match" };
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
  /** Applies `decision` for `segmentId` to the sink -- exactly once. A
   * second call for a segmentId already applied (the runtime redelivering
   * the same finalized segment, a retry, an at-least-once duplicate) is a
   * silent no-op: it neither re-skips nor re-authorizes. */
  apply(segmentId: string, decision: InvocationDecision): void;
};

/** Creates a dispatcher that applies decisions to `sink`, tracking which
 * segmentIds have already been applied so a repeated segment (see the
 * module doc) can never authorize -- or skip -- twice. */
export function createInvocationDispatcher(sink: InvocationSink): InvocationDispatcher {
  const applied = new Set<string>();

  return {
    apply(segmentId: string, decision: InvocationDecision): void {
      if (applied.has(segmentId)) return;
      applied.add(segmentId);

      if (decision.authorize) {
        sink.authorizeVoiceResponse(segmentId, decision.matchedAlias);
      } else {
        sink.skipVoiceResponse(segmentId, decision.reason);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Text matching internals
// ---------------------------------------------------------------------------

const DIACRITIC = /\p{M}/gu;

/** Case- and accent-insensitive normalization, applied identically to
 * configured aliases and transcript text so "José"/"jose"/"JOSÉ" all
 * compare equal. */
function fold(s: string): string {
  return s.normalize("NFD").replace(DIACRITIC, "").toLowerCase();
}

const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

function isLetterOrNumber(ch: string | undefined): boolean {
  return ch !== undefined && LETTER_OR_NUMBER.test(ch);
}

/** True if `needle` occurs anywhere in `haystack` as a real word -- neither
 * character immediately adjacent to the match is itself a letter or digit.
 * This is what keeps a short alias like "Mei" from firing inside a longer
 * word like "Meiling": the character right after the match ("l") is a
 * letter, so it is not a word occurrence at all, not even an incidental
 * one. Both arguments must already be folded. */
function containsWord(haystack: string, needle: string): boolean {
  if (needle === "") return false;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return false;
    const before = idx > 0 ? haystack[idx - 1] : undefined;
    const afterIdx = idx + needle.length;
    const after = afterIdx < haystack.length ? haystack[afterIdx] : undefined;
    if (!isLetterOrNumber(before) && !isLetterOrNumber(after)) {
      return true;
    }
    from = idx + 1;
  }
}

// Characters stripped from BOTH edges when testing "the alias is the whole
// segment": whitespace, sentence-final punctuation, quote/bracket
// characters (straight, curly, CJK corner/guillemet), and clause
// separators (comma/colon/semicolon/dash, plus their CJK full-width/
// ideographic equivalents).
const EDGE_STRIP =
  /^[\s.,!?…:;'"“”‘’「」『』«»()[\]、，。！？：；—–-]+|[\s.,!?…:;'"“”‘’«»「」『』()[\]、，。！？：；—–-]+$/gu;

// Only the trailing run, used before an end-position check so a trailing
// "?"/"!"/closing quote after the alias doesn't block the match while
// still leaving a real preceding separator (a comma) intact for inspection.
const TRAILING_EDGE = /[\s.,!?…:;'"“”‘’«»「」『』()[\]、，。！？：；—–-]+$/u;

// The set of characters that count as "this alias is set off from the rest
// of the clause" when directly adjacent (module leading/trailing
// whitespace) to the alias at a segment boundary.
const SEPARATOR_START = /^[,:;\-–—、，：；]/u;
const SEPARATOR_END = /[,:;\-–—、，：；]$/u;

/**
 * True when `foldedAlias` sits at a genuine vocative boundary of
 * `foldedText`: either the alias IS the entire segment (after stripping
 * edge whitespace/punctuation), or it sits at the start/end of the segment
 * separated from the rest of the clause by a comma/colon/semicolon/dash.
 *
 * Deliberately does NOT treat "alias at the start, followed only by
 * whitespace and more words, no separator" as a boundary match: that shape
 * is indistinguishable, by pure text structure alone, from a third-person
 * statement ("Meetbot usually handles the notes") that must stay negative.
 * Telling the two apart would require understanding the following clause
 * (is it a command? a description?) -- which is exactly the NLP/scoring
 * this task is explicitly scoped to avoid. Requiring an explicit separator
 * (or the alias standing alone) is the conservative reading that keeps the
 * product's hard requirement -- zero false positives -- intact at the cost
 * of occasionally requiring a pause/comma for a chained address like
 * "Meetbot mute yourself" without one.
 */
function isVocativeBoundary(foldedText: string, foldedAlias: string): boolean {
  if (foldedAlias === "") return false;

  const core = foldedText.replace(EDGE_STRIP, "");
  if (core === foldedAlias) return true;

  if (foldedText.startsWith(foldedAlias)) {
    const remainder = foldedText.slice(foldedAlias.length).replace(/^\s+/u, "");
    if (remainder !== "" && SEPARATOR_START.test(remainder)) return true;
  }

  const textEnd = foldedText.replace(TRAILING_EDGE, "");
  if (textEnd.endsWith(foldedAlias)) {
    const prefix = textEnd.slice(0, textEnd.length - foldedAlias.length).replace(/\s+$/u, "");
    if (prefix !== "" && SEPARATOR_END.test(prefix)) return true;
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
