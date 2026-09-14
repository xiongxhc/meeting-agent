import assert from "node:assert/strict";
import { test } from "node:test";
import { OriginalEnvelopeDispatcher, createFeishuInviteIngress } from "../src/adapters/feishu-invite-ingress.ts";
import { envelope, scope, httpPeer, eventFrame, framePayload } from "./lib/feishu-fixtures.ts";
import { WebSocketServer, type WebSocket } from "ws";
import { once } from "node:events";
import { setTimeout as pause } from "node:timers/promises";
import { RedactedSecret } from "../src/config.ts";
import { createFeishuSdkHttp } from "../src/adapters/feishu-sdk-http.ts";
import { openSessionStore } from "../src/adapters/sqlite-session-store.ts";
import { Agent } from "node:http";
import type { Duplex } from "node:stream";
import { createFeishuSocketOwner } from "../src/adapters/feishu-sdk-connection.ts";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

async function until(check:()=>boolean):Promise<void>{
  const deadline=performance.now()+1000;
  while(!check()){if(performance.now()>=deadline)throw new Error("fixture_condition_timeout");await pause(1);}
}

test("actual dispatcher must reject header/event identity collision before acceptance", async () => {
  let accepted = false;
  const dispatcher = new OriginalEnvelopeDispatcher(scope,async()=>{accepted=true;});
  const raw = envelope();
  await assert.rejects(dispatcher.invoke({...raw,event:{...raw.event,app_id:"spoof"}},{needCheck:false}));
  assert.equal(accepted,false);
});

