// Selected L6 fixture only: the destination holds a genuine consumer push.
// This never writes an application state, receipt or notification authority.
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const REF = "refs/heads/e2e", SHA = /^[0-9a-f]{40}$/, ZERO = "0".repeat(40);
const permits = new WeakMap();
function need(value, code) { if (!value) throw new Error(code); }
function commit(value) { return typeof value === "string" && SHA.test(value) && value !== ZERO; }
function budget(deadlineAtMs) {
  need(Number.isSafeInteger(deadlineAtMs) && deadlineAtMs > Date.now() && deadlineAtMs - Date.now() <= 600_000, "l6_deadline_refused");
}
function live(deadlineAtMs) { need(Date.now() < deadlineAtMs, "l6_deadline"); }
function same(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function privateDirectory(filename) {
  const stat = lstatSync(filename);
  need(stat.isDirectory() && (stat.mode & 0o777) === 0o700 && stat.uid === process.getuid(), "l6_private_directory_refused");
  return stat;
}
function scopedDirectories(root, target) {
  need(typeof root === "string" && path.isAbsolute(root) && root !== path.parse(root).root && realpathSync(root) === root, "l6_root_refused");
  const relative = path.relative(root, target);
  need(!relative.startsWith("..") && !path.isAbsolute(relative), "l6_scoped_path_refused");
  const dirs = [root];
  for (const part of relative ? relative.split(path.sep) : []) dirs.push(path.join(dirs.at(-1), part));
  return dirs.map(filename => ({ filename, identity: filename === root ? privateDirectory(filename) : lstatSync(filename) })).map(row => {
    need(row.identity.isDirectory() && row.identity.uid === process.getuid() && (row.identity.mode & 0o022) === 0, "l6_scoped_directory_refused");
    return row;
  });
}
function recheck(directories) {
  for (const row of directories) {
    const current = lstatSync(row.filename);
    need(same(current, row.identity) && current.isDirectory() && current.uid === process.getuid() &&
      (current.mode & 0o022) === 0 && (row.filename !== directories[0].filename || (current.mode & 0o777) === 0o700), "l6_directory_changed");
  }
}
function markerLinks(filename, stat) {
  if (stat.nlink === 1) return true;
  if (stat.nlink !== 2) return false;
  // Atomic exclusive publication has one brief owned temporary hardlink.
  try { const temporary = lstatSync(`${filename}.tmp`); return temporary.isFile() && same(stat, temporary); }
  catch { const after = lstatSync(filename); return same(stat, after) && after.nlink === 1; }
}
function readPrivate(filename) {
  const before = lstatSync(filename);
  need(before.isFile() && markerLinks(filename, before) && before.size > 0 && before.size <= 1024 &&
    (before.mode & 0o777) === 0o600 && before.uid === process.getuid(), "l6_marker_refused");
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    need(same(before, fstatSync(fd)), "l6_marker_changed");
    const bytes = readFileSync(fd);
    need(bytes.length === before.size && same(before, lstatSync(filename)) && before.mtimeMs === fstatSync(fd).mtimeMs, "l6_marker_changed");
    let result;
    try { result = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("l6_marker_refused"); }
    need(bytes.equals(Buffer.from(`${JSON.stringify(result)}\n`)), "l6_marker_refused");
    return result;
  } finally { closeSync(fd); }
}
function writeExclusive(filename, value) {
  // Readers never see a created-but-empty marker. link is an exclusive publish:
  // a second hook cannot replace the first entered/released fact.
  const temporary = `${filename}.tmp`, fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(temporary, filename); } finally { unlinkSync(temporary); }
}
function keys(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join("\0") === expected.slice().sort().join("\0");
}
export function parseReceiptUpdate(bytes, seedCommit) {
  need(Buffer.isBuffer(bytes) && bytes.length <= 256 && commit(seedCommit), "l6_receive_update_refused");
  const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) refs\/heads\/e2e\n$/.exec(bytes.toString("ascii"));
  need(match && match[1] === seedCommit && commit(match[2]) && match[2] !== seedCommit && bytes.equals(Buffer.from(match[0])), "l6_receive_update_refused");
  return { candidateCommit: match[2], refValidated: true, seedMatched: true };
}
/** No candidate-object read here: receive-pack may still own it in quarantine. */
export async function runReceiptHook({ gateDir, input = process.stdin }) {
  const dir = privateDirectory(gateDir), plan = readPrivate(path.join(gateDir, "plan.json"));
  need(keys(plan, ["root", "seedCommit", "deadlineAtMs"]) && commit(plan.seedCommit), "l6_hook_plan_refused");
  need(gateDir === path.join(plan.root, "teammem", "receipt-gate"), "l6_hook_plan_refused");
  const directories = scopedDirectories(plan.root, gateDir);
  budget(plan.deadlineAtMs);
  let bytes = Buffer.alloc(0);
  // Bound both stream length and EOF; a writer cannot keep this hook alive.
  const read = (async () => {
    for await (const chunk of input) {
      need(Buffer.isBuffer(chunk) && bytes.length + chunk.length <= 256, "l6_receive_update_refused");
      bytes = Buffer.concat([bytes, chunk]);
    }
    return parseReceiptUpdate(bytes, plan.seedCommit);
  })();
  let timer;
  try {
    const entered = await Promise.race([read, new Promise((_, reject) => {
      timer = setTimeout(() => { input.destroy(); reject(new Error("l6_deadline")); }, Math.max(1, plan.deadlineAtMs - Date.now()));
    })]);
    recheck(directories); need(same(dir, privateDirectory(gateDir)), "l6_directory_changed");
    need(!existsSync(path.join(gateDir, "abort.json")), "l6_hook_aborted");
    writeExclusive(path.join(gateDir, "entered.json"), entered);
    while (!existsSync(path.join(gateDir, "release.json"))) {
      live(plan.deadlineAtMs); recheck(directories);
      need(!existsSync(path.join(gateDir, "abort.json")), "l6_hook_aborted");
      await pause(Math.min(10, Math.max(1, plan.deadlineAtMs - Date.now())));
    }
    live(plan.deadlineAtMs); recheck(directories);
    const release = readPrivate(path.join(gateDir, "release.json"));
    need(keys(release, ["released"]) && release.released === true && !existsSync(path.join(gateDir, "abort.json")), "l6_release_refused");
    writeExclusive(path.join(gateDir, "accepted.json"), { accepted: true });
  } finally { clearTimeout(timer); }
}
/** Install only after the caller's ordinary seed, in its newly owned fixture. */
export function createReceiptGate({ privateRoot, teammem, seedCommit, deadlineAtMs }) {
  const nodePath = process.execPath;
  budget(deadlineAtMs); need(commit(seedCommit), "l6_seed_refused");
  const bare = path.join(privateRoot, "teammem", "vault-remote.git"), hooks = path.join(bare, "hooks");
  need(teammem.paths.bare === bare && path.isAbsolute(nodePath) && !/[\s\r\n]/.test(nodePath), "l6_destination_refused");
  const directories = scopedDirectories(privateRoot, bare);
  const git = args => spawnSync("/usr/bin/git", ["-C", bare, ...args], { env: teammem.env, encoding: "utf8", timeout: Math.max(1, Math.min(2000, deadlineAtMs - Date.now())), maxBuffer: 4096 });
  const isBare = git(["rev-parse", "--is-bare-repository"]), seed = git(["rev-parse", "--verify", REF]), seedType = git(["cat-file", "-t", seedCommit]);
  need(isBare.status === 0 && isBare.stdout === "true\n" && seed.status === 0 && seed.stdout === `${seedCommit}\n` &&
    seedType.status === 0 && seedType.stdout === "commit\n", "l6_seed_destination_refused");
  recheck(directories);
  const hook = path.join(hooks, "pre-receive"), dir = path.join(privateRoot, "teammem", "receipt-gate");
  need(!existsSync(hook) && !existsSync(dir), "l6_duplicate_arm");
  // An empty Git template deliberately has no hooks directory. Provision only
  // this final component, after the owned bare chain and real seed are trusted.
  try { lstatSync(hooks); }
  catch (error) { if (error.code !== "ENOENT") throw error; recheck(directories); mkdirSync(hooks, { mode: 0o700 }); }
  const hookDirectories = scopedDirectories(privateRoot, hooks);
  recheck(directories); recheck(hookDirectories);
  mkdirSync(dir, { mode: 0o700 });
  const ownedDirs = [...hookDirectories, { filename: dir, identity: privateDirectory(dir) }];
  writeExclusive(path.join(dir, "plan.json"), { root: privateRoot, seedCommit, deadlineAtMs });
  const moduleUrl = pathToFileURL(fileURLToPath(import.meta.url)).href;
  writeFileSync(hook, `#!${nodePath}\nimport { runReceiptHook } from ${JSON.stringify(moduleUrl)};\ntry { await runReceiptHook({gateDir:${JSON.stringify(dir)}}); } catch { process.exitCode=1; }\n`, { flag: "wx", mode: 0o700 });
  const hookIdentity = lstatSync(hook);
  let closed = false, released = false;
  const gate = {
    deadlineAtMs,
    snapshot() {
      recheck(ownedDirs);
      const entered = existsSync(path.join(dir, "entered.json")) ? readPrivate(path.join(dir, "entered.json")) : null;
      if (entered) need(keys(entered, ["candidateCommit", "refValidated", "seedMatched"]) && commit(entered.candidateCommit) && entered.candidateCommit !== seedCommit && entered.refValidated === true && entered.seedMatched === true, "l6_entered_refused");
      return { armed: !closed, entered: entered !== null, candidateCommit: entered?.candidateCommit ?? null, seedMatched: entered?.seedMatched ?? false,
        refValidated: entered?.refValidated ?? false, released, accepted: existsSync(path.join(dir, "accepted.json")) && (() => {
          const accepted = readPrivate(path.join(dir, "accepted.json"));
          need(keys(accepted, ["accepted"]) && accepted.accepted === true, "l6_accept_marker_refused"); return true;
        })(), closed };
    },
    async waitEntered() {
      for (;;) { live(deadlineAtMs); const state = gate.snapshot(); need(!closed, "l6_gate_closed"); if (state.entered) return state; await pause(10); }
    },
    release(permit) {
      live(deadlineAtMs); const state = gate.snapshot();
      need(!closed && !released && state.entered && permits.get(permit) === gate, "l6_release_refused");
      writeExclusive(path.join(dir, "release.json"), { released: true }); released = true; permits.delete(permit);
    },
    close() {
      if (closed) return;
      recheck(ownedDirs);
      if (!existsSync(path.join(dir, "abort.json"))) writeExclusive(path.join(dir, "abort.json"), { aborted: true });
      need(same(lstatSync(hook), hookIdentity) && lstatSync(hook).isFile(), "l6_hook_changed");
      unlinkSync(hook); closed = true;
    },
  };
  return gate;
}

