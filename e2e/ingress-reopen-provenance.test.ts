import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

// Listener-free component facts. No ps, lock helper or native child executes.
const run = () => import(path.join(import.meta.dirname, "ingress-run.mjs"));
const evidenceApi = () => import(path.join(import.meta.dirname, "process-evidence.mjs"));
const provenance = () => import(path.join(import.meta.dirname, "admission-helper-provenance.mjs"));

const ROLE = "ingress-phase-3", TAG = "ingress-phase-3-admission-helper";
const PARENT = 100, OWNER = 200, HELPER = 201, PS = 300;
const absent = () => { throw Object.assign(new Error("synthetic absent PID"), { code: "ESRCH" }); };
const sample = (rows: string) => ({ exit: 0, signal: null, stdout: rows, stderr: "", durationMs: 1 });
type Helper = { sequence: number; role: string; pid: number; exitObserved: boolean; closeObserved: boolean; code: number | null; signal: string | null };
const settled = (pid = HELPER, sequence = 1, role = "volume_inspection"): Helper =>
  ({ sequence, role, pid, exitObserved: true, closeObserved: true, code: 0, signal: null });
const record = (helpers: Helper[] = [settled()], extra: Record<string, unknown> = {}) =>
  ({ schema: "meeting-ingress-admission-helpers/v1", ownerPid: OWNER, invalid: false, helpers, ...extra });

/** Actual-shaped topology: runner P, owner O->P, admission helper H->O, inventory ps Q->P. */
async function phase3(rows = `${PARENT} 1 node\n${OWNER} ${PARENT} node\n${HELPER} ${OWNER} /usr/sbin/diskutil\n${PS} ${PARENT} /bin/ps\n`) {
  const h = await run(), { createProcessEvidence } = await evidenceApi(), evidence = createProcessEvidence();
  h.observeIngressInventory(evidence, { rootPid: PARENT, owner: "parent", stage: "phase-3-before", baseline: true, result: sample(`${PARENT} 1 node\n${PS} ${PARENT} /bin/ps\n`) });
  h.observeIngressInventory(evidence, { rootPid: OWNER, owner: ROLE, stage: "phase-3-running", result: sample(rows) });
  h.observeIngressInventory(evidence, { rootPid: OWNER, owner: ROLE, stage: "phase-3-running", result: sample(`${PARENT} 1 node\n${OWNER} ${PARENT} node\n${PS} ${PARENT} /bin/ps\n`) });
  h.observeIngressInventory(evidence, { rootPid: PARENT, owner: ROLE, stage: "phase-3-close", baseline: true, result: sample(`${PARENT} 1 node\n${PS} ${PARENT} /bin/ps\n`) });
  evidence.children.push({ role: ROLE, pid: OWNER, outcome: { exitObserved: true, code: 0, signal: null } });
  return { h, evidence };
}

test("RED reproduction: an owned admission helper sampled under the reopen owner is a second PID and the strict origin oracle rejects it", async () => {
  const { h, evidence } = await phase3(), proof = h.ingressProcessProof(evidence, ROLE, absent);
  assert.deepEqual(proof.pids, [{ pid: OWNER, origins: [ROLE] }, { pid: HELPER, origins: [ROLE] }]);
  assert.equal(proof.cleanupConfirmed, true);
  assert.equal(proof.pids.some((row: { pid: number }) => row.pid === PS || row.pid === PARENT), false, "sibling ps and runner never enter the owner set");
  assert.throws(() => h.assertIngressReopenOrigins(proof, OWNER), /reopen_process_origins/);
  assert.throws(() => h.assertIngressReopenOrigins(proof, OWNER, undefined), /reopen_process_origins/);
});

test("a registered, settled, owner-parented admission helper is attributed while staying in cleanup proof", async () => {
  const { h, evidence } = await phase3();
  assert.equal(h.attributeIngressAdmissionHelpers(evidence, { role: ROLE, ownerPid: OWNER, helpers: record() }), 1);
  const proof = h.ingressProcessProof(evidence, ROLE, absent);
  assert.deepEqual(proof.pids, [{ pid: OWNER, origins: [ROLE] }, { pid: HELPER, origins: [ROLE, TAG] }]);
  assert.deepEqual(proof.probes.map((row: { pid: number; status: string }) => [row.pid, row.status]), [[OWNER, "absent"], [HELPER, "absent"]]);
  h.assertIngressReopenOrigins(proof, OWNER, record());
  // The final campaign proof still carries every descendant.
  assert.deepEqual(h.ingressProcessProof(evidence, undefined, absent).pids.map((row: { pid: number }) => row.pid), [OWNER, HELPER]);
});

