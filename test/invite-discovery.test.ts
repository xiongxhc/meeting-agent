import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { normalizeInvite } from "../src/ports/feishu-ingress.ts";
import { createInviteDiscovery } from "../src/sessions/invite-discovery.ts";

export const scope = { region: "feishu" as const, tenantKey: "tenant", appId: "cli_0123456789abcdef" };
export function envelope(eventId = "event", id = "9007199254740993", topic = "Synthetic meeting") {
  return { schema: "2.0", header: { event_id: eventId, event_type: "vc.bot.meeting_invited_v1", app_id: scope.appId,
    tenant_key: scope.tenantKey, create_time: "1788357600000" }, event: {
    meeting: { id, meeting_no: "900000001", topic, start_time: "1788357600" }, invite_time: "1788357601", call_id: "call" } };
}

test("invite normalization preserves original identity/seconds and rejects collisions and bounds", () => {
  const value = normalizeInvite(envelope(), scope);
  assert.equal(value.occurrenceId, "9007199254740993@2026-09-02T14:00:00Z");
  assert.equal(value.providerMeetingId, "9007199254740993");
  assert.equal("unexpected" in normalizeInvite(envelope(),{...scope,unexpected:"CANARY"} as typeof scope),false);
  for (const raw of [
    { ...envelope(), schema: "1.0" },
    { ...envelope(), event: { ...envelope().event, app_id: "spoof" } },
    { ...envelope(), header: { ...envelope().header, tenant_key: "other" } },
    { ...envelope(), event: { ...envelope().event, meeting: { ...envelope().event.meeting, start_time: "1788357600000" } } },
    envelope("e".repeat(1025)), envelope("e", "m", "x".repeat(4097)),
    { ...envelope(), header: { ...envelope().header, create_time: "1788357600\n" } },
  ]) assert.throws(() => normalizeInvite(raw, scope), /invalid_invite/);
});

test("bounded counters stop visibly; retry replay cannot reset an already claimed generation",()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),"invite-counters-")),filename=path.join(dir,"db");
  const store=openSessionStore({filename}),raw=new Database(filename),invite=normalizeInvite(envelope(),scope);
  try{
    store.acceptInvite(invite,1);const claim=store.claimInviteMetadata(2)!;
    store.failInviteClaim(claim,{status:"blocked",reason:"reference_missing",retryable:false},3,1000);
    raw.prepare("UPDATE feishu_invite_occurrences SET total_attempts=1000000 WHERE occurrence_id=?").run(invite.occurrenceId);
    assert.equal(store.retryInviteMetadata(invite.occurrenceId,"human",4),"counter_exhausted");
    assert.equal(store.getInviteOccurrence(invite.occurrenceId)?.state,"metadata_blocked");
    assert.equal(store.getInviteOccurrence(invite.occurrenceId)?.lastBlockedReason,"counter_exhausted");
    raw.prepare("UPDATE feishu_invite_occurrences SET total_attempts=1 WHERE occurrence_id=?").run(invite.occurrenceId);
    assert.equal(store.retryInviteMetadata(invite.occurrenceId,"human",5),"pending");
    const current=store.claimInviteMetadata(6)!;
    assert.equal(store.retryInviteMetadata(invite.occurrenceId,"human",7),"already_pending");
    assert.equal(store.getInviteOccurrence(invite.occurrenceId)?.claimToken,current.claimToken);
    assert.equal(store.getInviteOccurrence(invite.occurrenceId)?.retryGeneration,1);
  }finally{raw.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test("durable references reject extra payload and SQL cannot admit incomplete organizer metadata",()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),"invite-reference-")),filename=path.join(dir,"db");
  const store=openSessionStore({filename}),raw=new Database(filename),invite=normalizeInvite(envelope(),scope);
  try{
    store.acceptInvite(invite,1);const claim=store.claimInviteMetadata(2)!;
    const reference={...resolved().reference,unexpected:"CANARY"};
    assert.throws(()=>store.completeInviteClaim(claim,{...resolved(),reference},3),/invalid_invite_reference/);
    assert.throws(()=>raw.prepare("UPDATE feishu_invite_occurrences SET state='admitted',claim_token=NULL,claim_expires_at_ms=NULL,admitted_at_ms=3,organizer_source='reservation',reference_json='{}' WHERE occurrence_id=?").run(invite.occurrenceId));
    assert.equal(store.getSession(invite.occurrenceId),null);
  }finally{raw.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test("actual SQLite invite replay is atomic across handles/reopen and retains first title", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "invite-journal-")), filename = path.join(dir, "db");
  const first = openSessionStore({ filename }), second = openSessionStore({ filename });
  const invite = normalizeInvite(envelope(), scope);
  try {
    assert.equal(first.acceptInvite(invite, 1), "accepted");
    assert.equal(second.acceptInvite(invite, 2), "replay");
    assert.throws(() => second.acceptInvite(normalizeInvite(envelope("event", invite.providerMeetingId, "changed"), scope), 3), /invite_conflict/);
    assert.equal(second.acceptInvite(normalizeInvite(envelope("other", invite.providerMeetingId, "changed"), scope), 3), "existing_occurrence");
    assert.equal(first.getInviteOccurrence(invite.occurrenceId)?.title, "Synthetic meeting");
    const claim = first.claimInviteMetadata(4)!;
    assert.equal(second.claimInviteMetadata(4), null);
    second.failInviteClaim(claim, { status: "blocked", reason: "reference_missing", retryable: false }, 5, 1000);
    assert.equal(first.getInviteOccurrence(invite.occurrenceId)?.state, "metadata_blocked");
    assert.equal(first.retryInviteMetadata(invite.occurrenceId, "operator", 6), "pending");
    assert.equal(second.retryInviteMetadata(invite.occurrenceId, "operator", 7), "already_pending");
    const next = second.claimInviteMetadata(8)!;
    assert.throws(() => first.completeInviteClaim(claim, resolved(), 9), /invite_claim_fenced/);
    second.completeInviteClaim(next, resolved(), 9);
    assert.equal(first.getSession(invite.occurrenceId)?.state, "discovered");
    assert.equal(first.listTransitions(invite.occurrenceId).length, 1);
    assert.throws(() => first.retryInviteMetadata(invite.occurrenceId, "operator", 10), /invite_retry_fenced/);
  } finally { first.close(); second.close(); }
  const reopened = openSessionStore({ filename });
  try {
    const row = reopened.getInviteOccurrence(invite.occurrenceId)!;
    assert.equal(row.state, "admitted"); assert.equal(row.totalAttempts, 2); assert.equal(row.retryGeneration, 1);
    assert.equal(row.lastBlockedReason, "reference_missing"); assert.equal(row.organizer?.id, "ou_creator");
    assert.equal(reopened.acceptInvite(invite, 11), "replay");
  } finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

