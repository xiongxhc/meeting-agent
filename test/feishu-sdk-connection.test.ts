import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, type ClientRequestArgs } from "node:http";
import { PassThrough, type Duplex } from "node:stream";
import { setTimeout as pause } from "node:timers/promises";
import { createFeishuSocketOwner } from "../src/adapters/feishu-sdk-connection.ts";

test("public agent tracks pending callback creation and destroys late sockets before handing them back",async()=>{
  let finish!:()=>void;let late!:PassThrough;
  class Delayed extends Agent {
    override createConnection(_options:ClientRequestArgs,callback?:(err:Error|null,socket:Duplex)=>void):undefined {
      finish=()=>{late=new PassThrough();callback?.(null,late);};return undefined;
    }
  }
  const owner=createFeishuSocketOwner(Delayed);let callbackError:Error|null=null,live=false;
  owner.agent.createConnection({},(error,stream)=>{callbackError=error;live=!stream.destroyed;});
  assert.equal(owner.pendingCount,1);let ended=false;
  const closing=owner.close(200).then((clean)=>{ended=true;return clean;});
  await pause(5);assert.equal(ended,false);assert.throws(()=>owner.agent.createConnection({}),/fenced/);
  finish();assert.equal(await closing,true);assert.equal(live,false);assert.ok(callbackError);
  assert.equal(late.closed,true);assert.equal(owner.activeCount,0);
});

test("an unreturned creation stays explicitly unclean at the cleanup deadline",async()=>{
  class NeverReturns extends Agent {override createConnection():undefined{return undefined;}}
  const owner=createFeishuSocketOwner(NeverReturns);owner.agent.createConnection({});
  assert.equal(await owner.close(5),false);assert.equal(owner.pendingCount,1);
});
