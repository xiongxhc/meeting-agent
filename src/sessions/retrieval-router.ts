// The retrieval router: what the agent knows when it answers.
//
// THE ORDERING IS THE WHOLE POINT: current-meeting memory is searched
// first, and the Team Vault index is queried ONLY when the current meeting
// did not meet SUFFICIENCY_THRESHOLD. This is a spec requirement (Meeting
// Agent must answer from the current meeting before it reaches for durable
// team knowledge), not an optimization, and test/retrieval-router.test.ts
// asserts on the vault fake's own call log being empty for a sufficient
// current-meeting answer -- not merely that the answer came back right.
//
// THE CURRENT-MEETING STORE LIVES HERE, not as its own module and not on
// src/sessions/meeting-session.ts. It is retrieval state, not session
// lifecycle state -- meeting-session.ts already owns four unrelated things
// (join sequence, event queue, turn machine, finalization) and does not
// need a fifth, and task-6-brief.md's file list gives this task exactly
// three files to create. createCurrentMeetingMemory is exported anyway so
// a caller (e.g. a future wiring module) can hold one instance per meeting
// session across repeated `prepare`/`answer` calls, and a test can inspect
// it directly.
//
// PARTIAL TRANSCRIPTS CAN PREPARE, NEVER AUTHORIZE. `prepare()` takes any
// segment, partial or final, and has no sink parameter at all -- there is
// no expression in its body that could reach RuntimeContextSink, so it is
// structurally incapable of authorizing speech. `answer()` is the only
// function that can, and it takes an AuthorizedInvocation whose `authorize`
// field is the literal `true` (src/ports/knowledge.ts) -- the type system
// itself refuses a negative decision as an argument, so this module cannot
// become a second path to speech alongside src/sessions/invocation-gate.ts.

import {
  termCoverageScore,
  type AuthorizedInvocation,
  type KnowledgeHit,
  type RuntimeContextSink,
  type SeededContext,
  type TeamVaultIndexPort,
} from "../ports/knowledge.ts";

/** The current meeting is treated as sufficient when its best-scoring hit
 * covers at least half of the query's distinct terms. Chosen, not derived:
 * half is the point past which a single excerpt is answering the question
 * rather than merely mentioning one of its words, and it is the same
 * termCoverageScore used everywhere else, so a reader can compute it by
 * hand from the query and the excerpt. */
export const SUFFICIENCY_THRESHOLD = 0.5;

/** Per-hit excerpt bound, in characters. ~400 characters is two to three
 * sentences -- enough for a excerpt to carry a real answer, short enough
 * that a handful of them still fit a live spoken turn's context budget
 * (see MAX_SEEDED_CONTEXT_CHARS). An excerpt longer than this is cut and
 * the cut is marked in the excerpt text itself (see truncateExcerpt) --
 * never silent. */
export const EXCERPT_MAX_CHARS = 400;

/** Total bound, in characters, on the seeded context's combined excerpt
 * text. 1600 is four excerpts at the per-hit bound: enough room for a
 * mixed current-meeting-plus-vault answer without turning a live voice
 * response's context into an unbounded transcript dump. Hits that would
 * push the total over this bound are left out of `hits`/`text` and counted
 * in `omittedHitCount` instead of silently included. */
export const MAX_SEEDED_CONTEXT_CHARS = 1600;

/** Hard cap on the number of hits seeded, independent of the character
 * bound -- keeps the seeded context predictable in shape (never "one huge
 * hit plus nine tiny ones") and gives MAX_SEEDED_CONTEXT_CHARS a small,
 * fixed number of excerpts to divide between. */
export const MAX_HITS = 5;

const TRUNCATION_MARKER = " […truncated]";

// ---------------------------------------------------------------------------
// Current-meeting memory
// ---------------------------------------------------------------------------

export type CurrentMeetingSegment = {
  readonly segmentId: string;
  readonly text: string;
  readonly final: boolean;
};

export type CurrentMeetingMemory = {
  /** Records a segment's text into the current meeting's searchable
   * memory. A non-final (partial) segment is accepted but never indexed:
   * partial text can still change, and indexing it would let a later
   * answer cite words the speaker had not actually finished saying. */
  record(segment: CurrentMeetingSegment): void;
  search(query: string): readonly KnowledgeHit[];
};

