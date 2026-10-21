// The project names TeamMem has published, read from the Team Vault checkout
// at its committed revision. TeamMem renders each project as
// `Projects/<folder>/README.md` whose frontmatter `project:` line carries the
// exact name; the folder name is a filesystem-safe rewrite and is not used.
// Read-only: the only calls are `git ls-tree` and `git show`.

import { execFileSync } from "node:child_process";

const PROJECT_PAGE = /^Projects\/[^/]+\/README\.md$/u;

/** Sorted exact names, or null when the checkout or its revision cannot be read. */
export function readTeamVaultProjects(options: { readonly teamVaultDir: string }): string[] | null {
  const git = (...args: string[]) => execFileSync("git", ["-C", options.teamVaultDir, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  try {
    const revision = git("rev-parse", "--verify", "HEAD^{commit}").trim();
    const names = new Set<string>();
    for (const row of git("ls-tree", "-r", "-z", "--full-tree", revision, "--", "Projects").split("\0")) {
      const match = /^(\d+) blob [0-9a-f]+\t(.+)$/u.exec(row);
      if (match === null || match[1] === "120000" || !PROJECT_PAGE.test(match[2]!)) continue;
      const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(git("show", `${revision}:${match[2]!}`))?.[1] ?? "";
      const name = /^project: (.+)$/mu.exec(frontmatter)?.[1];
      if (name !== undefined) names.add(name);
    }
    return [...names].sort();
  } catch {
    return null;
  }
}