test("real SDK websocket ACK follows commit, errors are500, and upgraded connection is reaped", async () => {
  const logs:string[]=[];
  const peer=await httpPeer((_req,res)=>{res.setHeader("content-type","application/json");res.end(JSON.stringify({code:0,data:{
    URL:peer.origin.replace("http:","ws:")+"/ws?device_id=synthetic&service_id=1",ClientConfig:{PingInterval:100,ReconnectCount:1,ReconnectInterval:0,ReconnectNonce:0}}}));});
  const server=new WebSocketServer({server:peer.server,perMessageDeflate:false,maxPayload:65536});
  const connected=once(server,"connection");
  let release!:()=>void;const gate=new Promise<void>((resolve)=>{release=resolve;});
  let entered!:()=>void;const accepted=new Promise<void>((resolve)=>{entered=resolve;});
  const dir=mkdtempSync(path.join(os.tmpdir(),"invite-ack-")),filename=path.join(dir,"db");
  const store=openSessionStore({filename}),raw=new Database(filename),http=createFeishuSdkHttp({request:peer.request,connection:createFeishuSocketOwner(Agent)});
  const ingress=createFeishuInviteIngress({...scope,appSecret:new RedactedSecret("CANARY_SECRET"),http,log:(code)=>logs.push(code),
    accept:async(invite)=>{entered();await gate;store.acceptInvite(invite,1);},connection:createFeishuSocketOwner(Agent),readyTimeoutMs:1000,handshakeTimeoutMs:100});
  try {
    await ingress.start();assert.equal(ingress.status,"ready");
    const [socket]=await connected as [WebSocket];
    const responses:unknown[]=[];socket.on("message",(bytes)=>{const payload=framePayload(Buffer.from(bytes as Buffer));if(payload)responses.push(payload);});
    socket.send(eventFrame(envelope()));await accepted;await pause(10);
    assert.deepEqual(responses,[]);assert.equal(store.listInviteOccurrences().length,0);
    release();await until(()=>responses.length>=1);
    assert.deepEqual(responses[0],{code:200});assert.equal(store.listInviteOccurrences().length,1);
    socket.send(eventFrame({...envelope(),event:{...envelope().event,app_id:"CANARY_COLLISION"}},"bad"));
    await until(()=>responses.length>=2);assert.deepEqual(responses[1],{code:500});
    raw.exec("CREATE TRIGGER reject_event BEFORE INSERT ON feishu_invite_events BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    socket.send(eventFrame(envelope("db-failure","other"),"db-failure"));
    await until(()=>responses.length>=3);assert.deepEqual(responses[2],{code:500});
    assert.equal(store.listInviteOccurrences().length,1);
    const closed=once(socket,"close");
    const result=await ingress.close();await closed;
    assert.deepEqual(result,{clean:true,reason:"closed"});
    assert.ok(logs.every((line)=>line.startsWith("feishu_sdk_")&&!line.includes("CANARY")));
    await assert.rejects(ingress.dispatcher.invoke(envelope(),{needCheck:false}),/closed/);
  }finally{release();await ingress.close();for(const socket of server.clients)socket.terminate();await new Promise<void>((resolve)=>server.close(()=>resolve()));raw.close();store.close();await peer.close();rmSync(dir,{recursive:true,force:true});}
});

test("overlapping actual dispatcher invokes retain original provenance and await each acceptance", async () => {
  const seen:string[]=[]; let release!:()=>void;
  const held=new Promise<void>((resolve)=>{release=resolve;});
  const dispatcher=new OriginalEnvelopeDispatcher(scope,async(invite)=>{
    if(invite.eventId==="first") await held;
    seen.push(invite.eventId+":"+invite.providerMeetingId);
  });
  const first=dispatcher.invoke(envelope("first","m1"),{needCheck:false});
  await dispatcher.invoke(envelope("second","m2"),{needCheck:false});
  assert.deepEqual(seen,["second:m2"]); assert.equal(dispatcher.pendingCount,1);
  dispatcher.fence(); await assert.rejects(dispatcher.invoke(envelope("late"),{needCheck:false}),/closed/);
  release(); await first; await dispatcher.drain(); assert.deepEqual(seen,["second:m2","first:m1"]);
});

test("33rd paused acceptance is rejected without a queue and close drains the32 owned callbacks",async()=>{
  let release!:()=>void;const gate=new Promise<void>((resolve)=>{release=resolve;});let count=0;
  const dispatcher=new OriginalEnvelopeDispatcher(scope,async()=>{count++;await gate;});
  const pending=Array.from({length:32},(_,i)=>dispatcher.invoke(envelope(`event${i}`),{needCheck:false}));
  const safety=setTimeout(release,100);
  try {
    await assert.rejects(dispatcher.invoke(envelope("excess"),{needCheck:false}),/invite_acceptance_busy/);
    clearTimeout(safety);
    assert.equal(count,32);dispatcher.fence();let drained=false;const drain=dispatcher.drain().then(()=>{drained=true;});
    await pause(5);assert.equal(drained,false);release();await drain;assert.equal(dispatcher.pendingCount,0);
  }finally{clearTimeout(safety);release();await Promise.allSettled(pending);}
});

test("actual SDK close during endpoint discovery or handshake fences late readiness and reaps owned sockets",async()=>{
  for(const mode of ["endpoint","handshake"] as const){
    let reached!:()=>void;const held=new Promise<void>((resolve)=>{reached=resolve;});
    const peer=await httpPeer((_req,res)=>{
      if(mode === "endpoint"){reached();return;}
      res.setHeader("content-type","application/json");res.end(JSON.stringify({code:0,data:{URL:peer.origin.replace("http:","ws:")+"/ws?service_id=1",ClientConfig:{PingInterval:100,ReconnectCount:1,ReconnectInterval:0,ReconnectNonce:0}}}));
    });
    let serverSocket:Duplex|undefined;
    peer.server.on("upgrade",(_req,socket)=>{serverSocket=socket;socket.on("end",()=>socket.destroy());socket.resume();reached();});
    const connection=createFeishuSocketOwner(Agent),httpConnection=createFeishuSocketOwner(Agent);
    const http=createFeishuSdkHttp({request:peer.request,connection:httpConnection});
    const ingress=createFeishuInviteIngress({...scope,appSecret:new RedactedSecret("synthetic"),http,connection,accept:()=>{throw new Error("late_acceptance");},readyTimeoutMs:500,handshakeTimeoutMs:100});
    const started=ingress.start().then(()=>"ready",()=>"rejected");
    try{
      await held;assert.equal(ingress.status,"degraded");
      const closed=serverSocket ? once(serverSocket,"close"):Promise.resolve();
      assert.deepEqual(await ingress.close(),{clean:true,reason:"closed"});await closed;
      assert.equal(await started,"rejected");assert.equal(connection.activeCount,0);assert.equal(httpConnection.activeCount,0);
      await pause(120);assert.equal(ingress.status,"closed");assert.equal(connection.pendingCount,0);
    }finally{await ingress.close();serverSocket?.destroy();await peer.close();}
  }
});

test("actual SDK reconnect is degraded until the new connection is ready",async()=>{
  let requests=0,release:(()=>void)|undefined;
  const peer=await httpPeer((_req,res)=>{
    const send=()=>{res.setHeader("content-type","application/json");res.end(JSON.stringify({code:0,data:{URL:peer.origin.replace("http:","ws:")+"/ws?service_id=1",ClientConfig:{PingInterval:100,ReconnectCount:2,ReconnectInterval:0,ReconnectNonce:0}}}));};
    requests++;if(requests===2)release=send;else send();
  });
  const server=new WebSocketServer({server:peer.server});
  const connection=createFeishuSocketOwner(Agent),http=createFeishuSdkHttp({request:peer.request,connection:createFeishuSocketOwner(Agent)});
  const ingress=createFeishuInviteIngress({...scope,appSecret:new RedactedSecret("synthetic"),http,connection,accept:()=>{},readyTimeoutMs:500,handshakeTimeoutMs:100});
  try{
    await ingress.start();assert.equal(ingress.status,"ready");for(const socket of server.clients)socket.terminate();
    await until(()=>release!==undefined);assert.equal(ingress.status,"degraded");const resume=release;release=undefined;resume!();
    await until(()=>ingress.status==="ready");
    assert.equal(requests,2);assert.deepEqual(await ingress.close(),{clean:true,reason:"closed"});assert.equal(connection.activeCount,0);
  }finally{release?.();await ingress.close();for(const socket of server.clients)socket.terminate();await new Promise<void>((resolve)=>server.close(()=>resolve()));await peer.close();}
});

test("close after actual ready callback but before its deferred status check cannot resurrect readiness",async()=>{
  const peer=await httpPeer((_req,res)=>{res.setHeader("content-type","application/json");res.end(JSON.stringify({code:0,data:{URL:peer.origin.replace("http:","ws:")+"/ws?service_id=1",ClientConfig:{PingInterval:100,ReconnectCount:1,ReconnectInterval:0,ReconnectNonce:0}}}));});
  const server=new WebSocketServer({server:peer.server});const connection=createFeishuSocketOwner(Agent);
  const http=createFeishuSdkHttp({request:peer.request,connection:createFeishuSocketOwner(Agent)});
  let didClose=false;
  // In1.74.0 the final fixed-code info log follows onReady synchronously.
  const ingress=createFeishuInviteIngress({...scope,appSecret:new RedactedSecret("synthetic"),http,connection,accept:()=>{},readyTimeoutMs:500,handshakeTimeoutMs:100,
    log:(code)=>{if(code==="feishu_sdk_info"&&connection.activeCount>0&&!didClose){didClose=true;void ingress.close();}}});
  try{await assert.rejects(ingress.start(),/closed/);await pause(1);assert.equal(didClose,true);assert.equal(ingress.status,"closed");assert.deepEqual(await ingress.close(),{clean:true,reason:"closed"});}
  finally{await ingress.close();for(const socket of server.clients)socket.terminate();await new Promise<void>((resolve)=>server.close(()=>resolve()));await peer.close();}
});

test("ready deadline rejects a held real endpoint request and close awaits its cancellation",async()=>{
  const peer=await httpPeer(()=>{}),connection=createFeishuSocketOwner(Agent),httpConnection=createFeishuSocketOwner(Agent);
  const http=createFeishuSdkHttp({request:peer.request,connection:httpConnection});
  const ingress=createFeishuInviteIngress({...scope,appSecret:new RedactedSecret("synthetic"),http,connection,accept:()=>{},readyTimeoutMs:30});
  try{await assert.rejects(ingress.start(),/ready_timeout/);assert.equal(ingress.status,"failed");
    assert.deepEqual(await ingress.close(),{clean:true,reason:"closed"});assert.equal(httpConnection.activeCount,0);
  }finally{await ingress.close();await peer.close();}
});

test("close timeout never claims cleanup while acceptance is still owned",async()=>{
  let release!:()=>void;const held=new Promise<void>((resolve)=>{release=resolve;});
  const http=createFeishuSdkHttp();
  const ingress=createFeishuInviteIngress({...scope,appSecret:new RedactedSecret("synthetic"),http,accept:()=>held,closeTimeoutMs:10});
  const work=ingress.dispatcher.invoke(envelope(),{needCheck:false});
  try{assert.deepEqual(await ingress.close(),{clean:false,reason:"cleanup_timeout"});
    await assert.rejects(ingress.dispatcher.invoke(envelope(),{needCheck:false}),/closed/);
  }finally{release();await work;await ingress.dispatcher.drain();await http.close();}
});
