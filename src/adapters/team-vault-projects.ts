// The project and area names TeamMem has published, read from the Team Vault
// checkout at its committed revision. TeamMem renders each project as
// `Projects/<folder>/README.md` with a frontmatter `project:` line, and each
// area as `Areas/<folder>/README.md` with an `area:` line; that line carries
// the exact name, plain or double-quoted, and the folder name is a
// filesystem-safe rewrite that is not used. A hidden label gets no page, so it
// never appears here. Read-only: the only calls are `git rev-parse`,
// `git ls-tree` and `git show`, run with Git's repository discovery stopped
// at the checkout itself so an enclosing repository is never read.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

const PAGE = /^(Projects\/[^/]+\/README\.md|Areas\/[^/]+\/README\.md)$/u;
/** Bound on the pages read; a larger vault yields no list rather than a partial one. */
export const MAX_TEAM_VAULT_PAGES = 1000;

/** TeamMem writes a meeting-only page's name as a double-quoted scalar escaping only `\` and `"`. */
const unquote = (value: string) => /^"(?:[^"\\]|\\["\\])*"$/u.test(value) ? value.slice(1, -1).replace(/\\(["\\])/gu, "$1") : value;

/** Sorted exact names, or null when the checkout or its revision cannot be read. */
export function readTeamVaultProjects(options: { readonly teamVaultDir: string }): string[] | null {
  try {
    const dir = realpathSync(options.teamVaultDir);
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL,
      LC_CTYPE: process.env.LC_CTYPE, GIT_CEILING_DIRECTORIES: path.dirname(dir) };
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args],
      { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
    const revision = git("rev-parse", "--verify", "HEAD^{commit}").trim();
    const pages: string[] = [];
    for (const row of git("ls-tree", "-r", "-z", "--full-tree", revision, "--", "Projects", "Areas").split("\0")) {
      const match = /^(\d+) blob [0-9a-f]+\t(.+)$/u.exec(row);
      if (match !== null && match[1] !== "120000" && PAGE.test(match[2]!)) pages.push(match[2]!);
    }
    if (pages.length > MAX_TEAM_VAULT_PAGES) return null;
    const names = new Set<string>();
    for (const page of pages) {
      const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(git("show", `${revision}:${page}`))?.[1] ?? "";
      const key = page.startsWith("Areas/") ? "area" : "project";
      const name = new RegExp(`^${key}: (.+)$`, "mu").exec(frontmatter)?.[1];
      if (name !== undefined) names.add(unquote(name));
    }
    return [...names].sort();
  } catch {
    return null;
  }
}