const negatives: [string, () => Promise<{ helpers: unknown; rows?: string; probe?: (pid: number) => void; assertHelpers?: unknown }>][] = [
  ["unknown descendant beside a registered helper", async () => ({ helpers: record(), rows: `${OWNER} ${PARENT} node\n${HELPER} ${OWNER} /usr/sbin/diskutil\n202 ${OWNER} unknown\n` })],
  ["Runtime-shaped descendant with no registration", async () => ({ helpers: record(), rows: `${OWNER} ${PARENT} node\n${HELPER} ${OWNER} /usr/sbin/diskutil\n203 ${OWNER} python3\n` })],
  ["registered PID observed only as a grandchild", async () => ({ helpers: record(), rows: `${OWNER} ${PARENT} node\n202 ${OWNER} x\n${HELPER} 202 /usr/sbin/diskutil\n` })],
  ["registered PID observed under another registered helper", async () => ({ helpers: record([settled(202), settled(HELPER, 2, "filesystem_extract")]),
    rows: `${OWNER} ${PARENT} node\n202 ${OWNER} /usr/sbin/diskutil\n${HELPER} 202 /usr/bin/plutil\n` })],
  ["missing registration", async () => ({ helpers: undefined })],
  ["nonzero helper exit", async () => ({ helpers: record([{ ...settled(), code: 1 }]) })],
  ["signalled helper", async () => ({ helpers: record([{ ...settled(), code: null, signal: "SIGKILL" }]) })],
  ["helper exit not observed", async () => ({ helpers: record([{ ...settled(), exitObserved: false }]) })],
  ["helper close not observed", async () => ({ helpers: record([{ ...settled(), closeObserved: false }]) })],
  ["invalid observer scope", async () => ({ helpers: record([settled()], { invalid: true }) })],
  ["mismatched owner PID", async () => ({ helpers: record([settled()], { ownerPid: 999 }) })],
  ["helper claiming the owner PID", async () => ({ helpers: record([settled(OWNER)]) })],
  ["duplicate helper PID", async () => ({ helpers: record([settled(), settled(HELPER, 2, "filesystem_extract")]) })],
  ["out-of-order role", async () => ({ helpers: record([settled(HELPER, 1, "owner_lock")]) })],
  ["unknown role", async () => ({ helpers: record([settled(HELPER, 1, "runtime")]) })],
  ["five helper rows", async () => ({ helpers: record(["volume_inspection", "filesystem_extract", "mount_extract", "owner_lock", "owner_lock"].map((role, i) => settled(HELPER + i, i + 1, role))) })],
  ["extra record field", async () => ({ helpers: record([settled()], { comm: "/usr/sbin/diskutil" }) })],
  ["extra helper field", async () => ({ helpers: record([{ ...settled(), argv: ["info"] } as Helper]) })],
  ["helper still present", async () => ({ helpers: record(), probe: (pid: number) => { if (pid !== HELPER) absent(); } })],
  ["attribution with a different record than the oracle", async () => ({ helpers: record(), assertHelpers: record([settled(HELPER + 9)]) })],
];
for (const [name, build] of negatives) test(`reopen origins still refuse: ${name}`, async () => {
  const c = await build(), { h, evidence } = await phase3(c.rows === undefined ? undefined : `${PARENT} 1 node\n${c.rows}`);
  try { h.attributeIngressAdmissionHelpers(evidence, { role: ROLE, ownerPid: OWNER, helpers: c.helpers }); } catch { /* refusal is also acceptable */ }
  const proof = h.ingressProcessProof(evidence, ROLE, c.probe ?? absent);
  assert.throws(() => h.assertIngressReopenOrigins(proof, OWNER, "assertHelpers" in c ? c.assertHelpers : c.helpers), /reopen_process_origins|admission_helper/);
});

