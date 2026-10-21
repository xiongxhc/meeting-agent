// The Team Vault index adapter: a read-only search surface over a real git
// checkout of published Markdown. Not listed among task-6-brief.md's
// required test file (only test/retrieval-router.test.ts is), but the
// router's own test suite exercises this adapter only through fakes -- this
// file is the one place that proves the REAL adapter reads Markdown only,
// records a real git revision, detects a real staleness, and never writes
// anything, against a real temporary git working tree. No live TeamMem
// checkout or vault is ever touched -- every fixture below is a throwaway
// temp directory this test creates and removes itself.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createTeamVaultIndex, createTeamVaultIndexOrDegraded } from "../src/adapters/team-vault-index.ts";

// Fixture git commands never inherit GIT_* variables (e.g. GIT_DIR or
// GIT_INDEX_FILE set by an enclosing hook), so they only touch the fixture.
const FIXTURE_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
);

function withTempGitVault(run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), "team-vault-fixture-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir, env: FIXTURE_ENV });
    execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: dir, env: FIXTURE_ENV });
    execFileSync("git", ["config", "user.name", "Fixture"], { cwd: dir, env: FIXTURE_ENV });
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function commitAll(dir: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: dir, env: FIXTURE_ENV });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir, env: FIXTURE_ENV });
}

function headRevision(dir: string): string {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", env: FIXTURE_ENV }).trim();
}

test("indexes published Markdown and returns a scored hit with sourcePath and indexedRevision", () => {
  withTempGitVault((dir) => {
    writeFileSync(
      path.join(dir, "roadmap.md"),
      "# Q3 roadmap\n\nThe launch date moved to October after the review.\n",
    );
    commitAll(dir, "publish roadmap note");
    const revision = headRevision(dir);

    const index = createTeamVaultIndex({ teamVaultDir: dir });
    const result = index.search("launch date October");

    assert.equal(result.indexedRevision, revision);
    assert.equal(result.stale, false);
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0]?.source, "team_vault");
    assert.equal(result.hits[0]?.sourcePath, "roadmap.md");
    assert.equal(result.hits[0]?.indexedRevision, revision);
    assert.ok((result.hits[0]?.score ?? 0) > 0);
  });
});

test("reads nested Markdown files and reports their path relative to the checkout root", () => {
  withTempGitVault((dir) => {
    mkdirSync(path.join(dir, "projects", "atlas"), { recursive: true });
    writeFileSync(
      path.join(dir, "projects", "atlas", "notes.md"),
      "Atlas project retrospective: onboarding latency improved thirty percent.\n",
    );
    commitAll(dir, "publish atlas notes");

    const index = createTeamVaultIndex({ teamVaultDir: dir });
    const result = index.search("atlas onboarding latency");

    assert.equal(result.hits[0]?.sourcePath, "projects/atlas/notes.md");
  });
});

test("non-Markdown files are never indexed, even when they mention matching terms", () => {
  withTempGitVault((dir) => {
    writeFileSync(path.join(dir, "roadmap.md"), "Nothing relevant here.\n");
    writeFileSync(path.join(dir, "secrets.txt"), "the launch date secret plan is October\n");
    commitAll(dir, "publish");

    const index = createTeamVaultIndex({ teamVaultDir: dir });
    const result = index.search("launch date secret plan October");

    assert.deepEqual(result.hits, []);
  });
});

test("a query matching no file returns no hits, never throws", () => {
  withTempGitVault((dir) => {
    writeFileSync(path.join(dir, "roadmap.md"), "Totally unrelated content.\n");
    commitAll(dir, "publish");

    const index = createTeamVaultIndex({ teamVaultDir: dir });
    const result = index.search("quantum blockchain synergy");

    assert.deepEqual(result.hits, []);
  });
});

