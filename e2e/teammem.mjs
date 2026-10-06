// The real TeamMem consumer for the built end-to-end spine, staged exactly as
// `real-teammem-e2e-launch-preflight.md` specifies: a wheel built from the
// accepted staged tree and installed into a private venv, a 0600 env file with
// that preflight's exact keys, an isolated vault checkout and a temporary BARE
// remote created under this run's own temp root.
//
// Push scope: the user authorised a `git push` into a bare repository this
// harness created under its own temp root and nothing else (2026-09-22, "sure
// you can test locally"). The publishing run happens only when the caller also
// passes `E2E_ALLOW_LOCAL_BARE_PUSH=1`; without it the harness stops after the
// dry run and the bundle says so. `~/.local/share/teammem`, `~/.config/teammem`
// and the overlay are never read or written.

import { Buffer } from "node:buffer";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { PYTHON, run, loadAverage } from "./stage.mjs";
import { sha256File } from "./pins.mjs";
import { snapshotDependencyWheelhouse, teamMemDependencyOptions, validateDependencyWheelhouse } from "./python-wheelhouse.mjs";

/** The argv prefix every Git and TeamMem invocation shares: no ambient GIT_*,
 * credential helper, template, hook or HOME survives it. */
export function safeEnvironment({ templateDir, binPath }) {
  return {
    PATH: binPath, LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TEMPLATE_DIR: templateDir,
  };
}

export function archiveTeamMemSource({ repository, tree, sourceDir, archivePath }) {
  if (typeof tree !== "string" || !/^[0-9a-f]{40}$/.test(tree)) throw new Error("TeamMem source tree must be a 40-character hex object ID");
  const env = safeEnvironment({ templateDir: "", binPath: "/usr/bin:/bin:/usr/sbin:/sbin" });
  const archive = { name: "teammem_archive", ...run("/usr/bin/git", ["-C", repository, "archive", "--format=tar", "--output", archivePath, tree], { env }) };
  if (archive.exit !== 0) return [archive];
  return [archive, { name: "teammem_archive_extract", ...run("/usr/bin/tar", ["-xf", archivePath, "-C", sourceDir], { env }) }];
}

