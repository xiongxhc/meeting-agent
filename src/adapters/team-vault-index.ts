// A read-only index over a published Team Vault checkout: Markdown files
// only, read once at construction from a directory on disk, with the git
// revision of that checkout recorded at the same moment. No search engine,
// no embeddings, no vector store, and no watch mode -- see
// docs task-6-report.md for why that is enough for this product. The only
// reader this module exists to serve is src/sessions/retrieval-router.ts.
//
// READ-ONLY BY CONSTRUCTION: the only filesystem call in this file is
// realpathSync, and every shell-out is a read-only git query (`rev-parse`,
// `status`, `ls-tree`, `show`) -- Markdown bytes come from the committed tree
// via git, never from the working directory. There is no write-shaped call
// anywhere here -- test/boundaries.test.ts's writable-fs scanner
// (test/lib/import-scanner.ts) enforces that structurally across all of
// src/, and this module satisfies it by never reaching for a write API at
// all, not by working around the scanner's heuristic.
//
// The build is written once, as a generator that yields each git query and
// receives its stdout, and is driven either synchronously (execFileSync) or
// asynchronously (execFile). Both drivers run the same queries in the same
// order with the same checks; the asynchronous one only keeps the event loop
// free while git runs, so a session can start its join while its index builds.

import { execFile, execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

import {
  termCoverageScore,
  type KnowledgeHit,
  type TeamVaultIndexPort,
  type TeamVaultSearchResult,
} from "../ports/knowledge.ts";

const MARKDOWN_EXTENSION = ".md";

type IndexedFile = {
  readonly relativePath: string;
  readonly paragraphs: readonly string[];
};

export type CreateTeamVaultIndexOptions = {
  /** The configured Team Vault checkout -- `config.dataPaths.teamVaultDir`.
   * Named to match that field, which is also the exact identifier
   * test/lib/import-scanner.ts's writable-fs scan treats as forbidden to
   * reach a write call. This module only ever reads it. */
  readonly teamVaultDir: string;
};

/** Which checkout a directory resolves to: its canonical worktree top level
 * and canonical per-worktree git directory (linked worktrees share a common
 * dir, so that alone would not tell them apart). */
type CheckoutNamespace = {
  readonly topLevel: string;
  readonly gitDir: string;
};

type CheckoutState = {
  readonly namespace: CheckoutNamespace;
  readonly revision: string;
};

/**
 * Builds a read-only index of every committed `.md` file in the checkout that
 * contains `teamVaultDir` (the WHOLE checkout, even when `teamVaultDir` is a
 * subdirectory or a symlink alias; sourcePath is relative to the checkout
 * root), and records the checkout's git revision at that same instant.
 *
 * The index is bound to the checkout `teamVaultDir` resolved to at
 * construction. If the directory later resolves to a different checkout --
 * e.g. the vault's own `.git` vanished and git's upward discovery now finds an
 * enclosing repository, or an alias was retargeted -- `search()` throws even
 * when that checkout's HEAD equals the indexed revision. This binds the
 * namespace observed at construction; it cannot tell an intended
 * subdirectory from a nested repository that vanished BEFORE construction.
 *
 * Throws if the directory cannot be read or
 * is not inside a readable git working tree -- the retrieval router treats
 * any throw from `search()` as "vault unavailable"; a throw here, at
 * construction, is a startup-time configuration error for whoever wires
 * `config.dataPaths.teamVaultDir` into this factory.
 */
export function createTeamVaultIndex(options: CreateTeamVaultIndexOptions): TeamVaultIndexPort {
  return runSync(buildIndex(options.teamVaultDir));
}

/** The same build as `createTeamVaultIndex` (same git queries, order,
 * refusals and namespace/revision binding, starting when called), without
 * blocking the event loop while git runs. Rejects where that one throws. */
export function createTeamVaultIndexAsync(options: CreateTeamVaultIndexOptions): Promise<TeamVaultIndexPort> {
  return runAsync(buildIndex(options.teamVaultDir));
}

/** A git query the build needs: its argv, run as `git <argv>` from PATH. */
type GitQuery = readonly string[];
type Build<T> = Generator<GitQuery, T, string>;

function runSync<T>(build: Build<T>): T {
  let step = build.next();
  while (!step.done) {
    let output: string;
    try {
      output = execFileSync("git", step.value, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      step = build.throw(error);
      continue;
    }
    step = build.next(output);
  }
  return step.value;
}

async function runAsync<T>(build: Build<T>): Promise<T> {
  let step = build.next();
  while (!step.done) {
    const query = step.value;
    let output: string;
    try {
      output = await new Promise<string>((resolve, reject) => {
        const child = execFile("git", query, { encoding: "utf8" }, (error, stdout) => { if (error) reject(error); else resolve(stdout); });
        child.stdin?.end();
      });
    } catch (error) {
      step = build.throw(error);
      continue;
    }
    step = build.next(output);
  }
  return step.value;
}

function* buildIndex(teamVaultDir: string): Build<TeamVaultIndexPort> {
  // A HEAD revision is provenance only for the bytes committed at that HEAD.
  // Refuse a dirty tree rather than silently attaching untracked/draft text to
  // an unrelated published revision. Verify before and after the read so a
  // checkout advancing during construction cannot create a mixed snapshot.
  const bound = yield* readCheckoutState(teamVaultDir);
  yield* assertCleanWorkingTree(teamVaultDir);
  const indexedRevision = bound.revision;
  const files = yield* readMarkdownFiles(teamVaultDir, indexedRevision);
  yield* assertCleanWorkingTree(teamVaultDir);
  const after = yield* readCheckoutState(teamVaultDir);
  if (!sameNamespace(after.namespace, bound.namespace)) {
    throw new Error("Team Vault namespace changed while its index was being built");
  }
  if (after.revision !== indexedRevision) {
    throw new Error("Team Vault checkout advanced while its index was being built");
  }

  return {
    search(query: string): TeamVaultSearchResult {
      const hits: KnowledgeHit[] = [];
      for (const file of files) {
        const best = bestParagraph(query, file.paragraphs);
        if (best === null || best.score <= 0) continue;
        hits.push({
          source: "team_vault",
          sourcePath: file.relativePath,
          excerpt: best.paragraph,
          score: best.score,
          indexedRevision,
        });
      }
      hits.sort((a, b) => b.score - a.score);

      // One git invocation reports namespace and HEAD from the same
      // discovery, so the revision compared below belongs to that namespace.
      const current = runSync(tryReadCheckoutState(teamVaultDir));
      if (current === null) {
        throw new Error("Team Vault revision is unavailable; refusing stale provenance");
      }
      if (!sameNamespace(current.namespace, bound.namespace)) {
        throw new Error("Team Vault namespace changed: the directory no longer resolves to the indexed checkout");
      }
      const stale = current.revision !== indexedRevision;

      return { hits, indexedRevision, stale };
    },
  };
}

function bestParagraph(
  query: string,
  paragraphs: readonly string[],
): { readonly paragraph: string; readonly score: number } | null {
  let best: { paragraph: string; score: number } | null = null;
  for (const paragraph of paragraphs) {
    const score = termCoverageScore(query, paragraph);
    if (best === null || score > best.score) {
      best = { paragraph, score };
    }
  }
  return best;
}

function* readMarkdownFiles(rootDir: string, revision: string): Build<readonly IndexedFile[]> {
  const listing = yield ["-C", rootDir, "ls-tree", "-r", "-z", "--full-tree", revision];
  const files: IndexedFile[] = [];
  for (const row of listing.split("\0")) {
    if (row === "") continue;
    const match = /^(\d+) \w+ [0-9a-f]+\t(.+)$/u.exec(row);
    if (match === null) throw new Error("Team Vault git tree entry is malformed");
    const mode = match[1];
    const relativePath = match[2];
    if (mode === undefined || relativePath === undefined) throw new Error("Team Vault git tree entry is malformed");
    if (!relativePath.toLowerCase().endsWith(MARKDOWN_EXTENSION)) continue;
    if (mode === "120000") throw new Error(`Team Vault index refuses symlink entry "${relativePath}"`);
    const content = yield ["-C", rootDir, "show", `${revision}:${relativePath}`];
    files.push({ relativePath, paragraphs: splitParagraphs(content) });
  }
  return files;
}

function splitParagraphs(content: string): readonly string[] {
  return content
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

/**
 * Never throws. Wraps `createTeamVaultIndex`: on any construction failure
 * (missing/unreadable checkout, not a git working tree), returns a
 * `TeamVaultIndexPort` whose `search()` always rethrows that same failure
 * instead of a working index.
 *
 * This is what makes the spec's "Team Vault search fails -> continue from
 * current context and say historical memory is unavailable" row reachable
 * at RUNTIME rather than only against a hand-written throwing fake: a real
 * checkout that is missing or broken at session start would otherwise never
 * reach `src/sessions/retrieval-router.ts`'s `vaultUnavailable` branch at
 * all -- construction would simply throw before a `TeamVaultIndexPort` ever
 * existed for the router to call. Wiring (src/sessions/meeting-session.ts)
 * uses this constructor, never the throwing one, precisely so a broken
 * checkout degrades the session's retrieval instead of crashing it.
 */
export function createTeamVaultIndexOrDegraded(
  options: CreateTeamVaultIndexOptions,
): TeamVaultIndexPort {
  try {
    return createTeamVaultIndex(options);
  } catch (error) {
    return degraded(error);
  }
}

/** `createTeamVaultIndexOrDegraded` over the asynchronous build: never
 * rejects; a failed build resolves to an index whose search() rethrows it. */
export function createTeamVaultIndexOrDegradedAsync(
  options: CreateTeamVaultIndexOptions,
): Promise<TeamVaultIndexPort> {
  return createTeamVaultIndexAsync(options).catch(degraded);
}

function degraded(error: unknown): TeamVaultIndexPort {
  const failure = error instanceof Error ? error : new Error(String(error));
  return {
    search(): TeamVaultSearchResult {
      throw failure;
    },
  };
}

function* readCheckoutState(dir: string): Build<CheckoutState> {
  const state = yield* tryReadCheckoutState(dir);
  if (state === null) {
    throw new Error(`Team Vault checkout at "${dir}" is not a readable git working tree`);
  }
  return state;
}

/** Null when `dir` is not inside a non-bare git working tree with a HEAD
 * commit. `--show-toplevel` refuses a bare repository. */
function* tryReadCheckoutState(dir: string): Build<CheckoutState | null> {
  try {
    const [topLevel, gitDir, revision] = (yield ["-C", dir, "rev-parse", "--show-toplevel", "--absolute-git-dir", "HEAD"]).split("\n");
    if (!topLevel || !gitDir || !revision) return null;
    return { namespace: { topLevel: realpathSync(topLevel), gitDir: realpathSync(gitDir) }, revision };
  } catch {
    return null;
  }
}

function sameNamespace(a: CheckoutNamespace, b: CheckoutNamespace): boolean {
  return a.topLevel === b.topLevel && a.gitDir === b.gitDir;
}

function* assertCleanWorkingTree(dir: string): Build<void> {
  try {
    const status = yield ["-C", dir, "status", "--porcelain=v1", "--untracked-files=all"];
    if (status.trim() !== "") {
      throw new Error("Team Vault checkout is dirty or has untracked files");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("dirty or has untracked")) throw error;
    throw new Error(`Team Vault checkout at "${dir}" is not a clean readable git working tree`);
  }
}
