// Cut D1: the built end-to-end spine. One documented command stages a private
// root, drives the SHIPPED admission and composition through `e2e/entry.mjs`
// with scripted Feishu peers (D028), hands the strict artifact bundle to a
// wheel-installed TeamMem, and writes an evidence bundle. This suite runs that
// same command as a child and asserts the bundle's oracles; it never re-derives
// a result the harness did not record.
//
// Every claim here is "scripted local application test readiness": no Feishu
// tenant, provider, acoustic, Linux or remote-split acceptance follows from it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const NODE24 = "/opt/homebrew/opt/node@24/bin/node";
const REPO = path.resolve(import.meta.dirname, "..");
const RUN = path.join(REPO, "e2e/run.mjs");

type Bundle = {
  readonly label: string;
  readonly command: readonly string[];
  readonly sourceTreeId: string;
  readonly runtimePins: Readonly<Record<string, { readonly path: string; readonly sha256: string }>>;
  readonly oracles: readonly { readonly name: string; readonly status: "pass" | "fail" | "blocked" | "skipped"; readonly detail: string }[];
  readonly steps: readonly { readonly name: string; readonly exit: number | null; readonly durationMs: number; readonly loadAverage: readonly number[] }[];
  readonly productDefects: readonly { readonly id: string; readonly where: string; readonly measured: string; readonly observed: string }[];
};

function readBundle(directory: string): Bundle {
  return JSON.parse(readFileSync(path.join(directory, "bundle.json"), "utf8")) as Bundle;
}

function runSpine(extra: readonly string[] = []): { status: number | null; stdout: string; stderr: string; out: string } {
  const out = mkdtempSync(path.join(tmpdir(), "meeting-e2e-bundle-"));
  const result = spawnSync(NODE24, [RUN, "--out", out, ...extra], {
    cwd: REPO, encoding: "utf8", timeout: 900_000,
    env: { ...process.env, PATH: `/opt/homebrew/opt/node@24/bin:${process.env.PATH ?? ""}` },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", out };
}

test("the documented one command exists and is runnable", () => {
  assert.equal(existsSync(RUN), true, "e2e/run.mjs is the documented command");
  const manifest = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  assert.equal(manifest.scripts?.e2e, "node e2e/run.mjs", "package.json exposes the same command as `npm run e2e`");
});

test("one full run drives the shipped spine and records every oracle", { timeout: 900_000 }, () => {
  const run = runSpine();
  try {
    assert.equal(run.status, 0, `spine run failed\n${run.stdout}\n${run.stderr}`);
    const bundle = readBundle(run.out);
    assert.equal(bundle.label, "scripted local application test readiness");
    assert.match(bundle.sourceTreeId, /^[0-9a-f]{40}$/);
    assert.equal(bundle.runtimePins.gateway?.sha256.length, 64);
    assert.equal(bundle.runtimePins.sdkTarball?.sha256.length, 64);
    const failed = bundle.oracles.filter((oracle) => oracle.status === "fail");
    assert.deepEqual(failed, [], `failing oracles: ${JSON.stringify(failed, null, 2)}`);
    for (const required of ["admission", "invite_durable", "runtime_connected", "custody_claimed", "child_launched",
      "media_connected", "capture_recorded", "meeting_ended", "finalized_seed", "artifact_bundle",
      "teammem_dry_run", "shutdown_clean", "no_orphan_process", "no_key_or_plaintext_audio", "no_closed_store_callback",
      "single_occurrence_identity"]) {
      const oracle = bundle.oracles.find((entry) => entry.name === required);
      assert.ok(oracle, `bundle records the ${required} oracle`);
      assert.equal(oracle.status, "pass", `${required}: ${oracle.detail}`);
    }
    assert.ok(existsSync(path.join(run.out, "NEGATIVE-PROOFS.md")));
    assert.ok(bundle.steps.every((step) => step.loadAverage.length === 3), "every timing records the load average");

    // D031 fixed the artifact blockers. Any regression must fail this gate.
    const artifact = bundle.oracles.find((entry) => entry.name === "artifact_bundle");
    const downstream = ["teammem_publish", "publication_receipt", "organizer_dm"] as const;
    assert.equal(artifact?.status, "pass");
    assert.deepEqual(bundle.productDefects, [], "a built artifact leaves no blocking defect recorded");
    // This run does not set E2E_ALLOW_LOCAL_BARE_PUSH, so the publication
    // lane stops after the dry run and says so. The publishing run is the
    // separate proof root drives with that switch; its own oracles are in
    // the bundle it writes.
    for (const name of downstream) {
      assert.equal(bundle.oracles.find((entry) => entry.name === name)?.status, "skipped", name);
    }
  } finally {
    rmSync(run.out, { recursive: true, force: true });
  }
});

test("the unmodified built main refuses a bad invocation, an unsafe reference and a held lock without spawning or reaching the network", { timeout: 300_000 }, () => {
  const run = runSpine(["--only-refusals"]);
  try {
    assert.equal(run.status, 0, `refusal run failed\n${run.stdout}\n${run.stderr}`);
    const bundle = readBundle(run.out);
    for (const [name, exit] of [["refusal_grammar", 64], ["refusal_reference", 65], ["refusal_lock_held", 75]] as const) {
      const oracle = bundle.oracles.find((entry) => entry.name === name);
      assert.ok(oracle, `${name} recorded`);
      assert.equal(oracle.status, "pass", `${name}: ${oracle.detail}`);
      assert.match(oracle.detail, new RegExp(`exit ${exit}\\b`));
    }
    const spawned = bundle.oracles.find((entry) => entry.name === "refusals_spawned_nothing");
    assert.equal(spawned?.status, "pass", spawned?.detail);
  } finally {
    rmSync(run.out, { recursive: true, force: true });
  }
});
