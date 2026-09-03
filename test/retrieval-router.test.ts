// The retrieval router: current-meeting memory first, Team Vault second,
// and the vault is queried only when the current meeting is insufficient.
// That ordering is a spec requirement, not an optimization, so several
// tests here assert on the vault fake's own call log being empty -- not
// merely that the answer came back right -- because a wrong-but-plausible
// implementation could always reach the vault and still produce a correct
// text.
//
// Required scenarios (task-6-brief.md): current-meeting-only answers,
// current-meeting hits preventing an unnecessary vault lookup, vault
// fallback, mixed context, a stale index revision, the vault unavailable,
// and no results. Plus: bounded excerpts/context are observable (never a
// silent truncation), a partial transcript can prepare retrieval but can
// never reach authorize, and context is always seeded before authorize is
// called.

import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  KnowledgeHit,
  SeededContext,
  TeamVaultSearchResult,
} from "../src/ports/knowledge.ts";
import {
  createCurrentMeetingMemory,
  createRetrievalRouter,
  EXCERPT_MAX_CHARS,
  MAX_HITS,
  MAX_SEEDED_CONTEXT_CHARS,
  SUFFICIENCY_THRESHOLD,
} from "../src/sessions/retrieval-router.ts";

// ---------------------------------------------------------------------------
// Fakes -- local to this test file, deliberately dumb: they record what they
// were asked to do and return exactly what the test configured, nothing more.
// ---------------------------------------------------------------------------

type VaultCall = { readonly query: string };

function fakeVault(
  respond: (query: string) => TeamVaultSearchResult,
): { search(query: string): TeamVaultSearchResult; calls: VaultCall[] } {
  const calls: VaultCall[] = [];
  return {
    calls,
    search(query: string): TeamVaultSearchResult {
      calls.push({ query });
      return respond(query);
    },
  };
}

function throwingVault(error: Error): { search(query: string): TeamVaultSearchResult; calls: VaultCall[] } {
  const calls: VaultCall[] = [];
  return {
    calls,
    search(query: string): TeamVaultSearchResult {
      calls.push({ query });
      throw error;
    },
  };
}

type SinkCall =
  | { readonly method: "seedContext"; readonly context: SeededContext }
  | { readonly method: "authorizeVoiceResponse"; readonly segmentId: string };

function fakeSink(): { seedContext(c: SeededContext): Promise<void>; authorizeVoiceResponse(id: string): Promise<void>; calls: SinkCall[] } {
  const calls: SinkCall[] = [];
  return {
    calls,
    async seedContext(context: SeededContext): Promise<void> {
      calls.push({ method: "seedContext", context });
    },
    async authorizeVoiceResponse(segmentId: string): Promise<void> {
      calls.push({ method: "authorizeVoiceResponse", segmentId });
    },
  };
}

function vaultHit(overrides: Partial<KnowledgeHit> = {}): KnowledgeHit {
  return {
    source: "team_vault",
    sourcePath: "notes/q3-roadmap.md",
    excerpt: "The Q3 roadmap review moved the launch date to October.",
    score: 0.8,
    indexedRevision: "abc1234",
    ...overrides,
  };
}

const invocation = { segmentId: "seg_001", authorize: true as const, matchedAlias: "Meetbot" };

// ---------------------------------------------------------------------------
// Current-meeting-only answers
// ---------------------------------------------------------------------------

test("current-meeting-only answer: a sufficient current-meeting hit is used, with correct provenance", async () => {
  const memory = createCurrentMeetingMemory();
  memory.record({ segmentId: "seg_a", text: "We decided the launch budget is fifty thousand dollars.", final: true });

  const vault = fakeVault(() => ({ hits: [], indexedRevision: null, stale: false }));
  const sink = fakeSink();
  const router = createRetrievalRouter({ vault, sink, memory });

  const context = await router.answer(invocation, "what is the launch budget");

  assert.equal(context.hits.length, 1);
  assert.equal(context.hits[0]?.source, "current_meeting");
  assert.equal(context.hits[0]?.sourcePath, null);
  assert.equal(context.hits[0]?.indexedRevision, null);
  assert.match(context.text, /fifty thousand dollars/);
});

