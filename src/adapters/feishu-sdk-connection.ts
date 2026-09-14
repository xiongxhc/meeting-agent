import { Agent as HttpAgent, type ClientRequestArgs } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { Duplex } from "node:stream";

/** Public Agent hook, not SDK internals. Production uses normal HTTPS/TLS;
 * an injected base agent is reserved for controlled local transports. */
export function createFeishuSocketOwner(Base: typeof HttpAgent = HttpsAgent) {
  let closed=false,creating=0;
  const sockets=new Set<Duplex>(),waiters=new Set<()=>void>();
  const notify=()=>{for(const wake of waiters)wake();};
  function track(socket:Duplex):void {
    if(sockets.has(socket)||socket.closed)return;
    sockets.add(socket);
    // agentRemove on upgrade must NOT release this ownership.
    socket.once("close",()=>{sockets.delete(socket);notify();});
    if(closed)socket.destroy();
  }
  class OwnedAgent extends Base {
    override createConnection(options:ClientRequestArgs,callback?:(error:Error|null,stream:Duplex)=>void):Duplex|null|undefined {
      if(closed||creating+sockets.size>=4)throw new Error("feishu_connection_fenced");
      creating++;let pending=true;
      const settled=()=>{if(pending){pending=false;creating--;notify();}};
      try {
        const socket=super.createConnection(options,(error,stream)=>{
          if(stream)track(stream);settled();
          if(closed){stream?.destroy();callback?.(new Error("feishu_connection_fenced"),stream);}
          else callback?.(error,stream);
        });
        if(socket){track(socket);settled();}
        return socket;
      }catch{settled();throw new Error("feishu_connection_failed");}
    }
  }
  const agent=new OwnedAgent({keepAlive:false,maxSockets:4,maxTotalSockets:4});
  return {agent,get activeCount(){return sockets.size;},get pendingCount(){return creating;},
    fence():void{closed=true;},
    close(timeoutMs=7000):Promise<boolean>{
      closed=true;agent.destroy();for(const socket of sockets)socket.destroy();
      return new Promise((resolve)=>{
        const done=()=>{if(creating===0&&sockets.size===0){clearTimeout(timer);waiters.delete(done);resolve(true);}};
        const timer=setTimeout(()=>{waiters.delete(done);resolve(false);},timeoutMs);
        waiters.add(done);done();
      });
    },
  };
}
export type FeishuSocketOwner=ReturnType<typeof createFeishuSocketOwner>;
