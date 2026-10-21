import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { MAX_TEAM_VAULT_PAGES, readTeamVaultProjects } from "../src/adapters/team-vault-projects.ts";
import { resolveProjects, synthesisProjectVocabulary } from "../src/delivery/project-resolution.ts";

test("proposed names differing only by case or whitespace resolve to the exact published name and merge", () => {
  const resolved = resolveProjects([
    { name: "  project   ATLAS ", evidence_segment_ids: ["seg_002", "seg_001"] },
    { name: "Project Atlas", evidence_segment_ids: ["seg_001", "seg_003"] },
    { name: "orbit", evidence_segment_ids: ["seg_004"] },
  ], ["Project Atlas", "Orbit"]);
  assert.deepEqual(resolved.projects, [
    { name: "Project Atlas", evidence_segment_ids: ["seg_002", "seg_001", "seg_003"] },
    { name: "Orbit", evidence_segment_ids: ["seg_004"] },
  ]);
  assert.deepEqual(resolved.warnings, []);
});

test("unknown and ambiguous names are flagged once each and never published", () => {
  const resolved = resolveProjects([
    { name: "Nebula", evidence_segment_ids: ["seg_001"] },
    { name: " nebula ", evidence_segment_ids: ["seg_002"] },
    { name: "foo bar", evidence_segment_ids: ["seg_003"] },
    { name: "Atlas", evidence_segment_ids: ["seg_004"] },
  ], ["Foo Bar", "foo  bar", "Atlas"]);
  assert.deepEqual(resolved.projects, [{ name: "Atlas", evidence_segment_ids: ["seg_004"] }]);
  assert.deepEqual(resolved.warnings, [
    { code: "project_unassigned", detail: "Nebula" },
    { code: "project_unassigned", detail: "foo bar" },
  ]);
});

test("merged evidence stays inside the artifact's per-item bound", () => {
  const ids = (prefix: string) => Array.from({ length: 100 }, (_, index) => `${prefix}_${index}`);
  const resolved = resolveProjects([{ name: "atlas", evidence_segment_ids: ids("a") }, { name: "ATLAS", evidence_segment_ids: ids("b") }], ["Atlas"]);
  assert.equal(resolved.projects[0]?.evidence_segment_ids.length, 100);
});

test("many unknown names collapse into a bounded set of warnings that fits the room left", () => {
  const proposed = Array.from({ length: 600 }, (_, index) => ({ name: `Unknown ${index}`, evidence_segment_ids: ["seg_001"] }));
  const open = resolveProjects(proposed, ["Atlas"]);
  assert.equal(open.warnings.length, 21);
  assert.deepEqual(open.warnings.slice(0, 2), [{ code: "project_unassigned", detail: "Unknown 0" }, { code: "project_unassigned", detail: "Unknown 1" }]);
  assert.deepEqual(open.warnings.at(-1), { code: "project_unassigned_more", detail: "580 further proposed projects are not in the published project list." });
  const tight = resolveProjects(proposed, null, 3);
  assert.deepEqual(tight.warnings.map(({ code }) => code), ["project_index_unavailable", "project_unassigned", "project_unassigned_more"]);
  assert.deepEqual(resolveProjects(proposed, ["Atlas"], 0).warnings, []);
  assert.equal(resolveProjects(proposed.slice(0, 20), ["Atlas"]).warnings.length, 20, "up to twenty names are each flagged");
});

test("without a readable project list every proposed project is unassigned and the gap is stated", () => {
  const resolved = resolveProjects([{ name: "Atlas", evidence_segment_ids: ["seg_001"] }], null);
  assert.deepEqual(resolved.projects, []);
  assert.deepEqual(resolved.warnings, [{ code: "project_index_unavailable", detail: "The published project list could not be read." },
    { code: "project_unassigned", detail: "Atlas" }]);
});

function git(dir: string, ...args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
}

