import assert from "node:assert/strict";
import { test } from "node:test";
import { RedactedSecret } from "../src/config.ts";
import { createFeishuOrganizerMetadata } from "../src/adapters/feishu-organizer-metadata.ts";
import { createFeishuSdkHttp } from "../src/adapters/feishu-sdk-http.ts";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { normalizeInvite } from "../src/ports/feishu-ingress.ts";
import { scope, envelope, httpPeer } from "./lib/feishu-fixtures.ts";
import { Agent } from "node:http";
import { createFeishuSocketOwner } from "../src/adapters/feishu-sdk-connection.ts";

test("real SDK reservation reads require exact active occurrence before reserve/contact; never bot join", async () => {
  for (const mode of ["ok", "mismatch", "denied", "missing_id", "missing_display"] as const) {
    const calls: string[] = [];
    const peer = await httpPeer((req,res) => {
      const url = new URL(req.url!, "http://fixture"); calls.push(url.pathname);
      res.setHeader("content-type","application/json");
      if (url.pathname.endsWith("/tenant_access_token/internal")) { res.end(JSON.stringify({code:0,tenant_access_token:"synthetic-token",expire:7200})); return; }
      assert.equal(req.method,"GET"); assert.equal(url.searchParams.get("user_id_type"),"open_id");
      if (mode === "denied") { res.writeHead(403); res.end("{}"); return; }
      if (url.pathname.endsWith("/get_active_meeting")) {
        assert.equal(url.searchParams.get("with_participants"),"false");
        res.end(JSON.stringify({code:0,data:{meeting:{id:mode === "mismatch" ? "wrong":"9007199254740993",meeting_no:"900000001",start_time:"1788357600"}}}));
      } else if (url.pathname.endsWith("/reserves/reserve")) res.end(JSON.stringify({code:0,data:{reserve:{id:"reserve",meeting_no:"900000001",reserve_user_id:mode === "missing_id" ? undefined:"ou_creator",host_user:{id:"ou_host"}}}}));
      else if (url.pathname.endsWith("/users/ou_creator")) res.end(JSON.stringify({code:0,data:{user:{open_id:"ou_creator",name:mode === "missing_display" ? undefined:"Creator"}}}));
      else { res.writeHead(404); res.end("{}"); }
    });
    const http = createFeishuSdkHttp({ request: peer.request, connection:createFeishuSocketOwner(Agent) });
    const store = openSessionStore({filename:":memory:"}); store.acceptInvite(normalizeInvite(envelope(),scope),1);
    const adapter = createFeishuOrganizerMetadata({ ...scope, appSecret:new RedactedSecret("synthetic-secret"), http,
      references:[{...scope,meetingNo:"900000001",reference:{kind:"reservation",reserveId:"reserve"}}] });
    try {
      const result = await adapter.resolve(store.listInviteOccurrences()[0]!,new AbortController().signal);
      if (mode === "ok") {
        assert.equal(result.status,"resolved"); if (result.status === "resolved") { assert.equal(result.organizer.id,"ou_creator"); assert.equal(result.organizer.idType,"open_id"); }
        assert.deepEqual(calls.filter((p)=>!p.includes("/auth/")),["/open-apis/vc/v1/reserves/reserve/get_active_meeting","/open-apis/vc/v1/reserves/reserve","/open-apis/contact/v3/users/ou_creator"]);
      } else {
        assert.equal(result.status,"blocked");
        if (mode === "mismatch" || mode === "denied") assert.equal(calls.filter((p)=>!p.includes("/auth/")).length,1);
      }
      assert.ok(calls.every((p)=>!p.includes("/bots/")));
    } finally { await http.close(); store.close(); await peer.close(); }
  }
});

test("missing reference is blocked, never instant, and never performs HTTP", async () => {
  const http = createFeishuSdkHttp({request:async()=>{throw new Error("must_not_call");}});
  const adapter = createFeishuOrganizerMetadata({...scope,appSecret:new RedactedSecret("synthetic"),http,references:[]});
  const store = openSessionStore({filename:":memory:"}); store.acceptInvite(normalizeInvite(envelope(),scope),1);
  try { assert.deepEqual(await adapter.resolve(store.listInviteOccurrences()[0]!,new AbortController().signal),{status:"blocked",reason:"reference_missing",retryable:false}); }
  finally { await http.close(); store.close(); }
});

test("owned SDK HTTP timeout aborts actual socket work and close waits for settlement", async () => {
  let disconnected!:()=>void; const disconnection = new Promise<void>((resolve)=>{disconnected=resolve;});
  const peer = await httpPeer((req)=>{ req.on("close",disconnected); });
  const http = createFeishuSdkHttp({request:peer.request,timeoutMs:30,connection:createFeishuSocketOwner(Agent)});
  try {
    await assert.rejects(http.instance.get("https://open.feishu.cn/synthetic"), /feishu_http_timeout/);
    await disconnection; assert.equal(http.activeCount,0);
    await http.close(); await assert.rejects(http.instance.get("https://open.feishu.cn/synthetic"),/feishu_http_closed/);
  } finally { await http.close(); await peer.close(); }
});

test("calendar GET requires exact occurrence/event and actual organizer, not host/recurrence guesses",async()=>{
  for(const mode of ["ok","wrong_event","recurrence","conflict","missing_display"]){
    const peer=await httpPeer((req,res)=>{
      const url=new URL(req.url!,"http://fixture");res.setHeader("content-type","application/json");
      if(url.pathname.includes("/auth/")){res.end(JSON.stringify({code:0,tenant_access_token:"synthetic",expire:7200}));return;}
      assert.equal(req.method,"GET");assert.equal(url.pathname,"/open-apis/calendar/v4/calendars/calendar/events/event");assert.equal(url.searchParams.get("user_id_type"),"open_id");
      res.end(JSON.stringify({code:0,data:{event:{event_id:mode==="wrong_event"?"wrong":"event",start_time:{timestamp:"1788357000"},end_time:{timestamp:"1788361200"},
        recurrence:mode==="recurrence"?"FREQ=DAILY":"",event_organizer:{user_id:"ou_calendar",display_name:mode==="missing_display"?undefined:"Calendar creator"},
        host_user:{id:"ou_host"},attendees:[{id:"ou_inviter",is_organizer:true}]}}}));
    });
    const store=openSessionStore({filename:":memory:"}),invite=normalizeInvite(envelope(),scope);store.acceptInvite(invite,1);
    const http=createFeishuSdkHttp({request:peer.request,connection:createFeishuSocketOwner(Agent)});
    const adapter=createFeishuOrganizerMetadata({...scope,appSecret:new RedactedSecret("synthetic"),http,references:[{...scope,meetingNo:invite.meetingNo,reference:{
      kind:"calendar_event",calendarId:"calendar",eventId:"event",occurrenceId:invite.occurrenceId,providerMeetingId:invite.providerMeetingId,
      occurrenceStartedAt:invite.occurrenceStartedAt,...(mode==="conflict"?{vcOrganizerOpenId:"ou_other"}:{})}}]});
    try{
      const result=await adapter.resolve(store.listInviteOccurrences()[0]!,new AbortController().signal);
      assert.equal(result.status,mode==="ok"?"resolved":"blocked");
      if(result.status === "resolved"){assert.equal(result.organizer.id,"ou_calendar");assert.equal(result.organizer.source,"calendar_event");}
    }finally{await http.close();store.close();await peer.close();}
  }
});