test("a forged helper tag without matching registration is refused by the oracle itself", async () => {
  const h = await run();
  const proof = { cleanupConfirmed: true, processInventoryVerified: true, knownOwnedChildrenReaped: true, orphans: [], invalidPids: [],
    inventory: { samples: 1, failures: [], outcomes: [] },
    pids: [{ pid: OWNER, origins: [ROLE] }, { pid: HELPER, origins: [ROLE, TAG] }],
    probes: [{ pid: OWNER, origins: [ROLE], status: "absent" }, { pid: HELPER, origins: [ROLE, TAG], status: "absent" }],
    children: [{ role: ROLE, pid: OWNER, outcome: { exitObserved: true, code: 0, signal: null } }], inventoryCoverage: "observed_run" };
  assert.throws(() => h.assertIngressReopenOrigins(proof, OWNER), /reopen_process_origins/);
  h.assertIngressReopenOrigins(proof, OWNER, record());
  const ownerTagged = structuredClone(proof); ownerTagged.pids[0]!.origins.push(TAG); ownerTagged.probes[0]!.origins.push(TAG);
  assert.throws(() => h.assertIngressReopenOrigins(ownerTagged, OWNER, record()), /reopen_process_origins/);
  const twoOwners = structuredClone(proof); twoOwners.pids[1]!.origins = [ROLE]; twoOwners.probes[1]!.origins = [ROLE];
  assert.throws(() => h.assertIngressReopenOrigins(twoOwners, OWNER, record()), /reopen_process_origins/);
  const splitTag = structuredClone(proof); splitTag.pids[1]!.origins = [ROLE];
  assert.throws(() => h.assertIngressReopenOrigins(splitTag, OWNER, record()), /reopen_process_origins/);
  const probeGap = structuredClone(proof); probeGap.probes.pop();
  assert.throws(() => h.assertIngressReopenOrigins(probeGap, OWNER, record()), /reopen_process_origins/);
});

// Child-side observer at the owner-lock dynamic spawn seam, with fake ChildProcess objects only.
const SHAPES = [
  ["/usr/sbin/diskutil", ["info", "-plist", "/synthetic-mount"], ["ignore", "pipe", "ignore"]],
  ["/usr/bin/plutil", ["-extract", "FilesystemType", "raw", "-o", "-", "-"], ["pipe", "pipe", "ignore"]],
  ["/usr/bin/plutil", ["-extract", "MountPoint", "raw", "-o", "-", "-"], ["pipe", "pipe", "ignore"]],
  ["/usr/bin/lockf", ["-s", "-t", "0", "3"], ["ignore", "ignore", "ignore", 7]],
] as const;
function fakeModule(pids = [501, 502, 503, 504]) {
  const children: (EventEmitter & { pid?: number | undefined })[] = [], calls: unknown[][] = [];
  const original = function spawn(this: unknown, ...args: unknown[]) {
    calls.push([this, ...args]); const child = Object.assign(new EventEmitter(), { pid: pids[children.length] }); children.push(child); return child;
  };
  return { cp: { spawn: original } as { spawn: (...args: unknown[]) => unknown }, original, children, calls };
}
const options = (stdio: readonly unknown[]) => ({ stdio: [...stdio], env: {}, shell: false, detached: false });
async function acquireAll(cp: { spawn: (...args: unknown[]) => unknown }, settle = (child: EventEmitter) => { child.emit("exit", 0, null); child.emit("close", 0, null); }) {
  const returned = [], passed = [];
  for (const [executable, args, stdio] of SHAPES) {
    const a = [...args], o = options(stdio); passed.push([executable, a, o]);
    const child = cp.spawn(executable, a, o) as EventEmitter; returned.push(child);
    await Promise.resolve(); settle(child);
  }
  return { owner: { close() {} }, returned, passed };
}

test("observer passes identical calls through, restores spawn, and records four settled roles", async () => {
  const p = await provenance(), m = fakeModule(), before = Object.getOwnPropertyDescriptor(m.cp, "spawn");
  const observer = p.createAdmissionHelperObserver(m.cp, { ownerPid: OWNER });
  let inside: unknown;
  const outcome = await observer.observe(async () => { inside = m.cp.spawn; return acquireAll(m.cp); });
  assert.notEqual(inside, m.original); assert.deepEqual(Object.getOwnPropertyDescriptor(m.cp, "spawn"), before);
  assert.deepEqual(outcome.returned, m.children, "identical ChildProcess objects are returned");
  for (const [index, call] of m.calls.entries()) {
    assert.equal(call[0], m.cp, "identical receiver");
    for (const at of [0, 1, 2]) assert.equal(call[at + 1], outcome.passed[index]![at], "identical argument objects");
  }
  assert.deepEqual(observer.record(), { schema: "meeting-ingress-admission-helpers/v1", ownerPid: OWNER, invalid: false,
    helpers: ["volume_inspection", "filesystem_extract", "mount_extract", "owner_lock"].map((role, i) => ({ sequence: i + 1, role, pid: 501 + i,
      exitObserved: true, closeObserved: true, code: 0, signal: null })) });
  const json = JSON.stringify(observer.record());
  for (const leaked of ["/synthetic-mount", "diskutil", "plutil", "lockf", "MountPoint", "\"7\"", "info"]) assert.equal(json.includes(leaked), false, leaked);
});