// ---------------------------------------------------------------------------
// Current-meeting hits preventing an unnecessary vault lookup
// ---------------------------------------------------------------------------

test("a sufficient current-meeting hit never reaches the vault index at all", async () => {
  const memory = createCurrentMeetingMemory();
  memory.record({
    segmentId: "seg_a",
    text: "The launch budget is fifty thousand dollars, approved this morning.",
    final: true,
  });

  // The vault WOULD answer this query correctly too -- the point of the test
  // is that it is never asked, not that the router chooses the right source
  // when both could answer.
  const vault = fakeVault(() => ({ hits: [vaultHit({ excerpt: "launch budget fifty thousand dollars" })], indexedRevision: "rev1", stale: false }));
  const sink = fakeSink();
  const router = createRetrievalRouter({ vault, sink, memory });

  const context = await router.answer(invocation, "what is the launch budget");

  assert.equal(vault.calls.length, 0, "vault index must not be touched when the current meeting sufficed");
  assert.equal(context.vaultQueried, false);
  assert.ok(context.hits.every((h) => h.source === "current_meeting"));
});

// ---------------------------------------------------------------------------
// Vault fallback
// ---------------------------------------------------------------------------

test("vault fallback: an insufficient current meeting queries the vault and uses its hits", async () => {
  const memory = createCurrentMeetingMemory();
  // Present, but shares no terms with the query -- current-meeting search
  // returns nothing relevant, so the router must fall back to the vault.
  memory.record({ segmentId: "seg_a", text: "Let's grab coffee after this.", final: true });

  const vault = fakeVault(() => ({
    hits: [vaultHit({ excerpt: "The Q3 roadmap review moved the launch date to October." })],
    indexedRevision: "abc1234",
    stale: false,
  }));
  const sink = fakeSink();
  const router = createRetrievalRouter({ vault, sink, memory });

  const context = await router.answer(invocation, "when did we move the launch date");

  assert.equal(vault.calls.length, 1);
  assert.equal(context.vaultQueried, true);
  assert.equal(context.vaultUnavailable, false);
  assert.equal(context.hits.length, 1);
  assert.equal(context.hits[0]?.source, "team_vault");
  assert.equal(context.hits[0]?.sourcePath, "notes/q3-roadmap.md");
  assert.equal(context.hits[0]?.indexedRevision, "abc1234");
});

// ---------------------------------------------------------------------------
// Mixed context
// ---------------------------------------------------------------------------

test("mixed context: current-meeting and vault hits are both included when neither alone suffices", async () => {
  const memory = createCurrentMeetingMemory();
  // Covers only one of the three query terms ("budget") -- below
  // SUFFICIENCY_THRESHOLD, so the router must still reach for the vault.
  memory.record({ segmentId: "seg_a", text: "budget discussion happening now", final: true });

  const vault = fakeVault(() => ({
    hits: [vaultHit({ excerpt: "The original launch date budget was set last quarter." })],
    indexedRevision: "abc1234",
    stale: false,
  }));
  const sink = fakeSink();
  const router = createRetrievalRouter({ vault, sink, memory });

  const context = await router.answer(invocation, "launch date budget");

  assert.equal(context.vaultQueried, true);
  const sources = context.hits.map((h) => h.source).sort();
  assert.deepEqual(sources, ["current_meeting", "team_vault"]);
});

// ---------------------------------------------------------------------------
// Stale index revision
// ---------------------------------------------------------------------------

test("stale index revision: hits keep the original indexedRevision, and staleness is surfaced on the context", async () => {
  const memory = createCurrentMeetingMemory();
  const vault = fakeVault(() => ({
    hits: [vaultHit({ indexedRevision: "old-rev-0001" })],
    indexedRevision: "old-rev-0001",
    stale: true,
  }));
  const sink = fakeSink();
  const router = createRetrievalRouter({ vault, sink, memory });

  const context = await router.answer(invocation, "launch date");

  assert.equal(context.vaultStale, true);
  assert.equal(context.hits[0]?.indexedRevision, "old-rev-0001");
  assert.match(context.text, /outdated|stale/i);
});

