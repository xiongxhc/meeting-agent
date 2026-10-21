// The asynchronous Team Vault build must be the SAME build as the synchronous
// one (same git commands in the same order, same refusals, same namespace and
// revision binding), only without blocking the event loop while git runs.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import * as adapter from "../src/adapters/team-vault-index.ts";
import type { TeamVaultIndexPort } from "../src/ports/knowledge.ts";

const { createTeamVaultIndex } = adapter;
type AsyncBuild = (options: { teamVaultDir: string }) => Promise<TeamVaultIndexPort>;
const asyncBuild = (): AsyncBuild => {
  const value = (adapter as Record<string, unknown>).createTeamVaultIndexAsync;
  assert.equal(typeof value, "function", "createTeamVaultIndexAsync must exist");
  return value as AsyncBuild;
};
const degradedAsync = (): AsyncBuild => {
  const value = (adapter as Record<string, unknown>).createTeamVaultIndexOrDegradedAsync;
  assert.equal(typeof value, "function", "createTeamVaultIndexOrDegradedAsync must exist");
  return value as AsyncBuild;
};

const FIXTURE_ENV: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
const git = (dir: string, ...args: string[]) => execFileSync("/usr/bin/git", args, { cwd: dir, env: FIXTURE_ENV, encoding: "utf8" });
function vault(root: string, name: string, files: Record<string, string> = { "orion.md": "Orion launch code is violet.\n" }): string {
  const dir = path.join(root, name); mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q"); git(dir, "config", "user.email", "fixture@example.invalid"); git(dir, "config", "user.name", "Fixture");
  for (const [file, text] of Object.entries(files)) { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), text); }
  git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "fixture");
  return dir;
}
function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), "team-vault-async-"));
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
}
/** Runs `git` from PATH through a /bin/sh wrapper (optionally slow, optionally logging argv). */
async function withGitWrapper<T>(root: string, { delaySeconds = 0, log }: { delaySeconds?: number; log?: string }, run: () => Promise<T>): Promise<T> {
  const bin = mkdtempSync(path.join(root, "bin-"));
  writeFileSync(path.join(bin, "git"), `#!/bin/sh\n${delaySeconds > 0 ? `sleep ${delaySeconds}\n` : ""}${log ? `printf '%s\\037' "$@" >> '${log}'; printf '\\n' >> '${log}'\n` : ""}exec /usr/bin/git "$@"\n`, { mode: 0o700 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved ?? "/usr/bin:/bin"}`;
  try { return await run(); } finally { process.env.PATH = saved; }
}
type Outcome = { error: string } | { results: unknown[] };
const QUERIES = ["Orion launch code", "budget", "nothing matches this"];
async function outcome(build: () => TeamVaultIndexPort | Promise<TeamVaultIndexPort>): Promise<Outcome> {
  try { const index = await build(); return { results: QUERIES.map((q) => { try { return index.search(q); } catch (e) { return { searchError: (e as Error).message }; } }) }; }
  catch (error) { return { error: (error as Error).message }; }
}

const SCENARIOS: Record<string, (root: string) => string> = {
  healthy: (root) => vault(root, "v"),
  nested: (root) => vault(root, "v", { "a/b/deep.md": "Budget is seven.\n", "top.md": "Orion launch code is violet.\n", "notes.txt": "Orion budget\n" }),
  dirty: (root) => { const dir = vault(root, "v"); writeFileSync(path.join(dir, "orion.md"), "edited\n"); return dir; },
  untracked: (root) => { const dir = vault(root, "v"); writeFileSync(path.join(dir, "draft.md"), "draft\n"); return dir; },
  symlinkEscape: (root) => { writeFileSync(path.join(root, "outside.md"), "secret\n"); const dir = path.join(root, "v"); mkdirSync(dir); git(dir, "init", "-q"); git(dir, "config", "user.email", "f@e.invalid"); git(dir, "config", "user.name", "F"); symlinkSync(path.join(root, "outside.md"), path.join(dir, "link.md")); git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "x"); return dir; },
  missing: (root) => path.join(root, "does-not-exist"),
  notGit: (root) => { const dir = path.join(root, "plain"); mkdirSync(dir); writeFileSync(path.join(dir, "a.md"), "x\n"); return dir; },
  subdirectory: (root) => path.join(vault(root, "v", { "sub/a.md": "Orion launch code is violet.\n", "b.md": "budget\n" }), "sub"),
  // rev-parse still works but status fails: the clean-tree check must refuse, not pass.
  corruptIndex: (root) => { const dir = vault(root, "v"); writeFileSync(path.join(dir, ".git", "index"), "not an index"); return dir; },
  vanishedNested: (root) => { const parent = vault(root, "p", { "p.md": "parent budget\n" }); const inner = vault(parent, "inner"); rmSync(path.join(inner, ".git"), { recursive: true, force: true }); return inner; },
};

for (const [name, make] of Object.entries(SCENARIOS)) {
  test(`async build equals the synchronous build: ${name}`, () => withRoot(async (root) => {
    const dir = make(root);
    const sync = await outcome(() => createTeamVaultIndex({ teamVaultDir: dir }));
    const viaAsync = await outcome(() => asyncBuild()({ teamVaultDir: dir }));
    assert.deepEqual(viaAsync, sync);
  }));
}

test("async build runs exactly the synchronous build's git commands in the same order", () => withRoot(async (root) => {
  for (const make of [SCENARIOS.healthy!, SCENARIOS.nested!, SCENARIOS.dirty!]) {
    const dir = make(mkdtempSync(path.join(root, "case-")));
    const syncLog = path.join(root, `sync-${path.basename(path.dirname(dir))}.log`), asyncLog = path.join(root, `async-${path.basename(path.dirname(dir))}.log`);
    await withGitWrapper(root, { log: syncLog }, async () => { try { createTeamVaultIndex({ teamVaultDir: dir }); } catch { /* refusal compared below */ } });
    await withGitWrapper(root, { log: asyncLog }, async () => { try { await asyncBuild()({ teamVaultDir: dir }); } catch { /* refusal compared below */ } });
    const calls = (file: string) => readFileSync(file, "utf8").trim().split("\n");
    assert.ok(calls(syncLog).length >= (make === SCENARIOS.dirty ? 2 : 5));
    assert.deepEqual(calls(asyncLog), calls(syncLog));
  }
}));

test("a namespace that changes between the build's first and last read is refused by the async build", () => withRoot(async (root) => {
  const parent = vault(root, "p", { "p.md": "parent\n" });
  const inner = vault(parent, "inner");
  // Slow git, and the nested vault's metadata disappears while the build is in flight,
  // so the closing read resolves to the enclosing repository.
  await withGitWrapper(root, { delaySeconds: 0.15 }, async () => {
    const building = asyncBuild()({ teamVaultDir: inner });
    await new Promise((resolve) => setTimeout(resolve, 400));
    renameSync(path.join(inner, ".git"), path.join(root, "moved-git"));
    await assert.rejects(building, /namespace changed|not a clean readable git working tree|dirty|advanced/);
  });
}));

test("the async build does not block the event loop while git runs", () => withRoot(async (root) => {
  const dir = vault(root, "v");
  await withGitWrapper(root, { delaySeconds: 0.1 }, async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 10);
    let returnedMs: number, index: TeamVaultIndexPort;
    try {
      const started = process.hrtime.bigint();
      const building = asyncBuild()({ teamVaultDir: dir });
      returnedMs = Number(process.hrtime.bigint() - started) / 1e6;
      index = await building;
    } finally { clearInterval(timer); }
    assert.ok(returnedMs < 50, `returned after ${returnedMs} ms`);
    assert.ok(ticks >= 20, `event loop ran ${ticks} timer ticks during a >=500 ms build`);
    assert.equal(index.search("Orion launch code").hits.length, 1);
  });
}));

test("the degraded async builder never rejects and its search rethrows the original failure", () => withRoot(async (root) => {
  const missing = path.join(root, "nope");
  const index = await degradedAsync()({ teamVaultDir: missing });
  let original: Error | undefined;
  try { createTeamVaultIndex({ teamVaultDir: missing }); } catch (error) { original = error as Error; }
  assert.throws(() => index.search("x"), (error: Error) => error.message === original!.message);
}));

test("a namespace swap between the build's two clean-tree reads is refused identically by both drivers", () => withRoot(async (root) => {
  for (const driver of ["sync", "async"] as const) {
    const caseRoot = mkdtempSync(path.join(root, `${driver}-`));
    const repo = vault(caseRoot, "repo");
    const other = path.join(caseRoot, "wt2");
    git(repo, "worktree", "add", "-q", "--detach", other, "HEAD"); // same commit, different checkout
    const alias = path.join(caseRoot, "alias"); symlinkSync(repo, alias);
    const bin = mkdtempSync(path.join(caseRoot, "bin-")), mark = path.join(caseRoot, "first-status-seen");
    // The second `status` (closing check) first retargets the alias to the other worktree.
    writeFileSync(path.join(bin, "git"), `#!/bin/sh\ncase " $* " in *" status "*) if [ -e '${mark}' ]; then /bin/ln -sfn '${other}' '${alias}'; else : > '${mark}'; fi ;; esac\nexec /usr/bin/git "$@"\n`, { mode: 0o700 });
    const saved = process.env.PATH; process.env.PATH = `${bin}:${saved ?? "/usr/bin:/bin"}`;
    try {
      const build = driver === "sync" ? Promise.resolve().then(() => createTeamVaultIndex({ teamVaultDir: alias })) : asyncBuild()({ teamVaultDir: alias });
      await assert.rejects(build, /namespace changed while its index was being built/);
    } finally { process.env.PATH = saved; }
  }
}));