export function createCurrentMeetingMemory(): CurrentMeetingMemory {
  const entries: Array<{ readonly segmentId: string; readonly text: string }> = [];

  return {
    record(segment: CurrentMeetingSegment): void {
      if (!segment.final) return;
      const trimmed = segment.text.trim();
      if (trimmed === "") return;
      entries.push({ segmentId: segment.segmentId, text: trimmed });
    },
    search(query: string): readonly KnowledgeHit[] {
      const hits: KnowledgeHit[] = [];
      for (const entry of entries) {
        const score = termCoverageScore(query, entry.text);
        if (score <= 0) continue;
        hits.push({
          source: "current_meeting",
          sourcePath: null,
          excerpt: entry.text,
          score,
          indexedRevision: null,
        });
      }
      hits.sort((a, b) => b.score - a.score);
      return hits;
    },
  };
}

// ---------------------------------------------------------------------------
// Retrieval router
// ---------------------------------------------------------------------------

export type CreateRetrievalRouterOptions = {
  /** An index, or one still being built (awaited only when a question
   * actually needs the vault; current-meeting answers never wait for it). */
  readonly vault: TeamVaultIndexPort | Promise<TeamVaultIndexPort>;
  readonly sink: RuntimeContextSink;
  /** Defaults to a fresh createCurrentMeetingMemory(). Injectable so a
   * caller (or a test) can hold and inspect the same memory instance
   * across repeated prepare()/answer() calls. */
  readonly memory?: CurrentMeetingMemory;
};

export type RetrievalRouter = {
  /** May be called for any segment, partial or final. See the module
   * header: this function has no path to authorizing speech. */
  prepare(segment: CurrentMeetingSegment): void;
  /** Retrieves, bounds, seeds the runtime's context, and THEN authorizes
   * the segment. Only callable with a decision the gate itself produced
   * (see AuthorizedInvocation). */
  answer(
    invocation: AuthorizedInvocation,
    queryText: string,
    options?: {
      readonly mayAuthorize?: () => boolean;
      /** Aborted when the session ends: a question still waiting for an
       * index that is being built stops waiting and is cancelled, so session
       * shutdown (and its recording finalization) never waits on git. */
      readonly signal?: AbortSignal;
    },
  ): Promise<SeededContext>;
};

/** The session invalidated this turn after retrieval began. This is not a
 * retrieval failure: it is the expected fail-closed result of a provider
 * outage, overflow, terminal left, or disposal racing context preparation. */
export class RetrievalAuthorizationCancelled extends Error {
  constructor() {
    super("retrieval authorization was cancelled before runtime authorization");
    this.name = "RetrievalAuthorizationCancelled";
  }
}

/** The pending index, or RetrievalAuthorizationCancelled as soon as `signal`
 * aborts; the listener is removed either way. */
function untilAbandoned<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return pending;
  if (signal.aborted) return Promise.reject(new RetrievalAuthorizationCancelled());
  return new Promise<T>((resolve, reject) => {
    const abandon = () => reject(new RetrievalAuthorizationCancelled());
    signal.addEventListener("abort", abandon, { once: true });
    pending.then(
      (value) => { signal.removeEventListener("abort", abandon); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", abandon); reject(error); },
    );
  });
}

export function createRetrievalRouter(options: CreateRetrievalRouterOptions): RetrievalRouter {
  const memory = options.memory ?? createCurrentMeetingMemory();
  const { vault, sink } = options;

  return {
    prepare(segment: CurrentMeetingSegment): void {
      memory.record(segment);
    },

    async answer(
      invocation: AuthorizedInvocation,
      queryText: string,
      answerOptions: { readonly mayAuthorize?: () => boolean; readonly signal?: AbortSignal } = {},
    ): Promise<SeededContext> {
      const meetingHits = memory.search(queryText);
      const bestMeetingScore = meetingHits[0]?.score ?? 0;

      let vaultQueried = false;
      let vaultUnavailable = false;
      let vaultStale = false;
      let combined: readonly KnowledgeHit[] = meetingHits;

      if (bestMeetingScore < SUFFICIENCY_THRESHOLD) {
        vaultQueried = true;
        try {
          const index = vault instanceof Promise ? await untilAbandoned(vault, answerOptions.signal) : vault;
          const result = index.search(queryText);
          vaultStale = result.stale;
          combined = [...meetingHits, ...result.hits].sort((a, b) => b.score - a.score);
        } catch (error) {
          if (error instanceof RetrievalAuthorizationCancelled) throw error;
          vaultUnavailable = true;
          // combined stays meetingHits only -- whatever the current meeting
          // already had is still used.
        }
      }

      const { boundedHits, truncatedHitCount, omittedHitCount } = boundHits(combined);

      const text = renderContextText({
        hits: boundedHits,
        vaultUnavailable,
        vaultStale,
        omittedHitCount,
      });

      const context: SeededContext = {
        segmentId: invocation.segmentId,
        hits: boundedHits,
        vaultQueried,
        vaultUnavailable,
        vaultStale,
        truncatedHitCount,
        omittedHitCount,
        text,
      };

      const contextExchanges = [{ user: queryText, assistant: context.text }];
      // Active timed voice takes context on the scoped authorization itself.
      // Only legacy untimed sinks expose completed-history seeding.
      await sink.seedConversationContext?.(contextExchanges, `meeting-agent:${invocation.segmentId}`);
      if (answerOptions.mayAuthorize !== undefined && !answerOptions.mayAuthorize()) {
        throw new RetrievalAuthorizationCancelled();
      }
      await sink.authorizeVoiceResponse({
        sessionId: sink.sessionId,
        segmentId: invocation.segmentId,
        contextExchanges,
      });

      return context;
    },
  };
}