test("a checkout that advances after the index was built is reported stale, with the original indexedRevision preserved", () => {
  withTempGitVault((dir) => {
    writeFileSync(path.join(dir, "roadmap.md"), "The launch date moved to October.\n");
    commitAll(dir, "publish v1");
    const originalRevision = headRevision(dir);

    const index = createTeamVaultIndex({ teamVaultDir: dir });

    // The checkout moves on; the index (no watch mode) does not re-read.
    writeFileSync(path.join(dir, "roadmap.md"), "The launch date moved to November.\n");
    commitAll(dir, "publish v2");

    const result = index.search("launch date");

    assert.equal(result.stale, true);
    assert.equal(result.indexedRevision, originalRevision);
    assert.equal(result.hits[0]?.indexedRevision, originalRevision);
    // Still searching the CONTENT read at construction time (v1's wording),
    // not whatever is on disk now.
    assert.match(result.hits[0]?.excerpt ?? "", /October/);
  });
});

test("refuses a dirty checkout instead of attributing uncommitted Markdown to HEAD", () => {
  withTempGitVault((dir) => {
    writeFileSync(path.join(dir, "roadmap.md"), "Published October decision.\n");
    commitAll(dir, "publish roadmap");
    writeFileSync(path.join(dir, "roadmap.md"), "Unpublished secret December decision.\n");

    assert.throws(() => createTeamVaultIndex({ teamVaultDir: dir }), /clean|stable|dirty/i);
  });
});

test("refuses untracked Markdown instead of indexing it under an unrelated HEAD", () => {
  withTempGitVault((dir) => {
    writeFileSync(path.join(dir, "roadmap.md"), "Published October decision.\n");
    commitAll(dir, "publish roadmap");
    writeFileSync(path.join(dir, "draft.md"), "Untracked November decision.\n");

    assert.throws(() => createTeamVaultIndex({ teamVaultDir: dir }), /clean|stable|dirty/i);
  });
});

test("never indexes ignored untracked Markdown; committed tree bytes remain the only provenance", () => {
  withTempGitVault((dir) => {
    writeFileSync(path.join(dir, ".gitignore"), "ignored.md\n");
    writeFileSync(path.join(dir, "roadmap.md"), "Published October decision.\n");
    commitAll(dir, "publish roadmap");
    writeFileSync(path.join(dir, "ignored.md"), "Unpublished secret December decision.\n");
    const result = createTeamVaultIndex({ teamVaultDir: dir }).search("secret December");
    assert.deepEqual(result.hits, []);
  });
});