export function resolved() {
  return { status: "resolved" as const, organizer: { ...scope, idType: "open_id" as const, id: "ou_creator", displayName: "Creator", source: "reservation" as const },
    reference: { kind: "reservation" as const, reserveId: "reserve" } };
}

test("blocked work counts toward256; harmless replay works at capacity; DB failure rolls both rows back", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "invite-bound-")), filename = path.join(dir, "db");
  const store = openSessionStore({ filename }), other = openSessionStore({ filename }), raw = new Database(filename);
  try {
    for (let i = 0; i < 256; i++) {
      store.acceptInvite(normalizeInvite(envelope(`e${i}`, `m${i}`), scope), 1);
      const claim = store.claimInviteMetadata(2)!;
      store.failInviteClaim(claim, { status: "blocked", reason: "reference_missing", retryable: false }, 3, 1000);
    }
    assert.throws(() => other.acceptInvite(normalizeInvite(envelope("overflow", "overflow"), scope), 4), /invite_capacity/);
    assert.equal(other.acceptInvite(normalizeInvite(envelope("e0", "m0"), scope), 4), "replay");
    raw.exec("CREATE TRIGGER fail_invite BEFORE INSERT ON feishu_invite_events BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
    assert.throws(() => other.acceptInvite(normalizeInvite(envelope("new-event", "m0"), scope), 4));
    assert.equal((raw.prepare("SELECT count(*) AS n FROM feishu_invite_events").get() as { n: number }).n, 256);
  } finally { raw.close(); store.close(); other.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("discovery retries within budget and refuses new ticks after close", async () => {
  const store=openSessionStore({filename:":memory:"}); let now=1,attempts=0;
  store.acceptInvite(normalizeInvite(envelope(),scope),now);
  const worker=createInviteDiscovery({store,now:()=>now,jitter:()=>0,metadata:{async resolve(){attempts++;return {status:"blocked",reason:"metadata_unavailable",retryable:true};}}});
  try {
    for(let i=0;i<8;i++){assert.equal(await worker.runOnce(),true);now+=1000;}
    assert.equal(await worker.runOnce(),false);assert.equal(attempts,8);
    assert.equal(store.listInviteOccurrences()[0]?.state,"metadata_blocked");
    assert.equal(store.listInviteOccurrences()[0]?.lastBlockedReason,"retry_exhausted");
    assert.equal(await worker.close(),true);
    await assert.rejects(worker.runOnce(),/closed/);
  } finally {store.close();}
});

test("ten-minute generation horizon prevents a new attempt and an uncooperative metadata operation keeps cleanup unconfirmed",async()=>{
  const store=openSessionStore({filename:":memory:"}),invite=normalizeInvite(envelope(),scope);store.acceptInvite(invite,1);
  const claim=store.claimInviteMetadata(2)!;store.failInviteClaim(claim,{status:"blocked",reason:"timeout",retryable:true},3,1000);
  assert.equal(store.claimInviteMetadata(600002),null);assert.equal(store.getInviteOccurrence(invite.occurrenceId)?.lastBlockedReason,"retry_exhausted");
  assert.equal(store.getInviteOccurrence(invite.occurrenceId)?.totalAttempts,1);
  store.retryInviteMetadata(invite.occurrenceId,"human",600003);
  let release!:(value:ReturnType<typeof resolved>)=>void;
  const held=new Promise<ReturnType<typeof resolved>>((resolve)=>{release=resolve;});
  const worker=createInviteDiscovery({store,now:()=>600004,attemptBudgetMs:20,closeBudgetMs:5,metadata:{resolve:()=>held}});
  try{
    assert.equal(await worker.runOnce(),true);await assert.rejects(worker.runOnce(),/busy/);
    assert.equal(await worker.close(),false);assert.equal(store.getSession(invite.occurrenceId),null);
    release(resolved());await held;assert.equal(await worker.close(),true);assert.equal(store.getSession(invite.occurrenceId),null);
  }finally{release(resolved());await held;await worker.close();store.close();}
});

test("close aborts the owned metadata operation, waits settlement and persists failure before DB closes",async()=>{
  const store=openSessionStore({filename:":memory:"});store.acceptInvite(normalizeInvite(envelope(),scope),1);
  let entered!:()=>void;const held=new Promise<void>((resolve)=>{entered=resolve;});let settled=false;
  const worker=createInviteDiscovery({store,now:()=>2,metadata:{async resolve(_row,signal){entered();await new Promise<void>((resolve)=>signal.addEventListener("abort",()=>{setTimeout(resolve,5);},{once:true}));settled=true;return {status:"blocked",reason:"cancelled",retryable:true};}}});
  const work=worker.runOnce();await held;await assert.rejects(worker.runOnce(),/busy/);
  assert.equal(await worker.close(),true);assert.equal(settled,true);await work;
  assert.equal(store.listInviteOccurrences()[0]?.claimToken,null);store.close();
});

test("SQLite completion is atomic with session creation and existing terminal sessions never rejoin",()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),"invite-atomic-")),filename=path.join(dir,"db");
  const store=openSessionStore({filename}),raw=new Database(filename),invite=normalizeInvite(envelope(),scope);
  try{
    store.acceptInvite(invite,1);const claim=store.claimInviteMetadata(2)!;
    raw.exec("CREATE TRIGGER fail_admit BEFORE UPDATE OF admitted_at_ms ON feishu_invite_occurrences BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    assert.throws(()=>store.completeInviteClaim(claim,resolved(),3));assert.equal(store.getSession(invite.occurrenceId),null);assert.equal(store.listTransitions(invite.occurrenceId).length,0);
    raw.exec("DROP TRIGGER fail_admit");
    store.createSession({occurrenceId:invite.occurrenceId,providerMeetingId:invite.providerMeetingId,occurrenceStartedAt:invite.occurrenceStartedAt,nowMs:3});
    raw.prepare("UPDATE sessions SET state='failed',terminal_reason='bridge_failure' WHERE occurrence_id=?").run(invite.occurrenceId);
    store.completeInviteClaim(claim,resolved(),4);assert.equal(store.getInviteOccurrence(invite.occurrenceId)?.state,"existing_session");
    assert.equal(store.getSession(invite.occurrenceId)?.state,"failed");assert.equal(store.listTransitions(invite.occurrenceId).length,1);
    assert.throws(()=>store.retryInviteMetadata(invite.occurrenceId,"human",5),/invite_retry_fenced/);
  }finally{raw.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test("expired claims fence stale completion and clock regression blocks without new attempt",()=>{
  const store=openSessionStore({filename:":memory:"});store.acceptInvite(normalizeInvite(envelope(),scope),1);
  try {
    const first=store.claimInviteMetadata(100)!; const next=store.claimInviteMetadata(30100)!;
    assert.notEqual(first.claimToken,next.claimToken);
    assert.throws(()=>store.completeInviteClaim(first,resolved(),30101),/invite_claim_fenced/);
    store.failInviteClaim(next,{status:"blocked",reason:"timeout",retryable:true},30101,1000);
    assert.equal(store.claimInviteMetadata(30000),null);
    assert.equal(store.listInviteOccurrences()[0]?.lastBlockedReason,"clock_regression");
    assert.equal(store.listInviteOccurrences()[0]?.totalAttempts,2);
  }finally{store.close();}
});

test("metadata completion refuses missing reference identity and cannot create a session",()=>{
  const store=openSessionStore({filename:":memory:"});store.acceptInvite(normalizeInvite(envelope(),scope),1);
  try{
    const claim=store.claimInviteMetadata(2)!;
    assert.throws(()=>store.completeInviteClaim(claim,{...resolved(),reference:{kind:"reservation",reserveId:""}},3),/invalid_invite/);
    assert.equal(store.getSession(claim.occurrenceId),null);
  }finally{store.close();}
});