/** Same argv/env as publish(), with ownership registered before any spawn or
 * await. Output is discarded, never retained as arbitrary consumer diagnostics. */
export function startOwnedPublication({ privateRoot, teammem, nowIso, allowPush, deadlineAtMs, register, onChild, processGroup = false }) {
  budget(deadlineAtMs); need(allowPush === true && Number.isFinite(Date.parse(nowIso)) && typeof register === "function", "l6_publication_refused");
  need(typeof processGroup === "boolean" && (!processGroup || typeof onChild === "function") && (onChild === undefined || typeof onChild === "function"), "l6_child_registration_refused");
  const ownedDirectories = [...scopedDirectories(privateRoot, path.dirname(teammem.binary)), ...scopedDirectories(privateRoot, path.dirname(teammem.paths.envFile))];
  const binaryIdentity = lstatSync(teammem.binary), envIdentity = lstatSync(teammem.paths.envFile);
  need(binaryIdentity.isFile() && binaryIdentity.uid === process.getuid() && (binaryIdentity.mode & 0o022) === 0 &&
    envIdentity.isFile() && envIdentity.uid === process.getuid() && (envIdentity.mode & 0o777) === 0o600 && envIdentity.nlink === 1, "l6_consumer_path_refused");
  let child = null, closed = false, completed = false, closePromise;
  const children = [];
  const invoke = argv => new Promise((resolve, reject) => {
    live(deadlineAtMs); need(!closed, "l6_publication_closed");
    recheck(ownedDirectories);
    need(same(binaryIdentity, lstatSync(teammem.binary)) && same(envIdentity, lstatSync(teammem.paths.envFile)), "l6_consumer_path_changed");
    const current = spawn(teammem.binary, ["--env-file", teammem.paths.envFile, ...argv], { env: teammem.env, stdio: "ignore", detached: processGroup });
    child = current;
    let timer;
    const exited = new Promise(done => {
      current.once("error", () => { clearTimeout(timer); done({ exit: null, failed: true }); });
      current.once("close", (exit, signal) => { clearTimeout(timer); done({ exit, failed: signal !== null }); });
    });
    const row = { child: current, exited, settled: false }; children.push(row);
    void exited.then(() => { row.settled = true; });
    if (onChild) {
      try { need(onChild(current) === undefined, "l6_child_registration_refused"); }
      catch (error) { current.kill("SIGTERM"); reject(error); return; }
    }
    timer = setTimeout(() => { current.kill("SIGTERM"); reject(new Error("l6_publication_deadline")); }, Math.max(1, deadlineAtMs - Date.now()));
    exited.then(result => { if (child === current) child = null; resolve(result); });
  });
  const owner = {
    pending: () => !completed && !closed,
    childrenSettled: () => children.every(row => row.settled),
    result: null,
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        if (child) child.kill("SIGTERM");
        for (const row of children) {
          let timeout;
          const settled = await Promise.race([row.exited, new Promise(resolve => { timeout = setTimeout(() => resolve(null), 1000); })]);
          clearTimeout(timeout);
          if (settled === null) {
            row.child.kill("SIGKILL");
            let killTimeout;
            const killed = await Promise.race([row.exited, new Promise(resolve => { killTimeout = setTimeout(() => resolve(null), 1000); })]);
            clearTimeout(killTimeout); need(killed !== null, "l6_consumer_close_unconfirmed");
          }
        }
        // A scheduled invocation observes closed before spawning a second child.
        await owner.result.catch(() => undefined);
        need(owner.childrenSettled(), "l6_consumer_close_unconfirmed");
      })();
      return closePromise;
    },
  };
  need(register(owner) === undefined, "l6_registration_not_synchronous");
  owner.result = Promise.resolve().then(async () => {
    const dryRun = await invoke(["process-meetings", "--now", nowIso, "--dry-run"]);
    need(dryRun.exit === 0 && !dryRun.failed, "l6_dry_run_failed");
    const publishRun = await invoke(["process-meetings", "--now", nowIso]);
    need(publishRun.exit === 0 && !publishRun.failed, "l6_publish_failed");
    completed = true; return { dryRun: { exit: 0 }, publishRun: { exit: 0 } };
  }).finally(() => { completed = true; });
  // Rejection remains available on result while the controller is observing.
  void owner.result.catch(() => undefined);
  return owner;
}