test("refuses a Markdown symlink that escapes the published checkout", () => {
  const outside = mkdtempSync(path.join(os.tmpdir(), "team-vault-outside-"));
  try {
    writeFileSync(path.join(outside, "outside.md"), "Escaped confidential Markdown.\n");
    withTempGitVault((dir) => {
      writeFileSync(path.join(dir, "roadmap.md"), "Published October decision.\n");
      symlinkSync(path.join(outside, "outside.md"), path.join(dir, "escape.md"));
      commitAll(dir, "publish roadmap and bad link");

      assert.throws(() => createTeamVaultIndex({ teamVaultDir: dir }), /symlink|escape/i);
    });
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a revision-read failure makes an existing index unavailable, never falsely fresh", () => {
  withTempGitVault((dir) => {
    writeFileSync(path.join(dir, "roadmap.md"), "Published October decision.\n");
    commitAll(dir, "publish roadmap");
    const index = createTeamVaultIndex({ teamVaultDir: dir });
    rmSync(path.join(dir, ".git"), { recursive: true, force: true });

    assert.throws(() => index.search("October"), /revision|git|vault/i);
  });
});

test("constructing the index over a directory that is not a git working tree throws", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "team-vault-not-git-"));
  try {
    writeFileSync(path.join(dir, "roadmap.md"), "content\n");
    assert.throws(() => createTeamVaultIndex({ teamVaultDir: dir }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("constructing the index over a missing directory throws", () => {
  const missing = path.join(os.tmpdir(), "team-vault-index-fixture-does-not-exist");
  assert.throws(() => createTeamVaultIndex({ teamVaultDir: missing }));
});

// ---------------------------------------------------------------------------
// createTeamVaultIndexOrDegraded: the construction-failure path a real
// session actually reaches (see src/sessions/meeting-session.ts's wiring).
// A broken checkout must degrade retrieval, not crash session construction.
// ---------------------------------------------------------------------------

test("createTeamVaultIndexOrDegraded never throws for a missing checkout, and its search() rethrows the original failure", () => {
  const missing = path.join(os.tmpdir(), "team-vault-index-degraded-fixture-does-not-exist");

  const index = createTeamVaultIndexOrDegraded({ teamVaultDir: missing });

  assert.throws(() => index.search("anything"));
});

test("createTeamVaultIndexOrDegraded never throws for a non-git checkout, and its search() rethrows the original failure", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "team-vault-degraded-not-git-"));
  try {
    writeFileSync(path.join(dir, "roadmap.md"), "content\n");

    const index = createTeamVaultIndexOrDegraded({ teamVaultDir: dir });

    assert.throws(() => index.search("anything"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createTeamVaultIndexOrDegraded returns a fully working index for a healthy checkout", () => {
  withTempGitVault((dir) => {
    writeFileSync(path.join(dir, "roadmap.md"), "The launch date moved to October.\n");
    commitAll(dir, "publish");

    const index = createTeamVaultIndexOrDegraded({ teamVaultDir: dir });
    const result = index.search("launch date October");

    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0]?.sourcePath, "roadmap.md");
  });
});

// ---------------------------------------------------------------------------
// Repository namespace binding. The index is bound to the checkout its
// configured directory resolved to at construction. If that checkout's Git
// metadata disappears and the directory now resolves to an enclosing
// repository (Git's ordinary upward discovery), search must refuse instead of
// treating the enclosing repository's HEAD as this vault's revision. Every
// repository below, including each parent, is created by the test itself.
// ---------------------------------------------------------------------------

const FIXED_COMMIT_DATE = "2026-01-01T00:00:00Z";

function withTempRoot(run: (root: string) => void): void {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "team-vault-namespace-")));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir, env: FIXTURE_ENV });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: dir, env: FIXTURE_ENV });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: dir, env: FIXTURE_ENV });
}

// Same files + same identity + same dates + same message = the same commit id
// in two distinct repositories.
function commitAllAt(dir: string, message: string): void {
  const env = { ...FIXTURE_ENV, GIT_AUTHOR_DATE: FIXED_COMMIT_DATE, GIT_COMMITTER_DATE: FIXED_COMMIT_DATE };
  execFileSync("git", ["add", "-A"], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir, env });
}