test("observer restores spawn and propagates identity on rejection and synchronous throw", async () => {
  const p = await provenance(), m = fakeModule(), refusal = new Error("synthetic refusal");
  const observer = p.createAdmissionHelperObserver(m.cp, { ownerPid: OWNER });
  await assert.rejects(observer.observe(async () => { m.cp.spawn(SHAPES[0][0], [...SHAPES[0][1]], options(SHAPES[0][2])); throw refusal; }), error => error === refusal);
  assert.equal(m.cp.spawn, m.original);
  assert.equal(observer.record().helpers[0].closeObserved, false);
  const thrown = new Error("synthetic spawn throw"), t = { spawn() { throw thrown; } }, original = t.spawn;
  const second = p.createAdmissionHelperObserver(t, { ownerPid: OWNER });
  await assert.rejects(second.observe(async () => { t.spawn(); }), error => error === thrown);
  assert.equal(t.spawn, original); assert.equal(second.record().invalid, true);
});

for (const [name, acquire] of [
  ["unexpected executable", async (cp: { spawn: (...args: unknown[]) => unknown }) => { cp.spawn("/bin/sh", ["-c", "x"], options(["ignore", "pipe", "ignore"])); }],
  ["wrong order", async (cp: { spawn: (...args: unknown[]) => unknown }) => { cp.spawn(SHAPES[3][0], [...SHAPES[3][1]], options(SHAPES[3][2])); }],
  ["wrong option shape", async (cp: { spawn: (...args: unknown[]) => unknown }) => { cp.spawn(SHAPES[0][0], [...SHAPES[0][1]], { ...options(SHAPES[0][2]), shell: true }); }],
  ["fifth spawn", async (cp: { spawn: (...args: unknown[]) => unknown }) => { await acquireAll(cp); cp.spawn(SHAPES[3][0], [...SHAPES[3][1]], options(SHAPES[3][2])); }],
] as const) test(`observer marks ${name} invalid without altering the call`, async () => {
  const p = await provenance(), m = fakeModule([501, 502, 503, 504, 505]);
  const observer = p.createAdmissionHelperObserver(m.cp, { ownerPid: OWNER });
  await observer.observe(() => acquire(m.cp));
  assert.equal(observer.record().invalid, true); assert.equal(m.cp.spawn, m.original);
  assert.ok(observer.record().helpers.length <= 4);
});

test("observer refuses nested scopes and invalid PIDs, and never invents a missed exit", async () => {
  const p = await provenance(), m = fakeModule([0, 502, 503, 504]);
  const observer = p.createAdmissionHelperObserver(m.cp, { ownerPid: OWNER });
  await observer.observe(async () => {
    await assert.rejects(p.createAdmissionHelperObserver(m.cp, { ownerPid: OWNER }).observe(async () => {}), /admission_helper_scope/);
    m.cp.spawn(SHAPES[0][0], [...SHAPES[0][1]], options(SHAPES[0][2]));
  });
  assert.equal(observer.record().invalid, true); assert.equal(m.cp.spawn, m.original);
  const n = fakeModule(), quiet = p.createAdmissionHelperObserver(n.cp, { ownerPid: OWNER });
  await quiet.observe(() => acquireAll(n.cp, child => child.emit("close", 0, null)));
  assert.equal(quiet.record().helpers.every((row: Helper) => row.exitObserved === false), true);
  const h = await run(), { evidence } = await phase3();
  assert.equal(h.attributeIngressAdmissionHelpers(evidence, { role: ROLE, ownerPid: OWNER,
    helpers: { ...quiet.record(), helpers: quiet.record().helpers.map((row: Helper, i: number) => ({ ...row, pid: HELPER + i })) } }), 0);
});