test("the published project list is the exact names TeamMem rendered as project pages at the committed revision", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-vault-projects-"));
  try {
    const page = (folder: string, frontmatter: string) => {
      mkdirSync(path.join(dir, "Projects", folder), { recursive: true });
      writeFileSync(path.join(dir, "Projects", folder, "README.md"), `---\n${frontmatter}---\n# heading\n`);
    };
    git(dir, "init", "-q");
    // TeamMem's activity project page, its meeting-only page and a name its
    // filename rule rewrote: the frontmatter keeps the exact name.
    page("Project Atlas", "project: Project Atlas\ngenerated: 2026-10-20\n");
    page("Orbit", "project: Orbit\ngenerated: 2026-10-20\n");
    page("Q3- Roadmap", "project: Q3: Roadmap\ngenerated: 2026-10-20\n");
    writeFileSync(path.join(dir, "Projects", "README.md"), "---\ngenerated: 2026-10-20\n---\n# Projects\n");
    writeFileSync(path.join(dir, "Projects", "Orbit", "2026-W40.md"), "---\nproject: Orbit Week\n---\n");
    mkdirSync(path.join(dir, "Projects", "Orbit", "notes"));
    writeFileSync(path.join(dir, "Projects", "Orbit", "notes", "README.md"), "---\nproject: Nested Page\n---\n");
    mkdirSync(path.join(dir, "People", "Ada"), { recursive: true });
    writeFileSync(path.join(dir, "People", "Ada", "README.md"), "---\nproject: Not A Project\n---\n");
    git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "render");
    page("Draft", "project: Draft\n");
    assert.deepEqual(readTeamVaultProjects({ teamVaultDir: dir }), ["Orbit", "Project Atlas", "Q3: Roadmap"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("published area names join the list, hidden labels stay out, and a proposed area resolves to its exact name", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-vault-areas-"));
  try {
    const page = (root: string, folder: string, frontmatter: string) => {
      mkdirSync(path.join(dir, root, folder), { recursive: true });
      writeFileSync(path.join(dir, root, folder, "README.md"), `---\n${frontmatter}---\n# heading\n`);
    };
    git(dir, "init", "-q");
    // TeamMem's layout: projects under Projects/ keyed `project:`, areas under
    // Areas/ keyed `area:`; an area known only from meetings gets a quoted name.
    // A hidden label gets no page and appears only as plain text elsewhere.
    page("Projects", "Project Atlas", "project: Project Atlas\ngenerated: 2026-10-20\n");
    page("Areas", "Customer Support", "area: Customer Support\ngenerated: 2026-10-20\n");
    page("Areas", "Q4- Hiring", "area: Q4: Hiring\ngenerated: 2026-10-20\n");
    page("Areas", "Night Desk", 'area: "Ops \\"Night\\" Desk"\ngenerated: 2026-10-20\n');
    writeFileSync(path.join(dir, "Areas", "README.md"), "---\ngenerated: 2026-10-20\n---\n# Areas\n");
    writeFileSync(path.join(dir, "Areas", "Customer Support", "2026-W40.md"), "---\narea: Support Week\n---\n");
    page("Areas", "Mislabelled", "project: Not An Area\n");
    mkdirSync(path.join(dir, "Work Journal"), { recursive: true });
    writeFileSync(path.join(dir, "Work Journal", "2026-W40.md"), "---\ngenerated: 2026-10-20\n---\n- IdeaProjects: 3 events\n");
    // A committed symlink's blob is its target text, which can itself look like a page.
    mkdirSync(path.join(dir, "Areas", "Linked"));
    symlinkSync("---\narea: Linked Area\n---\n", path.join(dir, "Areas", "Linked", "README.md"));
    git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "render");
    page("Areas", "Draft Area", "area: Draft Area\n");
    const known = readTeamVaultProjects({ teamVaultDir: dir });
    assert.deepEqual(known, ["Customer Support", "Ops \"Night\" Desk", "Project Atlas", "Q4: Hiring"]);
    assert.deepEqual(synthesisProjectVocabulary(known), known);
    const resolved = resolveProjects([
      { name: " customer   SUPPORT", evidence_segment_ids: ["seg_001"] },
      { name: "q4: hiring", evidence_segment_ids: ["seg_002"] },
      { name: "IdeaProjects", evidence_segment_ids: ["seg_003"] },
    ], known);
    assert.deepEqual(resolved.projects, [
      { name: "Customer Support", evidence_segment_ids: ["seg_001"] },
      { name: "Q4: Hiring", evidence_segment_ids: ["seg_002"] },
    ]);
    assert.deepEqual(resolved.warnings, [{ code: "project_unassigned", detail: "IdeaProjects" }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the published names together stay under the 500-name synthesis cap", () => {
  const names = Array.from({ length: 600 }, (_, index) => `Name ${String(index).padStart(3, "0")}`);
  assert.equal(synthesisProjectVocabulary(names).length, 500);
});

test("a directory that is not itself the Team Vault checkout is not read through an enclosing repository", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-vault-enclosing-"));
  try {
    git(dir, "init", "-q");
    mkdirSync(path.join(dir, "vault", "Areas", "Ops"), { recursive: true });
    writeFileSync(path.join(dir, "vault", "Areas", "Ops", "README.md"), "---\narea: Ops\n---\n");
    mkdirSync(path.join(dir, "Projects", "Outer"), { recursive: true });
    writeFileSync(path.join(dir, "Projects", "Outer", "README.md"), "---\nproject: Outer\n---\n");
    git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "outer");
    assert.equal(readTeamVaultProjects({ teamVaultDir: path.join(dir, "vault") }), null);
    assert.deepEqual(readTeamVaultProjects({ teamVaultDir: dir }), ["Outer"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a vault with more project and area pages than the read bound yields no list instead of a partial one", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-vault-bound-"));
  try {
    git(dir, "init", "-q");
    for (let index = 0; index <= MAX_TEAM_VAULT_PAGES; index += 1) {
      const root = index % 2 === 0 ? "Projects" : "Areas";
      mkdirSync(path.join(dir, root, `P${index}`), { recursive: true });
      writeFileSync(path.join(dir, root, `P${index}`, "README.md"), "---\nproject: x\n---\n");
    }
    git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "many");
    assert.equal(readTeamVaultProjects({ teamVaultDir: dir }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a missing or non-Git Team Vault yields no project list rather than an error", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-vault-projects-"));
  try {
    assert.equal(readTeamVaultProjects({ teamVaultDir: dir }), null);
    assert.equal(readTeamVaultProjects({ teamVaultDir: path.join(dir, "absent") }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