export async function stageTeamMem({ staged, source, dependencyWheelhouse }) {
  if (dependencyWheelhouse !== undefined) await validateDependencyWheelhouse(dependencyWheelhouse);
  const steps = [];
  const record = (name, result) => { steps.push({ name, ...result }); if (result.exit !== 0) throw new Error(`${name} failed (exit ${result.exit}): ${result.stderr.slice(0, 600)}`); return result; };

  const teammemRoot = staged.directories.teammem;
  const sourceDir = path.join(teammemRoot, "src");
  const venv = path.join(teammemRoot, "wheel-venv");
  const wheelhouse = path.join(teammemRoot, "wheelhouse");
  for (const directory of [sourceDir, wheelhouse]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dependencies = dependencyWheelhouse === undefined ? undefined : await snapshotDependencyWheelhouse({ dependencyWheelhouse, privateRoot: teammemRoot });

  for (const { name, ...result } of archiveTeamMemSource({ repository: source.repository, tree: source.tree, sourceDir, archivePath: path.join(teammemRoot, "source.tar") })) record(name, result);
  record("teammem_venv", run(PYTHON, ["-m", "venv", venv]));
  // Optional validated private dependencies avoid network; default behavior is unchanged.
  const dependencyOptions = await teamMemDependencyOptions(dependencies?.path);
  record("teammem_wheel_build", run(path.join(venv, "bin/pip"), ["wheel", ...dependencyOptions.argv, "--no-deps", "--wheel-dir", wheelhouse, sourceDir], dependencyOptions.options));
  const wheel = readdirSync(wheelhouse).filter((name) => name.endsWith(".whl")).map((name) => path.join(wheelhouse, name))[0];
  if (wheel === undefined) throw new Error("no TeamMem wheel was produced");
  const wheelSha256 = await sha256File(wheel);
  const installDependencyOptions = await teamMemDependencyOptions(dependencies?.path);
  record("teammem_wheel_install", run(path.join(venv, "bin/pip"), ["install", ...installDependencyOptions.argv, wheel], installDependencyOptions.options));

  const binary = path.join(venv, "bin/teammem");
  if (!existsSync(binary)) throw new Error("the installed TeamMem wheel exposes no teammem entry point");

  // Accepted fixture identity config, staged read-only beneath this root.
  const identityDir = path.join(staged.directories.configDir, "identity");
  mkdirSync(identityDir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(path.join(sourceDir, "tests/fixtures/config"))) {
    const bytes = readFileSync(path.join(sourceDir, "tests/fixtures/config", name));
    writeFileSync(path.join(identityDir, name.replace(".example", "")), bytes, { mode: 0o600 });
  }

  const paths = {
    db: path.join(teammemRoot, "ledger.db"),
    configDir: identityDir,
    vault: path.join(teammemRoot, "vault"),
    bare: path.join(teammemRoot, "vault-remote.git"),
    inbox: staged.directories.outboxDir,
    receipts: staged.directories.receiptsDir,
    archive: path.join(teammemRoot, "meeting-archive"),
    quarantine: path.join(teammemRoot, "meeting-quarantine"),
    audioStore: path.join(teammemRoot, "meeting-audio"),
    alerts: path.join(teammemRoot, "meeting-alerts"),
    template: path.join(teammemRoot, "empty-git-template"),
    envFile: path.join(staged.directories.configDir, "hub.env"),
  };
  for (const directory of [paths.vault, paths.archive, paths.quarantine, paths.audioStore, paths.alerts, paths.template]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }

  writeFileSync(paths.envFile, [
    `TEAMMEM_DB=${paths.db}`,
    `TEAMMEM_CONFIG_DIR=${paths.configDir}`,
    `TEAMMEM_VAULT=${paths.vault}`,
    `TEAMMEM_MEETING_INBOX=${paths.inbox}`,
    `TEAMMEM_MEETING_ARCHIVE=${paths.archive}`,
    `TEAMMEM_MEETING_QUARANTINE=${paths.quarantine}`,
    `TEAMMEM_MEETING_AUDIO_STORE=${paths.audioStore}`,
    `TEAMMEM_MEETING_RECEIPTS=${paths.receipts}`,
    `TEAMMEM_MEETING_ALERTS=${paths.alerts}`,
    "TEAMMEM_MEETING_WARN_DAYS=3",
    "TEAMMEM_VAULT_WEB_BASE=https://e2e.invalid/team-vault",
    "TEAMMEM_VAULT_REMOTE=origin",
    "TEAMMEM_VAULT_REF=refs/heads/e2e",
    "",
  ].join("\n"), { mode: 0o600 });
  chmodSync(paths.envFile, 0o600);

  const binPath = `${path.join(venv, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`;
  const env = safeEnvironment({ templateDir: paths.template, binPath });
  const git = (argv, name) => record(name, run("/usr/bin/git", argv, { env }));
  git(["init", "--bare", "-q", paths.bare], "git_init_bare");
  git(["-C", paths.vault, "init", "-q"], "git_init_vault");
  git(["-C", paths.vault, "symbolic-ref", "HEAD", "refs/heads/e2e"], "git_head");
  git(["-C", paths.vault, "config", "user.name", "teammem-e2e"], "git_user_name");
  git(["-C", paths.vault, "config", "user.email", "teammem-e2e@local.invalid"], "git_user_email");
  git(["-C", paths.vault, "remote", "add", "origin", paths.bare], "git_remote");
  git(["-C", paths.vault, "config", "branch.e2e.remote", "origin"], "git_branch_remote");
  git(["-C", paths.vault, "config", "branch.e2e.merge", "refs/heads/e2e"], "git_branch_merge");
  git(["-C", paths.vault, "commit", "--allow-empty", "-q", "-m", "isolated E2E seed"], "git_seed_commit");
  git(["-C", paths.vault, "push", "-q", "origin", "e2e:refs/heads/e2e"], "git_seed_push");

  return { binary, wheel, wheelSha256, paths, env, binPath, steps, venv, sourceDir };
}

/** `process-meetings`, dry run first, then the publishing run when allowed. */
export function publish({ teammem, nowIso, allowPush, withheldReason }) {
  const invoke = (argv) => run(teammem.binary, ["--env-file", teammem.paths.envFile, ...argv], { env: teammem.env });
  const dryRun = invoke(["process-meetings", "--now", nowIso, "--dry-run"]);
  if (!allowPush) return { dryRun, publishRun: null, skipped: withheldReason };
  const publishRun = invoke(["process-meetings", "--now", nowIso]);
  return { dryRun, publishRun, skipped: null };
}

/** The independent remote oracle: the receipt's commit must exist in the bare
 * repository, be an ancestor of the published ref, and its named path must
 * hold note bytes that agree with the artifact. `cat-file -e` alone is not
 * enough, so the bytes themselves are inspected. */
export function receiptOracle({ teammem, receiptsDir, artifact }) {
  const receipts = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.name.endsWith(".json")) receipts.push(target);
    }
  };
  if (existsSync(receiptsDir)) walk(receiptsDir);
  if (receipts.length === 0) return { receipts: [], checks: [], status: "absent" };

  const checks = [];
  const parsed = receipts.map((filename) => ({ filename, value: JSON.parse(readFileSync(filename, "utf8")) }));
  for (const receipt of parsed) {
    const commit = receipt.value.vault_commit;
    const markdownPath = receipt.value.markdown_path;
    const exists = run("/usr/bin/git", ["-C", teammem.paths.bare, "cat-file", "-e", `${commit}^{commit}`], { env: teammem.env });
    const ancestor = run("/usr/bin/git", ["-C", teammem.paths.bare, "merge-base", "--is-ancestor", commit, "refs/heads/e2e"], { env: teammem.env });
    const show = run("/usr/bin/git", ["-C", teammem.paths.bare, "show", `${commit}:${markdownPath}`], { env: teammem.env });
    const note = show.stdout;
    checks.push({
      receipt: path.basename(receipt.filename),
      schema: receipt.value.schema,
      markdownUrl: receipt.value.markdown_url,
      commitExists: exists.exit === 0,
      commitIsAncestorOfRef: ancestor.exit === 0,
      noteBytes: Buffer.byteLength(note),
      occurrenceMatchesArtifact: artifact === null || receipt.value.occurrence_id === artifact.occurrenceId,
      revisionMatchesArtifact: artifact === null || Number(receipt.value.revision) === artifact.revision,
      artifactHashMatches: artifact === null || receipt.value.artifact_hash === artifact.hash,
      noteNamesOccurrence: artifact === null || note.includes(artifact.occurrenceId),
      noteWithholdsAudioPath: artifact === null || !note.includes(artifact.audioPath ?? "\u0000never"),
      urlNamesCommit: typeof receipt.value.markdown_url === "string" && receipt.value.markdown_url.includes(commit),
      loadAverage: loadAverage(),
    });
  }
  return { receipts, checks, status: "present" };
}