// F4: the sampled executable basename and parent must match the registered role in every sighting.
async function sightings(...samples: string[]) {
  const { h, evidence } = await phase3();
  for (const rows of samples) h.observeIngressInventory(evidence, { rootPid: OWNER, owner: ROLE, stage: "phase-3-running", result: sample(`${PARENT} 1 node\n${OWNER} ${PARENT} node\n${rows}`) });
  return { h, evidence };
}
for (const [name, rows, helpers] of [
  ["reused PID sampled later as another executable", [`${HELPER} ${OWNER} /usr/bin/python3\n`], record()],
  ["reused PID sampled later under another parent", [`202 ${OWNER} x\n${HELPER} 202 /usr/sbin/diskutil\n`], record()],
] as const) test(`attribution refuses: ${name}`, async () => {
  const { h, evidence } = await sightings(...rows);
  assert.equal(h.attributeIngressAdmissionHelpers(evidence, { role: ROLE, ownerPid: OWNER, helpers }), 0);
  assert.throws(() => h.assertIngressReopenOrigins(h.ingressProcessProof(evidence, ROLE, absent), OWNER, helpers), /reopen_process_origins/);
});
test("attribution refuses a registered role whose sampled executable differs", async () => {
  const { h, evidence } = await phase3(`${PARENT} 1 node\n${OWNER} ${PARENT} node\n${HELPER} ${OWNER} /usr/bin/lockf\n`);
  assert.equal(h.attributeIngressAdmissionHelpers(evidence, { role: ROLE, ownerPid: OWNER, helpers: record() }), 0);
});
test("attribution accepts repeated identical sightings and refuses after edge overflow", async () => {
  const { h, evidence } = await sightings(`${HELPER} ${OWNER} /usr/sbin/diskutil\n`);
  assert.equal(h.attributeIngressAdmissionHelpers(evidence, { role: ROLE, ownerPid: OWNER, helpers: record() }), 1);
  const o = await phase3(); o.evidence.directChildrenOverflow = true;
  assert.equal(o.h.attributeIngressAdmissionHelpers(o.evidence, { role: ROLE, ownerPid: OWNER, helpers: record() }), 0);
});

// F2: parent close-time wiring, through the record a real observer emits and the phase fact.
async function observedSummary(phase = 3) {
  const p = await provenance(), m = fakeModule([HELPER, 502, 503, 504]);
  const admission = p.createReopenAdmission({ closedGenerationReopen: true, phase }, { childProcessModule: m.cp, ownerPid: OWNER });
  await admission.acquire({ acquireApplicationOwnerLock: () => acquireAll(m.cp) }, "/synthetic-root");
  return JSON.parse(JSON.stringify(admission.attach({ success: true, phase, root: "/s", databasePath: "/s/db", observations: [], failures: [] })));
}
test("parent close proof attributes the observer's record for the reopen owner and passes the oracle", async () => {
  const { h, evidence } = await phase3(), result = h.ingressReopenPhaseFact(await observedSummary());
  const close = h.ingressOwnerCloseProof(evidence, { phasePlan: { closedGenerationReopen: true, phase: 3 }, role: ROLE, ownerPid: OWNER, result }, absent);
  assert.equal(close.failure, false);
  assert.deepEqual(close.ownerProcessProof.pids, [{ pid: OWNER, origins: [ROLE] }, { pid: HELPER, origins: [ROLE, TAG] }]);
});
for (const phasePlan of [{ closedGenerationReopen: true, phase: 2 }, { closedGenerationReopen: false, phase: 3 }, {}]) test(`parent close proof leaves ${JSON.stringify(phasePlan)} untouched`, async () => {
  const { h, evidence } = await phase3(), before = h.ingressProcessProof(evidence, ROLE, absent);
  const close = h.ingressOwnerCloseProof(evidence, { phasePlan, role: ROLE, ownerPid: OWNER, result: await observedSummary() }, absent);
  assert.equal(close.failure, false); assert.deepEqual(close.ownerProcessProof, before);
});
for (const [name, mutate] of [
  ["missing record", (r: Record<string, unknown>) => { delete r.admissionHelpers; }],
  ["record whose attribution throws", (r: Record<string, unknown>) => { (r.admissionHelpers as Record<string, unknown>).extra = 1; }],
] as const) test(`parent close proof fails the reopen owner on ${name}`, async () => {
  const { h, evidence } = await phase3(), result = await observedSummary(); mutate(result);
  const close = h.ingressOwnerCloseProof(evidence, { phasePlan: { closedGenerationReopen: true, phase: 3 }, role: ROLE, ownerPid: OWNER, result }, absent);
  assert.equal(close.failure, true);
  assert.deepEqual(close.ownerProcessProof.pids.map((row: { origins: string[] }) => row.origins), [[ROLE], [ROLE]]);
});

