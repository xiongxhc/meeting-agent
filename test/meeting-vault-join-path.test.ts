// Benchmark-backed regression: the Team Vault index build (several synchronous
// git calls) must not sit on the join critical path. With git slowed to 100 ms
// per call, the bridge `join` must still go out promptly, and a vault question
// asked afterwards must still be answered from that same, fully checked index.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { buildMeetingIdentity } from "../src/domain/meeting.ts";
import { createCoordinator } from "../src/sessions/coordinator.ts";
import { createMeetingSession } from "../src/sessions/meeting-session.ts";
import { fakeBridge, fakeClock, fakeRuntime } from "./lib/session-fakes.ts";

const BASE_MS = 1_756_800_000_000;
const IDENTITY = buildMeetingIdentity({ providerMeetingId: "synthetic-vault-join", meetingNo: "000000000", occurrenceStartedAt: "2026-09-02T14:00:00Z", title: "Synthetic", organizer: null });
const GIT_DELAY_S = 0.1;
const FIXTURE_ENV: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));

function transcript(segmentId: string, text: string) {
  return { type: "transcript_final" as const, segment: { segmentId, text, final: true, startedAt: "2026-09-02T14:05:00Z", endedAt: "2026-09-02T14:05:04Z" } };
}

test("the Team Vault build is off the join critical path and still grounds a later vault answer", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meeting-vault-join-"));
  const vault = path.join(root, "vault"); mkdirSync(vault);
  const git = (...args: string[]) => execFileSync("/usr/bin/git", args, { cwd: vault, env: FIXTURE_ENV });
  git("init", "-q"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  writeFileSync(path.join(vault, "orion.md"), "Orion launch code is violet.\n"); git("add", "-A"); git("commit", "-q", "-m", "fixture");
  const bin = path.join(root, "bin"); mkdirSync(bin);
  writeFileSync(path.join(bin, "git"), `#!/bin/sh\nsleep ${GIT_DELAY_S}\nexec /usr/bin/git "$@"\n`, { mode: 0o700 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? "/usr/bin:/bin"}`;
  const store = openSessionStore({ filename: path.join(root, "orchestration.db"), nowMs: BASE_MS });
  const clock = fakeClock(BASE_MS);
  const coordinator = createCoordinator({ store, clock, bridgeLeaseTtlMs: 30_000, maxConcurrentSessions: 2 });
  coordinator.discover(IDENTITY);
  const bridge = fakeBridge("sess_0000000000000001");
  const runtime = fakeRuntime();
  const sendJoin = bridge.send.bind(bridge);
  let joinSentMs: number | null = null;
  const started = process.hrtime.bigint();
  bridge.send = async (command) => { if (command.type === "join" && joinSentMs === null) joinSentMs = Number(process.hrtime.bigint() - started) / 1e6; return sendJoin(command); };
  const session = createMeetingSession({ identity: IDENTITY, bridge, runtime, coordinator, clock, agentIdentity: { aliases: ["Meetbot"] },
    bridgeId: "bridge-mac-synthetic", bridgeSessionId: "sess_0000000000000001", disclosureText: "Disclosure.", teamVaultDir: vault });
  try {
    await session.join();
    // Six git calls at >=100 ms each make a synchronous build >=600 ms; the join must not wait for it.
    assert.ok(joinSentMs !== null && joinSentMs < 150, `join sent ${joinSentMs} ms after construction began`);
    bridge.emit(bridge.event({ type: "joined", meetingOccurrenceId: IDENTITY.occurrenceId }));
    await session.settled();
    runtime.emit(transcript("seg-v", "Meetbot, please explain Orion launch code history?"));
    await session.settled();
    const seeded = runtime.callsOf("seedConversationContext")[0];
    assert.ok(seeded && seeded.method === "seedConversationContext");
    assert.match(seeded.exchanges[0]?.assistant ?? "", /violet/);
    assert.doesNotMatch(seeded.exchanges[0]?.assistant ?? "", /unavailable/i);
  } finally {
    await session.dispose(); store.close(); process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Review fixes: session end never waits on git; the binding moment and the
// "vault built" mark are pinned.

function sessionHarness(root: string, joinTiming?: (phase: string) => void) {
  const vault = path.join(root, "vault"); mkdirSync(vault);
  const git = (...args: string[]) => execFileSync("/usr/bin/git", args, { cwd: vault, env: FIXTURE_ENV });
  git("init", "-q"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  writeFileSync(path.join(vault, "orion.md"), "Orion launch code is violet.\n"); git("add", "-A"); git("commit", "-q", "-m", "fixture");
  const store = openSessionStore({ filename: path.join(root, "orchestration.db"), nowMs: BASE_MS });
  const clock = fakeClock(BASE_MS);
  const coordinator = createCoordinator({ store, clock, bridgeLeaseTtlMs: 30_000, maxConcurrentSessions: 2 });
  coordinator.discover(IDENTITY);
  const bridge = fakeBridge("sess_0000000000000001");
  const runtime = fakeRuntime();
  const create = () => createMeetingSession({ identity: IDENTITY, bridge, runtime, coordinator, clock, agentIdentity: { aliases: ["Meetbot"] },
    bridgeId: "bridge-mac-synthetic", bridgeSessionId: "sess_0000000000000001", disclosureText: "Disclosure.", teamVaultDir: vault,
    ...(joinTiming === undefined ? {} : { joinTiming: joinTiming as never }) });
  return { vault, store, bridge, runtime, create };
}

/** git from PATH blocks until `release()` (a hung git), then runs normally. */
function heldGit(root: string) {
  const bin = path.join(root, "held-bin"); mkdirSync(bin);
  const gate = path.join(root, "release");
  writeFileSync(path.join(bin, "git"), `#!/bin/sh\nwhile [ ! -e '${gate}' ]; do sleep 0.02; done\nexec /usr/bin/git "$@"\n`, { mode: 0o700 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved ?? "/usr/bin:/bin"}`;
  return { release: () => { writeFileSync(gate, ""); process.env.PATH = saved; } };
}

test("with a vault question waiting on a hung index build, dispose returns promptly and still finalizes the recording", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meeting-vault-dispose-"));
  const git = heldGit(root);
  const h = sessionHarness(root);
  const session = h.create();
  try {
    await session.join();
    h.bridge.emit(h.bridge.event({ type: "joined", meetingOccurrenceId: IDENTITY.occurrenceId }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    h.runtime.emit(transcript("seg-v", "Meetbot, please explain Orion launch code history?"));
    await new Promise((resolve) => setTimeout(resolve, 100)); // the question is now waiting for the index
    assert.equal(h.runtime.callsOf("seedConversationContext").length, 0, "the question is still waiting on the build");
    const started = process.hrtime.bigint();
    const disposing = session.dispose();
    const outcome = await Promise.race([disposing.then(() => "disposed"), new Promise((resolve) => setTimeout(() => resolve("hung"), 2000))]);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(outcome, "disposed", "dispose must not wait for git");
    assert.ok(elapsedMs < 1000, `dispose took ${elapsedMs} ms`);
    assert.equal(h.runtime.callsOf("finalizeRecording").length, 1, "the recording is finalized despite the hung build");
    assert.equal(h.runtime.callsOf("authorizeVoiceResponse").length, 0, "the cancelled question is never authorized");
  } finally {
    git.release();
    await session.dispose(); h.store.close();
    await new Promise((resolve) => setTimeout(resolve, 300)); // let the released git finish before removing its checkout
    rmSync(root, { recursive: true, force: true });
  }
});

test("the index binds its checkout during session construction: the first git query starts before createMeetingSession returns", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meeting-vault-binding-"));
  const h = sessionHarness(root);
  let session: ReturnType<typeof h.create> | undefined;
  try {
    const spawned: string[][] = [];
    const childProcess = (await import("node:child_process")).default;
    const { mock } = await import("node:test");
    const { syncBuiltinESMExports } = await import("node:module");
    const original = childProcess.execFile;
    const spy = mock.method(childProcess, "execFile", ((...args: unknown[]) => { spawned.push(args[1] as string[]); return (original as (...a: unknown[]) => unknown)(...args); }) as never);
    syncBuiltinESMExports();
    try {
      session = h.create();
      // Synchronously, before any await: the opening namespace+HEAD read is already spawned.
      assert.deepEqual(spawned.map((argv) => argv[2]), ["rev-parse"]);
      assert.ok(spawned[0]!.includes("--show-toplevel") && spawned[0]!.includes("--absolute-git-dir"));
    } finally { spy.mock.restore(); syncBuiltinESMExports(); }
  } finally {
    await session?.dispose(); h.store.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    rmSync(root, { recursive: true, force: true });
  }
});

test("the vault-built mark lands when the asynchronous build settles, after the join is sent", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meeting-vault-mark-"));
  const bin = path.join(root, "slow-bin"); mkdirSync(bin);
  writeFileSync(path.join(bin, "git"), `#!/bin/sh\nsleep 0.05\nexec /usr/bin/git "$@"\n`, { mode: 0o700 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? "/usr/bin:/bin"}`;
  const phases: string[] = [];
  const h = sessionHarness(root, (phase) => { phases.push(phase); });
  const session = h.create();
  try {
    await session.join();
    for (let waited = 0; !phases.includes("vault_index_built") && waited < 10_000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
    const at = (phase: string) => phases.indexOf(phase);
    assert.ok(at("vault_index_started") >= 0 && at("join_send_started") > at("vault_index_started"));
    assert.ok(at("vault_index_built") > at("join_send_started"), phases.join(","));
    assert.equal(phases.filter((phase) => phase === "vault_index_built").length, 1);
  } finally {
    await session.dispose(); h.store.close(); process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  }
});