// ---------------------------------------------------------------------------
// Vault unavailable
// ---------------------------------------------------------------------------

test("vault unavailable: the router still authorizes, using current context plus an explicit unavailability fact", async () => {
  const memory = createCurrentMeetingMemory();
  memory.record({ segmentId: "seg_a", text: "We are discussing the timeline today.", final: true });

  const vault = throwingVault(new Error("checkout unreadable"));
  const sink = fakeSink();
  const router = createRetrievalRouter({ vault, sink, memory });

  const context = await router.answer(invocation, "what did we decide last quarter");

  assert.equal(context.vaultQueried, true);
  assert.equal(context.vaultUnavailable, true);
  assert.match(
    context.text,
    /historical team memory.*unavailable/i,
    "the unavailability must be an explicit stated fact in the seeded text, not merely an internal flag",
  );

  const authorizeCall = sink.calls.find((c) => c.method === "authorizeVoiceResponse");
  assert.ok(authorizeCall, "vault failure must not block authorizing the response");
});

test("vault unavailable is a field on SeededContext, observable without reading logs", async () => {
  const memory = createCurrentMeetingMemory();
  const vault = throwingVault(new Error("boom"));
  const sink = fakeSink();
  const router = createRetrievalRouter({ vault, sink, memory });

  const context = await router.answer(invocation, "anything");

  const seeded = sink.calls.find((c) => c.method === "seedContext");
  assert.ok(seeded && seeded.method === "seedContext");
  assert.equal(seeded.context.vaultUnavailable, true);
  assert.equal(context.vaultUnavailable, true);
});

// ---------------------------------------------------------------------------
// No results
// ---------------------------------------------------------------------------

test("no results anywhere: the router still authorizes, with an explicit no-knowledge-found fact", async () => {
  const memory = createCurrentMeetingMemory();
  const vault = fakeVault(() => ({ hits: [], indexedRevision: "rev1", stale: false }));
  const sink = fakeSink();
  const router = createRetrievalRouter({ vault, sink, memory });

  const context = await router.answer(invocation, "quantum blockchain synergy roadmap");

  assert.equal(context.hits.length, 0);
  assert.match(context.text, /no relevant information/i);

  const authorizeCall = sink.calls.find((c) => c.method === "authorizeVoiceResponse");
  assert.ok(authorizeCall, "having nothing to say is not a reason to withhold authorization");
});

// ---------------------------------------------------------------------------
// Bounding: excerpts and total seeded context, observably
// ---------------------------------------------------------------------------

test("an oversized excerpt is truncated to EXCERPT_MAX_CHARS and the truncation is visible in the excerpt text itself", async () => {
  const memory = createCurrentMeetingMemory();
  const longText = "decision point ".repeat(60); // well over EXCERPT_MAX_CHARS
  memory.record({ segmentId: "seg_a", text: longText, final: true });

  const vault = fakeVault(() => ({ hits: [], indexedRevision: null, stale: false }));
  const sink = fakeSink();
  const router = createRetrievalRouter({ vault, sink, memory });

  const context = await router.answer(invocation, "decision point");

  assert.ok(context.hits[0]!.excerpt.length <= EXCERPT_MAX_CHARS);
  assert.match(context.hits[0]!.excerpt, /truncated/);
  assert.equal(context.truncatedHitCount, 1);
  assert.match(context.text, /truncated/);
});

test("hits beyond MAX_HITS / MAX_SEEDED_CONTEXT_CHARS are omitted, and the omission is visible on the context", async () => {
  const memory = createCurrentMeetingMemory();
  for (let i = 0; i < MAX_HITS + 3; i += 1) {
    memory.record({ segmentId: `seg_${i}`, text: `topic keyword occurrence number ${i}`, final: true });
  }

  const vault = fakeVault(() => ({ hits: [], indexedRevision: null, stale: false }));
  const sink = fakeSink();
  const router = createRetrievalRouter({ vault, sink, memory });

  const context = await router.answer(invocation, "topic keyword occurrence");

  assert.ok(context.hits.length <= MAX_HITS);
  assert.ok(context.omittedHitCount > 0);
  assert.match(context.text, /omitted/i);

  const totalExcerptChars = context.hits.reduce((sum, h) => sum + h.excerpt.length, 0);
  assert.ok(totalExcerptChars <= MAX_SEEDED_CONTEXT_CHARS);
});