function topLevel(dir: string): string {
  return realpathSync(execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", env: FIXTURE_ENV }).trim());
}

/** A committed parent repository that ignores `vaults/`, plus a separately
 * initialized and committed child vault at `vaults/team` beneath it. */
function parentWithChildVault(root: string, parentFiles: Record<string, string>, childFiles: Record<string, string>) {
  const parent = path.join(root, "parent");
  initRepo(parent);
  for (const [name, content] of Object.entries(parentFiles)) writeFileSync(path.join(parent, name), content);
  commitAllAt(parent, "publish");
  const child = path.join(parent, "vaults", "team");
  initRepo(child);
  for (const [name, content] of Object.entries(childFiles)) {
    mkdirSync(path.dirname(path.join(child, name)), { recursive: true });
    writeFileSync(path.join(child, name), content);
  }
  commitAllAt(child, "publish");
  return { parent, child };
}

test("a vault whose own Git metadata vanished is not rebound to an enclosing parent repository", () => {
  withTempRoot((root) => {
    const { parent, child } = parentWithChildVault(
      root,
      { ".gitignore": "vaults/\n", "budget.md": "Parent workspace budget notes.\n" },
      { "roadmap.md": "Published October decision.\n" },
    );
    const index = createTeamVaultIndex({ teamVaultDir: child });
    const healthy = index.search("October");
    assert.equal(healthy.hits.length, 1);
    assert.equal(healthy.stale, false);

    rmSync(path.join(child, ".git"), { recursive: true, force: true });
    assert.equal(topLevel(child), parent, "Git now discovers the parent repository from the vault directory");

    assert.throws(() => index.search("October"), /namespace/i);
  });
});

test("an enclosing parent repository at the very same commit is still refused, not reported fresh", () => {
  withTempRoot((root) => {
    const files = { ".gitignore": "vaults/\n", "roadmap.md": "Published October decision.\n" };
    const { parent, child } = parentWithChildVault(root, files, files);
    assert.equal(headRevision(child), headRevision(parent), "fixture repositories share one commit id");
    assert.notEqual(topLevel(child), topLevel(parent));
    const index = createTeamVaultIndex({ teamVaultDir: child });
    const indexedRevision = index.search("October").indexedRevision;

    rmSync(path.join(child, ".git"), { recursive: true, force: true });
    assert.equal(headRevision(child), indexedRevision, "the discovered parent HEAD equals the indexed revision");

    assert.throws(() => index.search("October"), /namespace/i);
  });
});

test("a configured subdirectory keeps whole-checkout indexing, checkout-relative paths and ordinary staleness", () => {
  withTempRoot((root) => {
    const repo = path.join(root, "vault");
    initRepo(repo);
    mkdirSync(path.join(repo, "teams", "atlas"), { recursive: true });
    writeFileSync(path.join(repo, "roadmap.md"), "Published October decision.\n");
    writeFileSync(path.join(repo, "teams", "atlas", "notes.md"), "Atlas onboarding latency improved.\n");
    commitAllAt(repo, "publish");
    const originalRevision = headRevision(repo);

    const index = createTeamVaultIndex({ teamVaultDir: path.join(repo, "teams") });
    const nested = index.search("atlas onboarding latency");
    assert.equal(nested.hits[0]?.sourcePath, "teams/atlas/notes.md");
    assert.equal(nested.stale, false);
    assert.equal(index.search("October").hits[0]?.sourcePath, "roadmap.md");

    writeFileSync(path.join(repo, "roadmap.md"), "Published November decision.\n");
    commitAll(repo, "publish v2");
    const advanced = index.search("October");
    assert.equal(advanced.stale, true);
    assert.equal(advanced.indexedRevision, originalRevision);
  });
});

test("a configured subdirectory of a vanished nested vault is not rebound to the enclosing repository", () => {
  withTempRoot((root) => {
    const { child } = parentWithChildVault(
      root,
      { ".gitignore": "vaults/\n", "budget.md": "Parent workspace budget notes.\n" },
      { "teams/notes.md": "Atlas onboarding latency improved.\n" },
    );
    const index = createTeamVaultIndex({ teamVaultDir: path.join(child, "teams") });
    assert.equal(index.search("atlas onboarding").hits[0]?.sourcePath, "teams/notes.md");

    rmSync(path.join(child, ".git"), { recursive: true, force: true });

    assert.throws(() => index.search("atlas onboarding"), /namespace/i);
  });
});

test("a linked worktree (a .git file, not a directory) indexes, goes stale on its own HEAD, and fails once its metadata is gone", () => {
  withTempRoot((root) => {
    const main = path.join(root, "main");
    initRepo(main);
    writeFileSync(path.join(main, "roadmap.md"), "Published October decision.\n");
    commitAllAt(main, "publish");
    const worktree = path.join(root, "linked");
    execFileSync("git", ["worktree", "add", "-q", "--detach", worktree], { cwd: main, env: FIXTURE_ENV });
    assert.ok(statSync(path.join(worktree, ".git")).isFile());
    const originalRevision = headRevision(worktree);

    const index = createTeamVaultIndex({ teamVaultDir: worktree });
    assert.equal(index.search("October").stale, false);

    writeFileSync(path.join(worktree, "roadmap.md"), "Published November decision.\n");
    commitAll(worktree, "publish v2 in the linked worktree");
    const advanced = index.search("October");
    assert.equal(advanced.stale, true);
    assert.equal(advanced.indexedRevision, originalRevision);

    rmSync(path.join(main, ".git", "worktrees", "linked"), { recursive: true, force: true });
    assert.throws(() => index.search("October"), /revision is unavailable/i);
  });
});

test("a configured symlink alias works, and retargeting it to another repository at the same commit is refused", () => {
  withTempRoot((root) => {
    const files = { "roadmap.md": "Published October decision.\n" };
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    for (const repo of [first, second]) {
      initRepo(repo);
      for (const [name, content] of Object.entries(files)) writeFileSync(path.join(repo, name), content);
      commitAllAt(repo, "publish");
    }
    assert.equal(headRevision(first), headRevision(second), "fixture repositories share one commit id");
    const alias = path.join(root, "alias");
    symlinkSync(first, alias);

    const index = createTeamVaultIndex({ teamVaultDir: alias });
    const healthy = index.search("October");
    assert.equal(healthy.hits[0]?.sourcePath, "roadmap.md");
    assert.equal(healthy.stale, false);
    assert.equal(index.search("October").stale, false, "a stable alias stays bound");

    unlinkSync(alias);
    symlinkSync(second, alias);
    assert.equal(headRevision(alias), healthy.indexedRevision);

    assert.throws(() => index.search("October"), /namespace/i);
  });
});

test("search after construction does not read later dirty or untracked bytes and still judges freshness by HEAD only", () => {
  withTempGitVault((dir) => {
    writeFileSync(path.join(dir, "roadmap.md"), "Published October decision.\n");
    commitAll(dir, "publish roadmap");
    const index = createTeamVaultIndex({ teamVaultDir: dir });

    writeFileSync(path.join(dir, "roadmap.md"), "Unpublished December decision.\n");
    writeFileSync(path.join(dir, "draft.md"), "Untracked December decision.\n");

    const result = index.search("decision");
    assert.equal(result.stale, false);
    assert.deepEqual(result.hits.map((hit) => hit.excerpt), ["Published October decision."]);
  });
});

test("retargeting an alias between two linked worktrees of one repository at the same commit is refused", () => {
  withTempRoot((root) => {
    const main = path.join(root, "main");
    initRepo(main);
    writeFileSync(path.join(main, "roadmap.md"), "Published October decision.\n");
    commitAllAt(main, "publish");
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    execFileSync("git", ["worktree", "add", "-q", "--detach", first], { cwd: main, env: FIXTURE_ENV });
    execFileSync("git", ["worktree", "add", "-q", "--detach", second], { cwd: main, env: FIXTURE_ENV });
    const alias = path.join(root, "alias");
    symlinkSync(first, alias);

    const index = createTeamVaultIndex({ teamVaultDir: alias });
    const healthy = index.search("October");
    assert.equal(healthy.stale, false);

    unlinkSync(alias);
    symlinkSync(second, alias);
    assert.equal(headRevision(alias), healthy.indexedRevision);

    assert.throws(() => index.search("October"), /namespace/i);
  });
});

test("the same top level backed by a different Git directory at the same commit is refused", () => {
  withTempRoot((root) => {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    const secondGitDir = path.join(root, "second.git");
    initRepo(first);
    execFileSync("git", ["init", "-q", "--separate-git-dir", secondGitDir, second], { cwd: root, env: FIXTURE_ENV });
    execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: second, env: FIXTURE_ENV });
    execFileSync("git", ["config", "user.name", "Fixture"], { cwd: second, env: FIXTURE_ENV });
    for (const repo of [first, second]) {
      writeFileSync(path.join(repo, "roadmap.md"), "Published October decision.\n");
      commitAllAt(repo, "publish");
    }
    const index = createTeamVaultIndex({ teamVaultDir: first });
    const healthy = index.search("October");
    assert.equal(healthy.stale, false);

    rmSync(path.join(first, ".git"), { recursive: true, force: true });
    writeFileSync(path.join(first, ".git"), `gitdir: ${secondGitDir}\n`);
    assert.equal(topLevel(first), first, "top level unchanged");
    assert.equal(headRevision(first), healthy.indexedRevision, "same commit");
    const gitDir = execFileSync("git", ["-C", first, "rev-parse", "--absolute-git-dir"], { encoding: "utf8", env: FIXTURE_ENV }).trim();
    assert.equal(realpathSync(gitDir), realpathSync(secondGitDir), "now backed by the other Git directory");

    assert.throws(() => index.search("October"), /namespace/i);
  });
});
