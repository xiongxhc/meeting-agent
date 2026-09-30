// The knowledge retrieval port: what the retrieval router needs from a
// read-only Team Vault index, and what it hands to the Conversation Runtime
// to seed a spoken response with -- current-meeting memory first, Team
// Vault second, and only when the current meeting was insufficient. See
// src/sessions/retrieval-router.ts for the ordering itself; this file only
// declares the shapes.
//
// RuntimeContextSink is a narrow, EXPLICITLY-DERIVED slice of
// ConversationRuntimePort (src/ports/conversation-runtime.ts) --
// `Pick<ConversationRuntimePort, "authorizeVoiceResponse">`, with optional
// completed-history seeding for legacy untimed callers,
// not a separately-declared type that merely happens to line up. The two
// files import each other's types (this file's SeededContext; that file's
// ConversationRuntimePort) -- both are type-only imports, erased at compile
// time by verbatimModuleSyntax, so there is no runtime import cycle, only a
// type-level one TypeScript resolves lazily. Deriving via Pick means a
// value typed ConversationRuntimePort (the real port, or
// test/lib/session-fakes.ts's fake) satisfies RuntimeContextSink directly,
// with no adapter needed -- and any future rename/retyping of either method
// on ConversationRuntimePort is a compile error here too, instead of a
// silent drift between two independently-declared shapes.

import type { ConversationRuntimePort } from "./conversation-runtime.ts";

/** One retrieved piece of knowledge, with full provenance. Verbatim from the
 * task brief. `sourcePath` is the file path within the Team Vault checkout
 * for a `team_vault` hit (relative to the checkout root), or null for
 * `current_meeting` -- there is no file, the source is this meeting's own
 * transcript. `indexedRevision` is the git revision the Team Vault checkout
 * was AT when this file was read into the index; always null for
 * `current_meeting`, since there is no vault revision behind it. */
export type KnowledgeHit = {
  source: "current_meeting" | "team_vault";
  sourcePath: string | null;
  excerpt: string;
  score: number;
  indexedRevision: string | null;
};

/** A transparent, predictable scoring function: the fraction of the query's
 * distinct terms that appear in the candidate text. A reader can predict
 * which of two hits ranks higher by eye -- the one covering more of the
 * query's distinct words wins -- with no vocabulary, weighting, or model
 * behind it. Exported so the current-meeting store and the Team Vault index
 * (src/adapters/team-vault-index.ts) score identically; a hit's rank never
 * depends on which store produced it. */
export function termCoverageScore(query: string, text: string): number {
  const queryTerms = new Set(tokenize(query));
  if (queryTerms.size === 0) return 0;
  const textTerms = new Set(tokenize(text));
  let matched = 0;
  for (const term of queryTerms) {
    if (textTerms.has(term)) matched += 1;
  }
  return matched / queryTerms.size;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/** One search's worth of results from the Team Vault index, plus the
 * index's own freshness accounting. `stale` is true when the checkout's git
 * HEAD has moved since the index was built -- the index never re-reads
 * files on its own (no watch mode), so this is the reader's only signal
 * that the vault may hold newer published notes than what was searched.
 * `indexedRevision` here is the same value every hit carries: the revision
 * the CONTENT was actually read at, which does not change just because the
 * checkout has since moved on. */
export type TeamVaultSearchResult = {
  readonly hits: readonly KnowledgeHit[];
  readonly indexedRevision: string | null;
  readonly stale: boolean;
};

/** A read-only search surface over a Team Vault checkout, indexed once from
 * published Markdown only. May throw -- checkout missing, unreadable, or
 * not a readable git working tree -- and the retrieval router treats any
 * throw from `search` as "vault unavailable" (see
 * src/sessions/retrieval-router.ts). */
export type TeamVaultIndexPort = {
  search(query: string): TeamVaultSearchResult;
};

/** The invocation gate's positive decision, structurally -- not imported
 * from src/sessions/invocation-gate.ts, the same "structural compatibility,
 * no coupling" choice that module documents for its own
 * InvocationCandidateSegment. `authorize: true` is a literal, not a
 * boolean, so the only value that satisfies this type is one where
 * authorization already happened; there is no way to construct one from a
 * negative decision. This is what stops the router from becoming a second
 * path to speech: nothing in retrieval-router.ts can call `answer` without
 * already holding a value the gate itself produced. */
export type AuthorizedInvocation = {
  readonly segmentId: string;
  readonly authorize: true;
  readonly matchedAlias: string;
};

/** The bounded, provenance-carrying context the router hands the runtime
 * before authorizing a segment -- and everything a test or an operator
 * needs to see WHY it looks the way it does. Every bound and every
 * omission this type can express is a field, not a log line: `text` is
 * exactly what the runtime is told, `hits` is exactly what it was built
 * from. */
export type SeededContext = {
  readonly segmentId: string;
  readonly hits: readonly KnowledgeHit[];
  /** Whether the Team Vault index was queried at all. False whenever the
   * current meeting alone met the sufficiency threshold -- a test can
   * assert this directly instead of only inspecting the vault fake's call
   * log. */
  readonly vaultQueried: boolean;
  /** True once the vault was queried and it threw. Distinct from
   * `vaultQueried: false` (never asked) -- "we didn't need it" and "we
   * needed it and it was down" need different operator responses. */
  readonly vaultUnavailable: boolean;
  /** True when the vault was queried, it answered, and it reported its own
   * index as stale (the checkout's git HEAD has moved since the index was
   * built). The hits themselves still carry the original indexedRevision. */
  readonly vaultStale: boolean;
  /** How many included hits had their excerpt shortened to fit
   * EXCERPT_MAX_CHARS. */
  readonly truncatedHitCount: number;
  /** How many hits were found but left out of `hits`/`text` to stay inside
   * MAX_SEEDED_CONTEXT_CHARS / MAX_HITS. */
  readonly omittedHitCount: number;
  /** The literal text seeded to the runtime. Carries an explicit sentence
   * that historical team memory is unavailable when `vaultUnavailable` is
   * true, and an explicit sentence when no hit was found anywhere -- never
   * left for the runtime to infer from silence. */
  readonly text: string;
};

/** The narrow sink the router calls: bound context, THEN authorize. See the
 * module header -- this is Pick<ConversationRuntimePort, ...>, not an
 * independently-declared shape. */
export type RuntimeContextSink = Pick<
  ConversationRuntimePort,
  "authorizeVoiceResponse"
> & Partial<Pick<ConversationRuntimePort, "seedConversationContext">> & {
  // Legacy untimed callers may seed completed history before authorization.
  // An active SDK voice session must receive context through its authorization
  // command instead: global history mutation is explicitly forbidden there.
  /** The live SDK voice-session binding. Retrieval is created before join, so
   * the session supplies this through a getter that fails closed until its
   * injected test/local start handle is available. */
  readonly sessionId: bigint;
};