// ---------------------------------------------------------------------------
// Bounding -- always observable, never a silent truncation or omission
// ---------------------------------------------------------------------------

function boundHits(hits: readonly KnowledgeHit[]): {
  readonly boundedHits: readonly KnowledgeHit[];
  readonly truncatedHitCount: number;
  readonly omittedHitCount: number;
} {
  const boundedHits: KnowledgeHit[] = [];
  let truncatedHitCount = 0;
  let usedChars = 0;

  for (const hit of hits) {
    if (boundedHits.length >= MAX_HITS) break;
    const { excerpt, truncated } = truncateExcerpt(hit.excerpt);
    // The first hit is always admitted even if it alone would exceed the
    // budget -- EXCERPT_MAX_CHARS is already well under
    // MAX_SEEDED_CONTEXT_CHARS, so this only guards against a future bound
    // change making the two inconsistent, not against a real case today.
    //
    // BREAK, NOT CONTINUE: hits arrive here sorted best-score-first, and the
    // moment one hit would push the running total over budget, the loop
    // stops outright rather than skipping that hit and trying the next
    // (lower-scoring, possibly smaller) one. The policy this produces is
    // "the context is the best-scoring hits that fit contiguously from the
    // top," not "pack in as many hits as the budget allows" -- a smaller
    // but lower-scoring hit further down the list is never substituted in
    // to fill the remaining budget, even when it would fit. This is a
    // deliberate, predictable choice (a reader can tell which hits are
    // seeded from the score order alone, without also having to reason
    // about excerpt sizes), not an oversight; the trade-off is that a
    // border-line-sized top hit can leave budget unused that a later,
    // smaller hit would have filled.
    if (boundedHits.length > 0 && usedChars + excerpt.length > MAX_SEEDED_CONTEXT_CHARS) break;
    boundedHits.push({ ...hit, excerpt });
    if (truncated) truncatedHitCount += 1;
    usedChars += excerpt.length;
  }

  return { boundedHits, truncatedHitCount, omittedHitCount: hits.length - boundedHits.length };
}

function truncateExcerpt(excerpt: string): { readonly excerpt: string; readonly truncated: boolean } {
  if (excerpt.length <= EXCERPT_MAX_CHARS) return { excerpt, truncated: false };
  const cut = excerpt.slice(0, EXCERPT_MAX_CHARS - TRUNCATION_MARKER.length).trimEnd();
  return { excerpt: `${cut}${TRUNCATION_MARKER}`, truncated: true };
}

function renderContextText(input: {
  readonly hits: readonly KnowledgeHit[];
  readonly vaultUnavailable: boolean;
  readonly vaultStale: boolean;
  readonly omittedHitCount: number;
}): string {
  const lines: string[] = [];

  if (input.hits.length === 0) {
    lines.push("No relevant information was found in the current meeting or the Team Vault.");
  } else {
    for (const hit of input.hits) {
      const provenance =
        hit.source === "current_meeting"
          ? "current meeting"
          : `Team Vault: ${hit.sourcePath ?? "unknown file"}`;
      lines.push(`[${provenance}] ${hit.excerpt}`);
    }
  }

  if (input.vaultUnavailable) {
    lines.push(
      "Historical team memory (Team Vault) is currently unavailable; answer using only " +
        "the current meeting's context, and say so if asked about anything from before " +
        "this meeting.",
    );
  }

  if (input.vaultStale) {
    lines.push(
      "The Team Vault knowledge above may be outdated: the index was built from an " +
        "earlier revision of the vault checkout, which has since advanced.",
    );
  }

  if (input.omittedHitCount > 0) {
    lines.push(
      `(${input.omittedHitCount} additional lower-relevance result` +
        `${input.omittedHitCount === 1 ? "" : "s"} omitted for length.)`,
    );
  }

  return lines.join("\n");
}
