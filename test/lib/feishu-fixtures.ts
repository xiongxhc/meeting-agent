import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { once } from "node:events";
import { defaultHttpInstance } from "@larksuiteoapi/node-sdk";
export const scope = { region: "feishu" as const, tenantKey: "tenant", appId: "cli_0123456789abcdef" };
export function envelope(eventId = "event", id = "9007199254740993", topic = "Synthetic meeting") {
  return { schema: "2.0", header: { event_id: eventId, event_type: "vc.bot.meeting_invited_v1", app_id: scope.appId,
    tenant_key: scope.tenantKey, create_time: "1788357600000" }, event: {
    meeting: { id, meeting_no: "900000001", topic, start_time: "1788357600" }, invite_time: "1788357601", call_id: "call" } };
}

// Local peer fixture follows published1.74.0 pbbp2.Frame/Header field numbers;
// no production codec, SDK private import or arbitrary protobuf implementation.
function integer(value:number):Buffer {const bytes:number[]=[];do{let b=value&127;value=Math.floor(value/128);if(value)b|=128;bytes.push(b);}while(value);return Buffer.from(bytes);}
function field(index:number,value:Buffer):Buffer{return Buffer.concat([integer(index*8+2),integer(value.length),value]);}
export function eventFrame(raw:unknown,messageId="message"):Buffer {
  const headers=Object.entries({message_id:messageId,sum:"1",seq:"0",type:"event",trace_id:"synthetic"}).map(([key,value])=>
    field(5,Buffer.concat([field(1,Buffer.from(key)),field(2,Buffer.from(value))])));
  return Buffer.concat([Buffer.from([8,1,16,1,24,1,32,1]),...headers,field(8,Buffer.from(JSON.stringify(raw)))]);
}
export function framePayload(buffer:Buffer):unknown {
  let at=0;
  const read=()=>{let n=0,shift=0,b:number;do{b=buffer[at++]!;n+=(b&127)*2**shift;shift+=7;}while(b&128);return n;};
  while(at<buffer.length){const tag=read();if((tag&7)===0){read();continue;}if((tag&7)!==2)throw new Error("fixture_wire");const length=read();const bytes=buffer.subarray(at,at+length);at+=length;if(tag>>>3===8)return JSON.parse(bytes.toString());}
  return null;
}
export async function httpPeer(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{
  server: Server; origin: string; request: typeof defaultHttpInstance.request; close(): Promise<void>;
}> {
  const server = createServer(handler);
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture_address");
  const origin = `http://127.0.0.1:${address.port}`;
  const request: typeof defaultHttpInstance.request = (options) => {
    const url = new URL(options.url!);
    return defaultHttpInstance.request({ ...options, url: origin + url.pathname + url.search, proxy: false });
  };
  return { server, origin, request, async close() {
    server.closeAllConnections(); const closed = once(server,"close"); server.close(); await closed;
  } };
}
