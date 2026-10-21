import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { normalizeInvite } from "../src/ports/feishu-ingress.ts";
import { envelope,scope } from "./lib/feishu-fixtures.ts";
test("invite operator retries one blocked organizer durably and never touches the joined session",()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),"invite-operator-")),filename=path.join(dir,"db");
  const run=(...args:string[])=>spawnSync(process.execPath,[path.resolve("src/operator.ts"),...args],{encoding:"utf8",timeout:3000});
  const invite=normalizeInvite(envelope(),scope);
  try{
    const store=openSessionStore({filename});store.acceptInvite(invite,1);
    store.failInviteClaim(store.claimInviteMetadata(2)!,{status:"blocked",reason:"reference_missing",retryable:false},3,1000);store.close();
    assert.equal(run("invite-metadata-status","--db",filename,"--occurrence",invite.occurrenceId).status,0);
    const args=["invite-metadata-retry","--db",filename,"--occurrence",invite.occurrenceId,"--operator","human"];
    assert.equal(run(...args).stdout.trim(),"pending");assert.equal(run(...args).stdout.trim(),"already_pending");
    const reopened=openSessionStore({filename});assert.equal(reopened.getInviteOccurrence(invite.occurrenceId)?.retryGeneration,1);
    reopened.createSession({occurrenceId:invite.occurrenceId,providerMeetingId:invite.providerMeetingId,occurrenceStartedAt:invite.occurrenceStartedAt,nowMs:4});reopened.close();
    assert.equal(run(...args).stdout.trim(),"already_pending","the organizer lane is independent of the session");
    const after=openSessionStore({filename});
    try{assert.equal(after.getSession(invite.occurrenceId)?.state,"discovered");assert.equal(after.listTransitions(invite.occurrenceId).length,1);}finally{after.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("invite status shows a refused meeting and its reason",()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),"invite-refused-")),filename=path.join(dir,"db");
  const run=(...args:string[])=>spawnSync(process.execPath,[path.resolve("src/operator.ts"),...args],{encoding:"utf8",timeout:3000});
  const invite=normalizeInvite(envelope(),scope);
  try{
    const store=openSessionStore({filename});store.acceptInvite(invite,1);store.admitInviteJoin(invite.occurrenceId,2,"inviter_not_allowed");store.close();
    const result=run("invite-metadata-status","--db",filename,"--occurrence",invite.occurrenceId);
    assert.equal(result.status,0);
    assert.deepEqual(JSON.parse(result.stdout).join,{session:null,terminalReason:null,refusal:"inviter_not_allowed",allowed:false});
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("operator requires exact generation and explicit inspected-idle assertion before audited clear", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "custody-operator-")), filename = path.join(dir, "orchestration.db");
  const binding = { physicalClientId: "slot", physicalGenerationId: "a".repeat(32), occurrenceId: "meeting@2026-09-02T14:00:00Z", bridgeSessionId: "session" };
  const run = (...args: string[]) => spawnSync(process.execPath, [path.resolve("src/operator.ts"), ...args], { encoding: "utf8", timeout: 3000 });
  try {
    const missing = path.join(dir, "absent.db");
    assert.equal(run("physical-client-clear", "--db", missing).status, 2);
    assert.equal(existsSync(missing), false);
    const store = openSessionStore({ filename }); store.claimPhysicalClient(binding, 1); store.close();
    const args = ["physical-client-clear", "--db", filename, "--slot", "slot", "--generation", binding.physicalGenerationId, "--operator", "human"];
    assert.equal(run(...args).status, 2);
    assert.equal(run(...args, "--assert-inspected-idle").status, 0);
    assert.equal(run(...args, "--assert-inspected-idle").status, 2);
    const status = run("physical-client-status", "--db", filename);
    assert.equal(status.status, 0);
    const rows = JSON.parse(status.stdout);
    assert.equal(rows[0].state, "cleared"); assert.equal(rows[0].clearOperator, "human");
    assert.equal(rows[0].clearReason, "operator_inspected_idle");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
