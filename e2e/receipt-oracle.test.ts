import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// @ts-expect-error Test-only JavaScript TeamMem module has no public declaration.
import { publicationReceiptPasses, receiptOracle } from "./teammem.mjs";

const ENV = { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.invalid",
  GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.invalid", GIT_AUTHOR_DATE: "2026-10-22T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-22T00:00:00Z" };
const OCCURRENCE = "feishu:synthetic-receipt@2026-10-22T09:00:00Z";
const SEGMENT = "feishu_synthetic-receipt_0123456789abcdef";
const MARKDOWN = "Meetings/2026-W43/receipt.md";
const HASH = `sha256:${"c".repeat(64)}`;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("/usr/bin/git", ["-C", cwd, ...args], { env: ENV, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** A bare remote whose `refs/heads/e2e` holds two commits of one note, as a
 * second TeamMem publication would leave it. */
function vault(t: { after: (cleanup: () => void) => void }) {
  const root = mkdtempSync(path.join(tmpdir(), "receipt-oracle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bare = path.join(root, "remote.git"), work = path.join(root, "work"), receiptsDir = path.join(root, "receipts");
  mkdirSync(receiptsDir);
  spawnSync("/usr/bin/git", ["init", "-q", "--bare", bare], { env: ENV });
  spawnSync("/usr/bin/git", ["init", "-q", "-b", "e2e", work], { env: ENV });
  const commits: string[] = [];
  for (const revision of [1, 2]) {
    mkdirSync(path.join(work, path.dirname(MARKDOWN)), { recursive: true });
    writeFileSync(path.join(work, MARKDOWN), `# Receipt ${revision}\n\n${OCCURRENCE}\n`);
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", `revision ${revision}`);
    commits.push(git(work, "rev-parse", "HEAD"));
  }
  git(work, "push", "-q", bare, "e2e:refs/heads/e2e");
  return { teammem: { paths: { bare }, env: ENV }, receiptsDir, commits };
}

function receiptBytes(revision: number, commit: string, overrides: Record<string, unknown> = {}): string {
  const receipt: Record<string, unknown> = { artifact_hash: HASH, markdown_path: MARKDOWN,
    markdown_url: `https://example.invalid/group/vault/-/blob/${commit}/${MARKDOWN}`, occurrence_id: OCCURRENCE,
    revision, schema: "teammem-meeting-receipt/v1", status: "published", vault_commit: commit, ...overrides };
  return `${JSON.stringify(receipt)}\n`;
}

/** Writes TeamMem's layout: `<segment>/<revision>.json` then the latest `<segment>.json`. */
function publish(receiptsDir: string, revision: number, commit: string): void {
  mkdirSync(path.join(receiptsDir, SEGMENT), { recursive: true });
  writeFileSync(path.join(receiptsDir, SEGMENT, `${revision}.json`), receiptBytes(revision, commit));
  writeFileSync(path.join(receiptsDir, `${SEGMENT}.json`), receiptBytes(revision, commit));
}

const artifact = (revision: number) => ({ occurrenceId: OCCURRENCE, revision, hash: HASH, audioPath: "/never/audio.enc" });

test("a latest receipt with its byte-equal per-revision twin is one passing publication", (t) => {
  const v = vault(t);
  publish(v.receiptsDir, 1, v.commits[0]!);
  const result = receiptOracle({ teammem: v.teammem, receiptsDir: v.receiptsDir, artifact: artifact(1) });
  assert.equal(result.status, "present");
  assert.deepEqual(result.receipts, [path.join(v.receiptsDir, `${SEGMENT}.json`)]);
  assert.deepEqual(result.checks.map((row: { receipt: string; revisionTwin: string }) => [row.receipt, row.revisionTwin]), [[`${SEGMENT}.json`, "byte-equal"]]);
  assert.equal(publicationReceiptPasses(result.checks), true);
});

test("a second revision overwrites the latest and keeps both per-revision twins; only the latest is checked", (t) => {
  const v = vault(t);
  publish(v.receiptsDir, 1, v.commits[0]!);
  publish(v.receiptsDir, 2, v.commits[1]!);
  const result = receiptOracle({ teammem: v.teammem, receiptsDir: v.receiptsDir, artifact: artifact(2) });
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0].markdownUrl.includes(v.commits[1]!), true);
  assert.equal(result.checks[0].revisionTwin, "byte-equal");
  assert.equal(publicationReceiptPasses(result.checks), true);
  assert.equal(publicationReceiptPasses(receiptOracle({ teammem: v.teammem, receiptsDir: v.receiptsDir, artifact: artifact(1) }).checks), false);
});

test("a content-equal twin with different key order passes; a latest without a twin still passes", (t) => {
  const v = vault(t);
  publish(v.receiptsDir, 1, v.commits[0]!);
  const reordered = Object.fromEntries(Object.entries(JSON.parse(receiptBytes(1, v.commits[0]!))).reverse());
  writeFileSync(path.join(v.receiptsDir, SEGMENT, "1.json"), JSON.stringify(reordered, null, 2));
  let result = receiptOracle({ teammem: v.teammem, receiptsDir: v.receiptsDir, artifact: artifact(1) });
  assert.equal(result.checks[0].revisionTwin, "content-equal");
  assert.equal(publicationReceiptPasses(result.checks), true);
  rmSync(path.join(v.receiptsDir, SEGMENT), { recursive: true });
  result = receiptOracle({ teammem: v.teammem, receiptsDir: v.receiptsDir, artifact: artifact(1) });
  assert.equal(result.checks[0].revisionTwin, "absent");
  assert.equal(publicationReceiptPasses(result.checks), true);
});

test("a per-revision twin that disagrees with the latest fails", (t) => {
  for (const twin of [
    (v: ReturnType<typeof vault>) => receiptBytes(1, v.commits[1]!),
    () => receiptBytes(1, "0".repeat(40)),
    () => "{not json",
    (v: ReturnType<typeof vault>) => receiptBytes(1, v.commits[0]!, { artifact_hash: `sha256:${"d".repeat(64)}` }),
  ]) {
    const v = vault(t);
    publish(v.receiptsDir, 1, v.commits[0]!);
    writeFileSync(path.join(v.receiptsDir, SEGMENT, "1.json"), twin(v));
    const result = receiptOracle({ teammem: v.teammem, receiptsDir: v.receiptsDir, artifact: artifact(1) });
    assert.equal(result.checks[0].revisionTwin, "differs");
    assert.equal(publicationReceiptPasses(result.checks), false);
  }
});

test("an older per-revision twin must name its own revision, the same occurrence and an earlier revision", (t) => {
  for (const [name, bytes] of [["1.json", (c: string) => receiptBytes(3, c)], ["3.json", (c: string) => receiptBytes(3, c)],
    ["1.json", (c: string) => receiptBytes(1, c, { occurrence_id: "feishu:other@2026-10-22T09:00:00Z" })]] as const) {
    const v = vault(t);
    publish(v.receiptsDir, 2, v.commits[1]!);
    writeFileSync(path.join(v.receiptsDir, SEGMENT, name), bytes(v.commits[0]!));
    assert.equal(publicationReceiptPasses(receiptOracle({ teammem: v.teammem, receiptsDir: v.receiptsDir, artifact: artifact(2) }).checks), false, name);
  }
});

test("two different top-level receipts still fail, even when each passes every content check", (t) => {
  const v = vault(t);
  publish(v.receiptsDir, 1, v.commits[0]!);
  writeFileSync(path.join(v.receiptsDir, "feishu_other-receipt_fedcba9876543210.json"), receiptBytes(1, v.commits[1]!));
  const result = receiptOracle({ teammem: v.teammem, receiptsDir: v.receiptsDir, artifact: artifact(1) });
  assert.equal(result.checks.length, 2);
  assert.equal(result.checks.every((row: Record<string, unknown>) => row.commitExists && row.commitIsAncestorOfRef && row.artifactHashMatches), true);
  assert.equal(publicationReceiptPasses(result.checks), false);
});

test("a foreign nested receipt or a refusal record is never folded into the latest", (t) => {
  for (const relative of [[SEGMENT, "1.refused.json"], ["nested", `${SEGMENT}.json`], [SEGMENT, "latest.json"], ["orphan_0000000000000000", "1.json"]]) {
    const v = vault(t);
    publish(v.receiptsDir, 1, v.commits[0]!);
    mkdirSync(path.join(v.receiptsDir, relative[0]!), { recursive: true });
    writeFileSync(path.join(v.receiptsDir, ...relative), receiptBytes(1, v.commits[0]!));
    const result = receiptOracle({ teammem: v.teammem, receiptsDir: v.receiptsDir, artifact: artifact(1) });
    assert.equal(result.checks.length, 2, relative.join("/"));
    assert.equal(publicationReceiptPasses(result.checks), false, relative.join("/"));
  }
});

test("every content check still gates the latest receipt", (t) => {
  for (const [label, mutate] of [
    ["unknown commit", () => receiptBytes(1, "0".repeat(40))],
    ["note missing at the commit", (c: string[]) => receiptBytes(1, c[0]!, { markdown_path: "Meetings/missing.md" })],
    ["revision", (c: string[]) => receiptBytes(2, c[0]!)],
    ["occurrence", (c: string[]) => receiptBytes(1, c[0]!, { occurrence_id: "feishu:other@2026-10-22T09:00:00Z" })],
    ["hash", (c: string[]) => receiptBytes(1, c[0]!, { artifact_hash: `sha256:${"d".repeat(64)}` })],
    ["url", (c: string[]) => receiptBytes(1, c[0]!, { markdown_url: "https://example.invalid/group/vault/-/blob/main/x.md" })],
  ] as const) {
    const v = vault(t);
    writeFileSync(path.join(v.receiptsDir, `${SEGMENT}.json`), mutate(v.commits));
    assert.equal(publicationReceiptPasses(receiptOracle({ teammem: v.teammem, receiptsDir: v.receiptsDir, artifact: artifact(1) }).checks), false, label);
  }
});