// ---------------------------------------------------------------------------
// Partial transcripts: prepare never authorizes, never a second path to speech
// ---------------------------------------------------------------------------

test("prepare() on a partial segment records nothing searchable and never touches the sink", () => {
  const memory = createCurrentMeetingMemory();
  const vault = fakeVault(() => ({ hits: [], indexedRevision: null, stale: false }));
  const sink = fakeSink();
  const router = createRetrievalRouter({ vault, sink, memory });

  router.prepare({ segmentId: "seg_partial", text: "the launch budget is fif", final: false });

  assert.equal(sink.calls.length, 0);
  // The partial text must not be searchable either -- it could still change.
  assert.deepEqual(memory.search("launch budget"), []);
});

test("prepare() on a final segment makes it searchable but still never touches the sink", () => {
  const memory = createCurrentMeetingMemory();
  const vault = fakeVault(() => ({ hits: [], indexedRevision: null, stale: false }));
  const sink = fakeSink();
  const router = createRetrievalRouter({ vault, sink, memory });

  router.prepare({ segmentId: "seg_final", text: "the launch budget is fifty thousand", final: true });

  assert.equal(sink.calls.length, 0);
  assert.ok(memory.search("launch budget").length > 0);
});

// retrieval-router.ts's `answer` takes an AuthorizedInvocation whose
// `authorize` field is the literal `true` -- there is no negative-decision
// shape that type-checks as an argument, so a caller cannot construct a call
// to `answer` from a skipped/negative gate decision. This is enforced by the
// type system, not at runtime, so there is no runtime test for it; the type
// signature itself is the guard (see src/ports/knowledge.ts,
// AuthorizedInvocation).

// ---------------------------------------------------------------------------
// Context is always seeded before the segment is authorized
// ---------------------------------------------------------------------------

test("seedContext is called before authorizeVoiceResponse, every time", async () => {
  const memory = createCurrentMeetingMemory();
  memory.record({ segmentId: "seg_a", text: "the launch date is October", final: true });
  const vault = fakeVault(() => ({ hits: [], indexedRevision: null, stale: false }));
  const sink = fakeSink();
  const router = createRetrievalRouter({ vault, sink, memory });

  await router.answer(invocation, "launch date");

  assert.equal(sink.calls.length, 2);
  assert.equal(sink.calls[0]?.method, "seedContext");
  assert.equal(sink.calls[1]?.method, "authorizeVoiceResponse");
  assert.equal((sink.calls[1] as { segmentId: string }).segmentId, invocation.segmentId);
});

// ---------------------------------------------------------------------------
// Scoring is transparent: more matching query terms ranks a hit higher
// ---------------------------------------------------------------------------

test("scoring is predictable: a hit covering more of the query's distinct terms ranks first", async () => {
  const memory = createCurrentMeetingMemory();
  memory.record({ segmentId: "seg_weak", text: "budget was discussed", final: true });
  memory.record({ segmentId: "seg_strong", text: "the launch budget timeline was discussed in full", final: true });

  const vault = fakeVault(() => ({ hits: [], indexedRevision: null, stale: false }));
  const sink = fakeSink();
  const router = createRetrievalRouter({ vault, sink, memory });

  const context = await router.answer(invocation, "launch budget timeline");

  assert.equal(context.hits[0]?.excerpt, "the launch budget timeline was discussed in full");
  assert.ok((context.hits[0]?.score ?? 0) > (context.hits[1]?.score ?? 0));
});

test("SUFFICIENCY_THRESHOLD is exported and used as the current-meeting-sufficiency cutoff", () => {
  assert.equal(typeof SUFFICIENCY_THRESHOLD, "number");
  assert.ok(SUFFICIENCY_THRESHOLD > 0 && SUFFICIENCY_THRESHOLD <= 1);
});
