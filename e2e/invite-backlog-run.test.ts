import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { createRequire } from "node:module";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { normalizeInvite } from "../src/ports/feishu-ingress.ts";
import { replayNeedsJoinDecision } from "../src/ports/session-store.ts";
import { createInviteDiscovery } from "../src/sessions/invite-discovery.ts";
const modulePath = path.resolve(import.meta.dirname, "invite-backlog-run.mjs");
async function runner() { assert.ok(existsSync(modulePath), "selected backlog campaign helper must exist"); return import(modulePath); }
// @ts-expect-error Private peer JavaScript has no declaration.
const peer = await import("./feishu-peer.mjs");
function fixture() { const root = realpathSync(mkdtempSync(path.join(tmpdir(), "meeting-backlog-component-"))); chmodSync(root, 0o700); return { root, databasePath: path.join(root, "state.db") }; }

// Feishu's invite_time in the plan is 1700000000 s; each arrival is an hour later, so only the later of the two
// keeps the invite fresh. The composition decides the join right after each commit (accept()): an allowlisted
// inviter is admitted with no organizer, and a replay finds the existing session.
const ARRIVAL = 1700003600000;
test("real store, allowlist admission and discovery admit256 without organizers, refuse257 without partial rows, ordinary reopen replays256 unchanged", async () => {
  const r = await runner(), f = fixture(); let store = openSessionStore({ filename: f.databasePath, nowMs: ARRIVAL }); chmodSync(f.databasePath, 0o600);
  const plan = r.createBacklogPlan(normalizeInvite, peer.inviteEnvelope, peer.SCOPE), statuses: string[] = [], decisions: string[] = [];
  const discovery = () => createInviteDiscovery({ store, metadata: { async resolve() { return { status: "blocked", reason: "reference_missing", retryable: false }; } }, now: () => ARRIVAL + 1000, jitter: () => 0 });
  let d = discovery();
  try {
    assert.ok(plan.every((p: { normalized: { inviterId?: string; inviteSeconds: string } }) => p.normalized.inviterId === peer.E2E_INVITER && Number(p.normalized.inviteSeconds) * 1000 + 600000 < ARRIVAL), "allowlisted inviter, Feishu time older than the stale window");
    for (let i = 0; i < 256; i++) { statuses.push(store.acceptInvite(plan[i].normalized, ARRIVAL)); decisions.push(store.admitInviteJoin(plan[i].normalized.occurrenceId, ARRIVAL)); assert.equal(await d.runOnce(), true); r.assertBacklogProjection(r.readBacklogProjection(f.databasePath), plan, i + 1); }
    const baseline = r.readBacklogProjection(f.databasePath); assert.equal(statuses.filter(s => s === "accepted").length, 256); assert.deepEqual(new Set(decisions), new Set(["admitted"]));
    assert.ok(plan.slice(0, 256).every((p: { normalized: { occurrenceId: string } }) => store.inviteJoinStatus(p.normalized.occurrenceId)?.allowed === true && store.getInviteOccurrence(p.normalized.occurrenceId)?.organizer === null));
    assert.throws(() => store.acceptInvite(plan[256].normalized, ARRIVAL), { message: "invite_capacity" }); assert.deepEqual(r.readBacklogProjection(f.databasePath), baseline);
    assert.equal(await d.close(), true); store.close(); store = openSessionStore({ filename: f.databasePath }); d = discovery();
    assert.deepEqual(r.readBacklogProjection(f.databasePath), baseline);
    for (let i = 0; i < 256; i++) { assert.equal(store.acceptInvite(plan[i].normalized, ARRIVAL + 2000), "replay"); assert.equal(replayNeedsJoinDecision(store.inviteJoinStatus(plan[i].normalized.occurrenceId)), false, "an admitted replay is not decided again"); assert.equal(await d.runOnce(), false); assert.deepEqual(r.readBacklogProjection(f.databasePath), baseline); }
    assert.throws(() => store.acceptInvite(plan[256].normalized, ARRIVAL + 2000), { message: "invite_capacity" }); assert.deepEqual(r.readBacklogProjection(f.databasePath), baseline);
  } finally { await d.close(); store.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("refused invites are recorded per invite and never fill the cap: 256 strangers, then 256 allowlisted, then the 257th refused", async () => {
  const r = await runner(), f = fixture(), store = openSessionStore({ filename: f.databasePath, nowMs: ARRIVAL }); chmodSync(f.databasePath, 0o600);
  const plan = r.createBacklogPlan(normalizeInvite, peer.inviteEnvelope, peer.SCOPE);
  try {
    for (let i = 0; i < 256; i++) {
      const raw = peer.inviteEnvelope({ eventId: `stranger-event-${i}`, providerMeetingId: `stranger-meeting-${i}`, meetingNo: String(800000000 + i), title: `Stranger ${i}`, startSeconds: 1700000000 + i, inviteSeconds: 1700000000, createTimeMs: 1700000000000 + i, inviterId: peer.E2E_STRANGER });
      const n = normalizeInvite(raw, peer.SCOPE); assert.equal(n.inviterId, peer.E2E_STRANGER);
      assert.equal(store.acceptInvite(n, ARRIVAL), "accepted"); assert.equal(store.admitInviteJoin(n.occurrenceId, ARRIVAL, "inviter_not_allowed"), "inviter_not_allowed");
      assert.deepEqual(store.inviteJoinStatus(n.occurrenceId), { session: null, terminalReason: null, refusal: "inviter_not_allowed", allowed: false });
    }
    for (let i = 0; i < 256; i++) { assert.equal(store.acceptInvite(plan[i].normalized, ARRIVAL), "accepted"); assert.equal(store.admitInviteJoin(plan[i].normalized.occurrenceId, ARRIVAL), "admitted"); }
    assert.throws(() => store.acceptInvite(plan[256].normalized, ARRIVAL), { message: "invite_capacity" });
  } finally { store.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("backlog lifecycle allowlist names the startup retention sweep and no other sweep outcome", async () => {
  const { BACKLOG_LOG_CODES } = await import(modulePath) as { BACKLOG_LOG_CODES: readonly string[] };
  assert.ok(Object.isFrozen(BACKLOG_LOG_CODES) && BACKLOG_LOG_CODES.includes("retention_swept"));
  assert.deepEqual(BACKLOG_LOG_CODES.filter(code => code.includes("retention")), ["retention_swept"]);
});
test("stale is judged on the later of Feishu invite_time and arrival", async () => {
  const f = fixture(), store = openSessionStore({ filename: f.databasePath, nowMs: ARRIVAL }); chmodSync(f.databasePath, 0o600);
  const invite = (eventId: string, id: string, inviteSeconds: number) => normalizeInvite(peer.inviteEnvelope({ eventId, providerMeetingId: id, meetingNo: "987654320", title: "Stale rule", startSeconds: 1700000000, inviteSeconds, createTimeMs: 1700000000000 }), peer.SCOPE);
  try {
    // Old Feishu time, fresh arrival: fresh.
    const oldFeishu = invite("old-feishu", "stale-a", 1700000000); store.acceptInvite(oldFeishu, ARRIVAL); assert.equal(store.admitInviteJoin(oldFeishu.occurrenceId, ARRIVAL + 599000), "admitted");
    // Old arrival, fresh Feishu time: fresh. Both old: stale, recorded on the row, no session.
    const freshFeishu = invite("fresh-feishu", "stale-b", (ARRIVAL + 300000) / 1000); store.acceptInvite(freshFeishu, ARRIVAL); assert.equal(store.admitInviteJoin(freshFeishu.occurrenceId, ARRIVAL + 899000), "admitted");
    const bothOld = invite("both-old", "stale-c", ARRIVAL / 1000); store.acceptInvite(bothOld, ARRIVAL); assert.equal(store.admitInviteJoin(bothOld.occurrenceId, ARRIVAL + 601000), "invite_stale");
    assert.deepEqual(store.inviteJoinStatus(bothOld.occurrenceId), { session: null, terminalReason: null, refusal: "invite_stale", allowed: false });
  } finally { store.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("selected receiver projection strips SDK bodies and fences getter/custom-prototype data", async () => {
  const r = await runner(), receiver = peer.createFeishuFrameReceiver("backlog-257");
  receiver.receive(peer.eventFrame({ code: 500, data: "private-SDK-body" }, "backlog-1-257"));
  assert.deepEqual(r.projectBacklogReceiver(receiver), { invalid: false, overflow: false, observations: [{ ordinal: 1, kind: "ack", messageId: "backlog-1-257", code: 500 }] });
  let calls = 0; const v = {}; Object.defineProperty(v, "secret", { enumerable: true, get() { calls++; return "private"; } });
  assert.throws(() => r.backlogData(v)); assert.equal(calls, 0); assert.throws(() => r.backlogData(Object.create({ inherited: true })));
});

test("deadline detects synchronous overrun after the effect returns", async () => { const r = await runner(); let t = 0; await assert.rejects(r.backlogDeadline(() => { t = 11; return true; }, 100, 10, () => t), /backlog_deadline/); });

test("reader refuses migration/schema drift and private filesystem substitution", async () => {
  const r = await runner(), f = fixture(), store = openSessionStore({ filename: f.databasePath }); chmodSync(f.databasePath, 0o600);
  try { const baseline = r.readBacklogProjection(f.databasePath); assert.equal(baseline.migrations.length, 31); const db = new Database(f.databasePath); db.prepare("UPDATE schema_migrations SET name='drift' WHERE version=30").run(); db.close(); assert.throws(() => r.readBacklogProjection(f.databasePath), /backlog_schema/); chmodSync(f.root, 0o755); assert.throws(() => r.readBacklogProjection(f.databasePath), /backlog_reader/); } finally { store.close(); rmSync(f.root, { recursive: true, force: true }); }
});

async function synthetic() {
  const r = await runner(), f = fixture(), store = openSessionStore({ filename: f.databasePath, nowMs: 1700000000000 }); chmodSync(f.databasePath, 0o600);
  const plan = r.createBacklogPlan(normalizeInvite, peer.inviteEnvelope, peer.SCOPE);
  for (let i = 0; i < 256; i++) { store.acceptInvite(plan[i].normalized, 1700000000000); assert.equal(store.admitInviteJoin(plan[i].normalized.occurrenceId, 1700000000000), "admitted"); const claim = store.claimInviteMetadata(1700000001000)!; store.failInviteClaim(claim, { status: "blocked", reason: "reference_missing", retryable: false }, 1700000001000, 1000); }
  const full = r.readBacklogProjection(f.databasePath); store.close(); rmSync(f.root, { recursive: true, force: true });
  const calls: string[] = [];
  const effects = { async beginOwner(owner: number) { calls.push(`owner${owner}`); const receiver = peer.createFeishuFrameReceiver("backlog-257"), commits: { wireId: string; ordinal: number; hash: string; ackFloor: number }[] = []; let admitted = 0;
    return { async ready() { return { admitted: true, started: true, connections: 1, endpoint200: true, receiverEmpty: true, commitEmpty: true, effectsZero: true }; },
      snapshot() { const mine = (id: string) => plan.slice(0, admitted).some((p: { normalized: { occurrenceId: string } }) => p.normalized.occurrenceId === id); return owner === 1 ? { ...full, occurrences: full.occurrences.slice(0, admitted).sort((a: { occurrence_id: string }, b: { occurrence_id: string }) => a.occurrence_id.localeCompare(b.occurrence_id)), events: full.events.filter((row: { event_id: string }) => plan.slice(0, admitted).some((p: { normalized: { eventId: string } }) => p.normalized.eventId === row.event_id)), sessions: full.sessions.filter((row: { occurrence_id: string }) => mine(row.occurrence_id)), transitions: full.transitions.filter((row: { occurrence_id: string }) => mine(row.occurrence_id)), counts: { ...full.counts, feishu_invite_occurrences: admitted, feishu_invite_events: admitted, sessions: admitted, transitions: admitted, sqlite_sequence: admitted > 0 ? 1 : 0 } } : full; },
      async deliver(index: number, wireId: string) { calls.push(wireId); if (index < 256) { admitted++; commits.push({ wireId, ordinal: commits.length + 1, hash: plan[index].normalized.normalizedSha256, ackFloor: receiver.observations.at(-1)?.ordinal ?? 0 }); } receiver.receive(peer.eventFrame({ code: index < 256 ? 200 : 500 }, wireId)); return { receiver: r.projectBacklogReceiver(receiver), commits: [...commits] }; },
      async settled() { return this.snapshot(); },
      async close() { calls.push(`close${owner}`); return { projection: this.snapshot(), receiver: r.projectBacklogReceiver(receiver), commits: [...commits], close: { memoized: true, fulfilled: true, unchanged: true, clean: true, httpActive: 0, httpSockets: 0, httpPending: 0, wsSockets: 0, wsPending: 0, peerConnections: 0, exit: 0, failures: [], lifecycle: [{ code: "occurrence_launched", ordinal: 1 }, ...r.BACKLOG_CLOSE_CODES.map((code: string, i: number) => ({ code, ordinal: i + 2 }))] } }; },
    }; } };
  return { r, plan, full, effects, calls };
}
test("finite controller correlates514 explicit decoded replies and512 commit facts across two clean owners", async () => {
  const s = await synthetic(), result = await s.r.runBacklogCampaign(s.effects, { plan: s.plan, sources: s.r.componentBacklogSources() }); assert.equal(result.success, true); assert.equal(result.label, "component-facts"); assert.equal(result.deliveries.length, 514); assert.equal(result.closes.length, 2);
  assert.throws(() => s.r.validateBacklogResult({ ...result, label: "attempted-application" })); assert.throws(() => s.r.validateBacklogResult({ ...result, raw: "private" }));
});

test("coherent full-state sensitivities reject identity, missing/extra/partial rows, clocks, claims and every downstream table", async () => {
  const s = await synthetic();
  const mutate = (name: string, change: (v: typeof s.full) => void) => { const v = structuredClone(s.full); change(v); assert.throws(() => s.r.assertBacklogProjection(v, s.plan, 256, s.full), /backlog_/, name); };
  mutate("missing255", v => { v.occurrences.pop(); v.events.pop(); v.counts.feishu_invite_occurrences--; v.counts.feishu_invite_events--; });
  mutate("hidden257", v => { v.occurrences.push({ ...v.occurrences[0] }); v.counts.feishu_invite_occurrences++; });
  mutate("partial event", v => { v.events.pop(); v.counts.feishu_invite_events--; });
  for (const [field, value] of Object.entries({ region: "lark", tenant_key: "foreign", app_id: "cli_ffffffffffffffff", title: "wrong", occurrence_started_at: "2023-01-01T00:00:00Z", accepted_at_ms: 1700000000001, last_observed_at_ms: 1700000000001, first_attempt_at_ms: 1700000001001, last_attempt_at_ms: 1700000001001, generation_started_at_ms: 1700000001001, next_attempt_at_ms: 1700000001001, last_blocked_at_ms: 1700000001001, total_attempts: 2, claim_token: "f".repeat(32), claim_expires_at_ms: 1700000002000, organizer_open_id: "claimed", reference_json: "{}" })) mutate(field, v => { v.occurrences[0][field] = value; });
  mutate("hash", v => { v.events[0].normalized_sha256 = "f".repeat(64); });
  for (const table of Object.keys(s.full.counts).filter(t => !["schema_migrations", "feishu_invite_events", "feishu_invite_occurrences"].includes(t))) mutate(table, v => { v.counts[table] = s.full.counts[table] + 1; });
  // Allowlist admission: one discovered, allowed session per invite; no organizer is needed for it.
  mutate("missing session", v => { v.sessions.pop(); v.counts.sessions--; });
  mutate("missing decision", v => { v.transitions.pop(); v.counts.transitions--; });
  for (const [field, value] of Object.entries({ state: "joining", terminal_reason: "join_failed", provider_meeting_id: "other", updated_at_ms: 1700000009999 })) mutate(`session ${field}`, v => { v.sessions[0][field] = value; });
  for (const [field, value] of Object.entries({ reason: null, from_state: "discovered", to_state: "failed", occurred_at_ms: 1700000009999 })) mutate(`decision ${field}`, v => { v.transitions[0][field] = value; });
  mutate("organizer resolved", v => { v.occurrences[0].state = "admitted"; v.occurrences[0].last_blocked_reason = null; });
  mutate("refused instead", v => { v.occurrences[0].last_blocked_reason = "inviter_not_allowed"; });
});

test("coherent decoded history sensitivities reject wrong codes, wires, duplicates, ordering and commits", async () => {
  const s = await synthetic(), current = await s.effects.beginOwner(1); let previous;
  for (let i = 0; i < 257; i++) { const raw = await current.deliver(i, s.r.backlogWire(1, i)); const value = { owner: 1, index: i, wireId: s.r.backlogWire(1, i), ...raw }; previous = s.r.assertBacklogDelivery(value, 1, i, s.plan, previous); }
  const good = previous; assert.ok(good);
  for (const kind of ["overflow200", "replay500", "wrong_wire", "duplicate", "reordered", "stale", "rejected_commit", "missing_commit", "changed_hash", "late", "invalid", "overflow", "commit_after_ack"]) { const v = structuredClone(good); if (kind === "overflow200") v.receiver.observations[256].code = 200; if (kind === "replay500") v.receiver.observations[1].code = 500; if (kind === "wrong_wire") v.receiver.observations[4].messageId = "backlog-2-5"; if (kind === "duplicate") v.receiver.observations[4].messageId = v.receiver.observations[3].messageId; if (kind === "reordered") [v.receiver.observations[3], v.receiver.observations[4]] = [v.receiver.observations[4], v.receiver.observations[3]]; if (kind === "stale") v.receiver.observations[4].ordinal = 1; if (kind === "rejected_commit") v.commits.push({ ...v.commits[255], wireId: "backlog-1-257", ordinal: 257 }); if (kind === "missing_commit") v.commits.pop(); if (kind === "changed_hash") v.commits[0].hash = "b".repeat(64); if (kind === "late") v.receiver.observations.push({ ...v.receiver.observations[256], ordinal: 258 }); if (kind === "invalid") v.receiver.invalid = true; if (kind === "overflow") v.receiver.overflow = true; if (kind === "commit_after_ack") v.commits[0].ackFloor = 1; assert.throws(() => s.r.assertBacklogDelivery(v, 1, 256, s.plan), /backlog_/, kind); }
});

test("source ordered closure refuses every missing/duplicate/reordered fence and current nonzero owners", async () => {
  const s = await synthetic(), current = await s.effects.beginOwner(1), closed = await current.close(), good = closed.close;
  s.r.assertBacklogClose(good);
  for (const code of s.r.BACKLOG_CLOSE_CODES) { const missing = structuredClone(good); missing.lifecycle = missing.lifecycle.filter((row: { code: string }) => row.code !== code); assert.throws(() => s.r.assertBacklogClose(missing)); const duplicate = structuredClone(good); duplicate.lifecycle.push({ code, ordinal: 16 }); assert.throws(() => s.r.assertBacklogClose(duplicate)); }
  for (const field of ["httpActive", "httpSockets", "httpPending", "wsSockets", "wsPending", "peerConnections", "exit"]) assert.throws(() => s.r.assertBacklogClose({ ...good, [field]: 1 }));
  for (const field of ["memoized", "fulfilled", "unchanged", "clean"]) assert.throws(() => s.r.assertBacklogClose({ ...good, [field]: false }));
  const reordered = structuredClone(good); [reordered.lifecycle[10].code, reordered.lifecycle[11].code] = [reordered.lifecycle[11].code, reordered.lifecycle[10].code]; assert.throws(() => s.r.assertBacklogClose(reordered));
  const unlaunched = structuredClone(good); unlaunched.lifecycle = unlaunched.lifecycle.filter((row: { code: string }) => row.code !== "occurrence_launched"); assert.throws(() => s.r.assertBacklogClose(unlaunched), /backlog_close/);
  const relaunched = structuredClone(good); relaunched.lifecycle.push({ code: "occurrence_launched", ordinal: 16 }); assert.throws(() => s.r.assertBacklogClose(relaunched), /backlog_close/);
});

test("controller does not acquire owner2 after refused readiness or unconfirmed cleanup", async () => {
  const s = await synthetic(), original = s.effects.beginOwner; s.effects.beginOwner = async owner => { const current = await original(owner); current.ready = async () => ({ admitted: true, started: true, connections: 1, endpoint200: true, receiverEmpty: false, commitEmpty: true, effectsZero: true }); return current; };
  const result = await s.r.runBacklogCampaign(s.effects, { plan: s.plan, sources: s.r.componentBacklogSources() }); assert.equal(result.success, false); assert.ok(result.failures.includes("backlog_ready")); assert.ok(!s.calls.includes("owner2")); assert.ok(s.calls.includes("close1"));
});

test("finite source qualification catches project, generated migration and actual native-role drift", async () => {
  const r = await runner();
  // @ts-expect-error Private entry JavaScript has no declaration.
  const entry = await import("./invite-backlog-entry.mjs");
  const repository = path.resolve(import.meta.dirname, ".."), qualified = entry.qualifyBacklogSources(repository);
  assert.ok(qualified.roles.some((row: { path: string }) => row.path === "dependencies/sqlite/native-binding"));
  assert.deepEqual(entry.assertBacklogSourceQualification(repository, qualified), qualified);
  const owned = fixture(), require = createRequire(import.meta.url), sqliteRoot = path.dirname(path.dirname(require.resolve("better-sqlite3"))), native = require(path.join(sqliteRoot, "lib/binding.js")).getPrebuildPath();
  try {
    const copy = (from: string, to: string) => { mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 }); copyFileSync(from, to); chmodSync(to, 0o600); };
    for (const row of qualified.roles.filter((row: { path: string }) => !row.path.startsWith("dependencies/"))) copy(path.join(repository, row.path), path.join(owned.root, row.path));
    mkdirSync(path.join(owned.root, "node_modules/@larksuiteoapi"), { recursive: true, mode: 0o700 });
    symlinkSync(path.dirname(path.dirname(require.resolve("@larksuiteoapi/node-sdk"))), path.join(owned.root, "node_modules/@larksuiteoapi/node-sdk"));
    symlinkSync(path.dirname(require.resolve("ws")), path.join(owned.root, "node_modules/ws"));
    const ownedSqlite = path.join(owned.root, "node_modules/better-sqlite3");
    for (const row of qualified.roles.filter((row: { path: string }) => row.path.startsWith("dependencies/sqlite/") && row.path !== "dependencies/sqlite/native-binding")) { const rel = row.path.slice("dependencies/sqlite/".length); copy(path.join(sqliteRoot, rel), path.join(ownedSqlite, rel)); }
    copy(native, path.join(ownedSqlite, path.relative(sqliteRoot, native)));
    const baseline = entry.qualifyBacklogSources(owned.root); assert.deepEqual(baseline, qualified);
    for (const rel of ["e2e/feishu-peer.mjs", "dist/migrations/020_feishu_invite_discovery.sql", path.join("node_modules/better-sqlite3", path.relative(sqliteRoot, native))]) { const filename = path.join(owned.root, rel), original = readFileSync(filename); writeFileSync(filename, Buffer.concat([original, Buffer.from("\ncomponent drift")])); assert.throws(() => entry.assertBacklogSourceQualification(owned.root, baseline), /backlog_sources/); writeFileSync(filename, original); }
  } finally { rmSync(owned.root, { recursive: true, force: true }); }
  assert.equal(r.componentBacklogSources().base, qualified.base);
});

test("closed failed reports reject private strings and canonical identities as well as output injection", async () => {
  const s = await synthetic(), original = s.effects.beginOwner; s.effects.beginOwner = async owner => { const c = await original(owner); c.ready = async () => ({ admitted: false, started: false, connections: 0, endpoint200: false, receiverEmpty: true, commitEmpty: true, effectsZero: true }); return c; };
  const result = await s.r.runBacklogCampaign(s.effects, { plan: s.plan, sources: s.r.componentBacklogSources() });
  assert.equal(result.success, false); assert.equal(result.closes.length, 1);
  for (const [field, value] of Object.entries({ state: "private", last_blocked_reason: "private", title: "private", claim_token: "private-token", organizer_open_id: "private" })) { const v = { ...result, currentSnapshot: structuredClone(s.full) }; v.currentSnapshot.occurrences[0][field] = value; assert.throws(() => s.r.validateBacklogResult(v)); }
  for (const [rows, field] of [["sessions", "state"], ["sessions", "terminal_reason"], ["transitions", "reason"]] as const) { const v = { ...result, currentSnapshot: structuredClone(s.full) }; v.currentSnapshot[rows][0][field] = "private"; assert.throws(() => s.r.validateBacklogResult(v)); }
  let calls = 0; const getter = { ...result }; Object.defineProperty(getter, "failures", { enumerable: true, get() { calls++; return []; } }); assert.throws(() => s.r.validateBacklogResult(getter)); assert.equal(calls, 0);
});

test("initial full-state audit rejects a changed session or join decision before any baseline is captured", async () => {
  const s = await synthetic();
  for (const [rows, field, value] of [["sessions", "updated_at_ms", 1700000009999], ["sessions", "created_at_ms", 1699999999999], ["transitions", "occurred_at_ms", 1700000009999]] as const) {
    const changed = structuredClone(s.full); changed[rows][0][field] = value; assert.throws(() => s.r.assertBacklogProjection(changed, s.plan, 256), /backlog_durable/, `${rows}.${field}`);
  }
  const swapped = structuredClone(s.full); [swapped.sessions[0].occurrence_id, swapped.sessions[1].occurrence_id] = [swapped.sessions[1].occurrence_id, swapped.sessions[0].occurrence_id];
  assert.throws(() => s.r.assertBacklogProjection(swapped, s.plan, 256), /backlog_/);
});

test("initial full-state audit rejects changed next-attempt clock before any baseline is captured", async () => {
  const s = await synthetic(), changed = structuredClone(s.full); changed.occurrences[0].next_attempt_at_ms++;
  assert.throws(() => s.r.assertBacklogProjection(changed, s.plan, 256), /backlog_durable/);
});

for (const settleMetadata of [false, true]) test(`deadline after actual durable admission retains latest readonly state and decoded partial history (${settleMetadata ? "blocked" : "pending"})`, async () => {
  const r = await runner(), f = fixture(), store = openSessionStore({ filename: f.databasePath, nowMs: 1700000000000 }); chmodSync(f.databasePath, 0o600);
  const plan = r.createBacklogPlan(normalizeInvite, peer.inviteEnvelope, peer.SCOPE), receiver = peer.createFeishuFrameReceiver("backlog-257"), commits: { wireId: string; ordinal: number; hash: string; ackFloor: number }[] = [], calls: number[] = [];
  const discovery = createInviteDiscovery({ store, metadata: { async resolve() { return { status: "blocked", reason: "reference_missing", retryable: false }; } }, now: () => 1700000001000, jitter: () => 0 });
  const empty = r.readBacklogProjection(f.databasePath); let time = 0, closed = false;
  try {
    const effects = { beginOwner(owner: number) { calls.push(owner); return {
      async ready() { return { admitted: true, started: true, connections: 1, endpoint200: true, receiverEmpty: true, commitEmpty: true, effectsZero: true }; }, snapshot() { return r.readBacklogProjection(f.databasePath); },
      async deliver(index: number, wireId: string) { assert.equal(index, 0); assert.equal(store.acceptInvite(plan[index].normalized, 1700000000000), "accepted"); assert.equal(store.admitInviteJoin(plan[index].normalized.occurrenceId, 1700000000000), "admitted"); if (settleMetadata) assert.equal(await discovery.runOnce(), true); const observed = r.readBacklogProjection(f.databasePath); commits.push({ wireId, ordinal: 1, hash: observed.events[0].normalized_sha256, ackFloor: 0 }); receiver.receive(peer.eventFrame({ code: 200 }, wireId)); time = 10001; throw new Error("backlog_deadline"); }, async settled() { throw new Error("must_not_settle"); },
      async close() { assert.equal(await discovery.close(), true); store.close(); closed = true; return { projection: r.readBacklogProjection(f.databasePath), receiver: r.projectBacklogReceiver(receiver), commits: [...commits], close: { memoized: true, fulfilled: true, unchanged: true, clean: true, httpActive: 0, httpSockets: 0, httpPending: 0, wsSockets: 0, wsPending: 0, peerConnections: 0, exit: 0, failures: [], lifecycle: r.BACKLOG_CLOSE_CODES.map((code: string, i: number) => ({ code, ordinal: i + 1 })) } }; },
    }; } };
    const result = await r.runBacklogCampaign(effects, { plan, sources: r.componentBacklogSources(), now: () => time });
    assert.equal(result.success, false); assert.equal(result.label, "component-facts"); assert.equal(result.failures[0], "backlog_deadline"); assert.equal(result.admitted, 1); assert.notDeepEqual(result.currentSnapshot, empty);
    assert.equal(result.currentSnapshot.counts.feishu_invite_occurrences, 1); assert.equal(result.currentSnapshot.counts.feishu_invite_events, 1); assert.equal(result.currentSnapshot.occurrences[0].state, settleMetadata ? "metadata_blocked" : "pending_metadata"); assert.equal(result.currentSnapshot.occurrences[0].total_attempts, settleMetadata ? 1 : 0); assert.equal(result.currentSnapshot.sessions[0].state, "discovered"); assert.equal(result.currentSnapshot.transitions[0].reason, "invite_allowed"); assert.deepEqual(result.currentSnapshot, r.readBacklogProjection(f.databasePath));
    assert.equal(result.deliveries.length, 0); assert.equal(result.closes.length, 1); assert.equal(result.closes[0].receiver.observations[0].code, 200); assert.equal(result.closes[0].commits.length, 1); assert.deepEqual(calls, [1]);
  } finally { if (!closed) { await discovery.close(); store.close(); } rmSync(f.root, { recursive: true, force: true }); }
});