// Entry seam: the record exists only for reopen phase 3, and spawn is untouched otherwise.
test("entry admission observes only the reopen owner and restores spawn", async () => {
  const p = await provenance(), h = await run();
  const summary = await observedSummary(3);
  const fact = h.ingressAdmissionHelperFact(summary.admissionHelpers);
  assert.deepEqual(fact.helpers.map((row: Helper) => [row.role, row.pid, row.exitObserved, row.closeObserved, row.code]),
    [["volume_inspection", HELPER, true, true, 0], ["filesystem_extract", 502, true, true, 0], ["mount_extract", 503, true, true, 0], ["owner_lock", 504, true, true, 0]]);
  for (const plan of [{ closedGenerationReopen: true, phase: 2 }, { phase: 3 }]) {
    const m = fakeModule(); let seen: unknown;
    const admission = p.createReopenAdmission(plan, { childProcessModule: m.cp, ownerPid: OWNER });
    const owner = { close() {} };
    assert.equal(await admission.acquire({ acquireApplicationOwnerLock: async (root: string) => { assert.equal(root, "/r"); seen = m.cp.spawn; return owner; } }, "/r"), owner);
    assert.equal(seen, m.original); const base = { success: true }; assert.equal(admission.attach(base), base);
  }
});

// F3: the observer's call shapes are pinned to the real owner-lock source.
function lockShapes(source: string) {
  const constants = Object.fromEntries([...source.matchAll(/^const ([A-Z_]+) = "([^"]+)";$/gm)].map(m => [m[1], m[2]]));
  const items = (list: string) => list.split(",").map(item => item.trim()).filter(Boolean);
  return [...source.matchAll(/runHelper\(\{\s*executable: ([A-Z_]+),\s*args: \[([^\]]*)\],\s*stdio: \[([^\]]*)\],/g)].map(m => ({
    executable: constants[m[1]!] ?? `unknown:${m[1]}`,
    args: items(m[2]!).map(x => /^"[^"]*"$/.test(x) ? JSON.parse(x) : x === "mountPoint" ? null : `unknown:${x}`),
    stdio: items(m[3]!).map(x => /^"[^"]*"$/.test(x) ? JSON.parse(x) : x === "state.lockFd" ? "fd" : `unknown:${x}`),
  }));
}
test("observer helper shapes match the real application owner lock source", async () => {
  const p = await provenance(), source = readFileSync(path.join(import.meta.dirname, "../src/adapters/application-owner-lock.ts"), "utf8");
  assert.deepEqual(lockShapes(source), p.ADMISSION_HELPER_SHAPES);
  assert.equal(source.match(/runHelper\(\{/g)?.length, 4);
  assert.equal(source.match(/\bspawn\(/g)?.length, 1);
  assert.match(source, /childProcess\.spawn\(options\.executable, options\.args, \{\s*stdio: options\.stdio,\s*env: \{\},\s*shell: false,\s*detached: false,\s*\}\)/);
  assert.match(source, /^import childProcess, \{[^}]*\} from "node:child_process";$/m);
  // The pin is sensitive: a changed argument, executable or added helper breaks it.
  assert.notDeepEqual(lockShapes(source.replace('"info", "-plist"', '"info", "-xml"')), p.ADMISSION_HELPER_SHAPES);
  assert.notDeepEqual(lockShapes(source.replace('const PLUTIL = "/usr/bin/plutil"', 'const PLUTIL = "/opt/plutil"')), p.ADMISSION_HELPER_SHAPES);
  assert.notDeepEqual(lockShapes(source.replace('stdio: ["ignore", "ignore", "ignore", state.lockFd]', 'stdio: ["ignore", "ignore", "pipe", state.lockFd]')), p.ADMISSION_HELPER_SHAPES);
});
