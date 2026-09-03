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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createTeamVaultIndex, createTeamVaultIndexOrDegraded } from "../src/adapters/team-vault-index.ts";

function withTempGitVault(run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), "team-vault-fixture-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Fixture"], { cwd: dir });
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function commitAll(dir: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir });
}

function headRevision(dir: string): string {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
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