function uuid(binding) {
  const bytes = createHash("sha256").update(JSON.stringify(["meeting-agent-notification/v1", binding.occurrenceId, 1, binding.artifactHash, binding.publicationUrl, binding.vaultCommit])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
/** Production read methods are trusted inputs. Only this closed DTO is public;
 * no recovery bytes, claim tokens, raw messages or provider errors escape. */
export function receiptGateState({ store, occurrenceId, artifactHash, creatorId, title, receipt, remoteHead, seedCommit, messages, nowMs }) {
  const deliveries = store.pending(), notifications = store.notifications();
  const d = deliveries[0], n = notifications[0], session = store.getSession(occurrenceId);
  const receiptBound = receipt !== null && receipt?.schema === "teammem-meeting-receipt/v1" && receipt.status === "published" &&
    receipt.occurrence_id === occurrenceId && receipt.revision === 1 && receipt.artifact_hash === artifactHash && commit(receipt.vault_commit) &&
    typeof receipt.markdown_url === "string" && receipt.markdown_url.includes(`/-/blob/${receipt.vault_commit}/`);
  const binding = { occurrenceId, artifactHash, publicationUrl: receipt?.markdown_url, vaultCommit: receipt?.vault_commit };
  const intentBound = receiptBound && notifications.length === 1 && n.occurrenceId === occurrenceId && n.revision === 1 && n.artifactHash === artifactHash &&
    n.recipientId === creatorId && n.title === title && n.messageText === `Meeting notes: ${title}\n${binding.publicationUrl}` && n.requestUuid === uuid(binding) &&
    n.publicationUrl === binding.publicationUrl && n.vaultCommit === binding.vaultCommit;
  return {
    state: ["awaiting_teammem", "published", "notified"].includes(session?.state) ? session.state : "other",
    deliveryCount: deliveries.length, deliveryBound: deliveries.length === 1 && d.occurrenceId === occurrenceId && d.revision === 1 && d.artifactHash === artifactHash && d.transcriptComplete === false && d.deletedAtMs === null,
    published: d?.publishedAtMs !== null && d?.publishedAtMs !== undefined,
    publicationBound: receiptBound && d?.publicationUrl === binding.publicationUrl && d.vaultCommit === binding.vaultCommit && Number.isSafeInteger(d.publishedAtMs),
    retryCount: d?.retryCount ?? null, nextRetryAtMs: d?.nextRetryAtMs ?? null, nowMs,
    notificationCount: notifications.length, attemptCount: n?.attemptCount ?? 0, intentBound,
    sent: n?.state === "sent" && n.claimToken === null && Number.isSafeInteger(n.sentAtMs) && typeof n.providerMessageId === "string",
    messageCount: messages.length, messageBound: intentBound && messages.length === 1 && messages[0].receiveId === creatorId && messages[0].uuid === n.requestUuid &&
      messages[0].text === n.messageText && n.providerMessageId === "om_e2e_1",
    receiptPresent: receipt !== null, receiptBound, remoteSeed: remoteHead === seedCommit,
    receiptCommit: receiptBound ? receipt.vault_commit : null,
    publicationFingerprint: receiptBound ? createHash("sha256").update(JSON.stringify([binding, receipt.markdown_path, d?.publishedAtMs,
      n?.firstAttemptAtMs, n?.lastAttemptAtMs, n?.sentAtMs, n?.attemptCount, n?.state])).digest("hex") : null,
  };
}
function held(state) {
  need(state.state === "awaiting_teammem" && state.deliveryCount === 1 && state.deliveryBound && !state.published &&
    state.notificationCount === 0 && state.attemptCount === 0 && state.messageCount === 0 && !state.receiptPresent && state.remoteSeed, "l6_held_authority_refused");
}
function sent(state) {
  need(state.state === "notified" && state.deliveryCount === 1 && state.deliveryBound && state.published && state.publicationBound &&
    state.receiptPresent && state.receiptBound && state.notificationCount === 1 && state.attemptCount === 1 && state.intentBound && state.sent &&
    state.messageCount === 1 && state.messageBound && !state.remoteSeed, "l6_notification_binding_refused");
}
function lane(status, name) {
  const rows = status?.lanes?.filter(row => row.lane === name);
  need(rows?.length === 1 && Number.isSafeInteger(rows[0].ticks) && rows[0].ticks >= 0 && Array.isArray(rows[0].failures) && rows[0].failures.length === 0 &&
    status.codes?.length === 0 && !rows[0].inFlight, "l6_lane_status_refused"); return rows[0];
}
/** The same sequencer is for the later actual entry adapter and component C.
 * A tick return alone is insufficient: settled lane counters must advance. */
export function createReceiptGateController({ gate, publisher, observe, maintenanceTick, maintenanceStatus, maintenanceBatch }) {
  const history = [], polls = [];
  async function snapshot() {
    const raw = await observe(), state = {};
    const booleans = ["deliveryBound", "published", "publicationBound", "intentBound", "sent", "messageBound", "receiptPresent", "receiptBound", "remoteSeed"];
    const counts = ["deliveryCount", "notificationCount", "attemptCount", "messageCount", "retryCount"];
    const names = ["state", ...booleans, ...counts, "nowMs", "nextRetryAtMs", "receiptCommit", "publicationFingerprint"];
    need(keys(raw, names), "l6_state_projection_refused");
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, name);
      need(descriptor && "value" in descriptor, "l6_state_projection_refused"); state[name] = descriptor.value;
    }
    need(["awaiting_teammem", "published", "notified", "other"].includes(state.state) && booleans.every(name => typeof state[name] === "boolean") &&
      counts.every(name => state[name] === null || (Number.isSafeInteger(state[name]) && state[name] >= 0 && state[name] <= 256)) &&
      ["nowMs", "nextRetryAtMs"].every(name => state[name] === null || (Number.isSafeInteger(state[name]) && state[name] >= 0)) &&
      (state.receiptCommit === null || commit(state.receiptCommit)) &&
      (state.publicationFingerprint === null || /^[0-9a-f]{64}$/.test(state.publicationFingerprint)), "l6_state_projection_refused");
    need(history.length < 128, "l6_observation_bound"); history.push(state); return state;
  }
  async function poll(names) {
    const before = maintenanceStatus();
    const prior = names.map(name => lane(before, name).ticks);
    const outcomes = maintenanceBatch ? await maintenanceBatch(names) : await Promise.all(names.map(name => maintenanceTick(name)));
    const after = maintenanceStatus();
    for (const [index, name] of names.entries()) {
      const result = lane(after, name), expected = name === "outbox" ? "outbox_reconciled" : "notification_polled";
      need(outcomes[index] === expected && result.lastOutcome === expected && result.ticks > prior[index], "l6_lane_ack_refused");
      polls.push({ lane: name, delta: result.ticks - prior[index], settled: true });
    }
  }
  async function due() {
    for (;;) {
      live(gate.deadlineAtMs); const state = await observe();
      need(Number.isSafeInteger(state.nowMs) && Number.isSafeInteger(state.nextRetryAtMs), "l6_due_refused");
      if (state.nowMs >= state.nextRetryAtMs) return;
      await pause(Math.min(10, Math.max(1, gate.deadlineAtMs - Date.now())));
    }
  }
  let heldComplete = false, sentState;
  return {
    async hold() {
      need(!heldComplete, "l6_duplicate_held_pass");
      await Promise.race([gate.waitEntered(), publisher.result.then(() => { throw new Error("l6_consumer_completed_before_entered"); })]);
      need(publisher.pending() && !gate.snapshot().released, "l6_pending_consumer_refused");
      const before = await snapshot(); held(before);
      await poll(["notification"]); held(await snapshot());
      await due(); await poll(["notification", "outbox"]);
      const after = await snapshot(); held(after);
      need(publisher.pending() && !gate.snapshot().released && after.retryCount > before.retryCount, "l6_due_poll_unproved");
      heldComplete = true;
      const permit = Object.freeze({}); permits.set(permit, gate); return permit;
    },
    async release(permit, verifyRemote) {
      need(heldComplete, "l6_release_refused"); held(await snapshot());
      need(publisher.pending(), "l6_pending_consumer_refused"); gate.release(permit);
      const result = await publisher.result;
      need(result?.dryRun?.exit === 0 && result?.publishRun?.exit === 0 && publisher.childrenSettled() && gate.snapshot().accepted, "l6_consumer_success_refused");
      const verified = await verifyRemote(gate.snapshot().candidateCommit);
      need(verified?.commitExists === true && verified.commitIsAncestorOfRef === true && verified.noteMatchesArtifact === true && verified.receiptCanonical === true, "l6_remote_receipt_refused");
      // No imposed observer-vs-app ordering: an automatic lane may already send.
      await poll(["notification"]);
      for (;;) {
        live(gate.deadlineAtMs); const current = await snapshot();
        need(current.receiptCommit === gate.snapshot().candidateCommit, "l6_receipt_candidate_refused");
        if (current.state === "notified") { sent(current); sentState = current; break; }
        need(current.receiptPresent && current.receiptBound, "l6_receipt_missing_after_publish");
        await due(); await poll(["outbox", "notification"]);
      }
      await poll(["outbox", "notification"]); const repeated = await snapshot(); sent(repeated);
      need(repeated.publicationFingerprint === sentState.publicationFingerprint && repeated.attemptCount === sentState.attemptCount &&
        repeated.messageCount === sentState.messageCount && repeated.notificationCount === sentState.notificationCount, "l6_repeated_poll_changed");
      return { schema: "meeting-l6-receipt-gate/v1", heldPollsCompleted: true, remoteReceiptVerified: true, exactlyOneSend: true,
        repeatedPollStable: true, polls: polls.slice(), history: history.slice() };
    },
    evidence: () => ({ polls: polls.slice(), history: history.slice(), heldComplete }),
    async close() {
      const results = await Promise.allSettled([Promise.resolve().then(() => publisher.close()), Promise.resolve().then(() => gate.close())]);
      need(results.every(row => row.status === "fulfilled") && publisher.childrenSettled() && gate.snapshot().closed, "l6_owned_cleanup_unconfirmed");
    },
  };
}
