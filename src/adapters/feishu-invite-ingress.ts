import { AsyncLocalStorage } from "node:async_hooks";
import { EventDispatcher, WSClient, Domain } from "@larksuiteoapi/node-sdk";
import type { RedactedSecret } from "../config.ts";
import { normalizeInvite, validateFeishuScope, INVITE_EVENT, type FeishuScope, type NormalizedInvite } from "../ports/feishu-ingress.ts";
import { redactedFeishuLogger, type FeishuSdkHttp } from "./feishu-sdk-http.ts";
import { createFeishuSocketOwner, type FeishuSocketOwner } from "./feishu-sdk-connection.ts";

/** Preserves the nested provider header before the official dispatcher flattens it. */
export class OriginalEnvelopeDispatcher extends EventDispatcher {
  readonly #context = new AsyncLocalStorage<NormalizedInvite>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #scope: FeishuScope;
  #closed = false;
  constructor(scope: FeishuScope, accept: (invite:NormalizedInvite)=>void|Promise<void>, log?: (code:string)=>void) {
    validateFeishuScope(scope);
    super({logger:redactedFeishuLogger(log)});
    this.#scope = {region:scope.region,tenantKey:scope.tenantKey,appId:scope.appId};
    this.register({[INVITE_EVENT]:async(flat)=>{
      if (this.#closed) throw new Error("invite_ingress_closed");
      const original = this.#context.getStore();
      if (!original) throw new Error("invite_provenance_missing");
      const value = flat as typeof flat & {schema?:unknown};
      const projected = normalizeInvite({schema:value.schema,header:{event_id:value.event_id,event_type:value.event_type,app_id:value.app_id,
        tenant_key:value.tenant_key,create_time:value.create_time},event:{meeting:value.meeting,invite_time:value.invite_time,call_id:value.call_id}},this.#scope);
      if (projected.normalizedSha256 !== original.normalizedSha256) throw new Error("invite_provenance_mismatch");
      await accept(original); // Resolves only after durable commit; errors reach the real SDK failure ACK.
    }});
  }
  override async invoke(raw: unknown, params?: {needCheck?:boolean}): Promise<unknown> {
    if (this.#closed) throw new Error("invite_ingress_closed");
    if (this.#pending.size >= 32) throw new Error("invite_acceptance_busy");
    const normalized = normalizeInvite(raw,this.#scope);
    const pending = this.#context.run(normalized,()=>super.invoke(raw,params));
    this.#pending.add(pending);
    try { return await pending; } finally { this.#pending.delete(pending); }
  }
  fence(): void { this.#closed=true; }
  async drain(): Promise<void> { await Promise.allSettled([...this.#pending]); }
  get pendingCount(): number { return this.#pending.size; }
}

export function createFeishuInviteIngress(options: FeishuScope & {
  readonly appSecret: RedactedSecret; readonly http: FeishuSdkHttp;
  readonly accept: (invite:NormalizedInvite)=>void|Promise<void>;
  readonly stopWorker?: ()=>Promise<boolean>; readonly log?: (code:string)=>void;
  readonly connection?: FeishuSocketOwner;
  readonly readyTimeoutMs?: number; readonly handshakeTimeoutMs?: number; readonly closeTimeoutMs?: number;
}) {
  validateFeishuScope(options);
  // Published WSClient.start otherwise only logs and resolves an invalid App ID.
  if (!/^cli_[0-9a-fA-F]{16}$/.test(options.appId)) throw new Error("invalid_invite_scope");
  const readyMs = options.readyTimeoutMs ?? 15000, handshakeMs = options.handshakeTimeoutMs ?? 5000, closeMs = options.closeTimeoutMs ?? 7000;
  if (!Number.isInteger(readyMs)||readyMs<1||readyMs>15000||!Number.isInteger(handshakeMs)||handshakeMs<1||handshakeMs>5000||!Number.isInteger(closeMs)||closeMs<1||closeMs>7000) throw new Error("invalid_ingress_budget");
  const dispatcher = new OriginalEnvelopeDispatcher(options,options.accept,options.log);
  const connection=options.connection ?? createFeishuSocketOwner();
  let closed=false,started=false,ready=false,failed=false;
  let resolveReady:(()=>void)|undefined,rejectReady:((error:Error)=>void)|undefined;
  let readyTimer:ReturnType<typeof setTimeout>|undefined;
  const connected = () => {
    // Published onReconnected fires before isConnecting is cleared. Recheck
    // after that SDK stack finishes; a callback alone is never readiness.
    queueMicrotask(()=>{
      if (closed) return;
      ready = sdk.getConnectionStatus().state === "connected";
      if (ready) { if (readyTimer) clearTimeout(readyTimer); resolveReady?.(); }
    });
  };
  const sdk = new WSClient({appId:options.appId,appSecret:options.appSecret.reveal(),domain:options.region === "feishu" ? Domain.Feishu:Domain.Lark,
    httpInstance:options.http.instance,logger:redactedFeishuLogger(options.log),autoReconnect:true,handshakeTimeoutMs:handshakeMs,agent:connection.agent,
    onReady:connected,onReconnected:connected,onReconnecting:()=>{ready=false;},onError:()=>{
      ready=false; failed=true; if(readyTimer)clearTimeout(readyTimer); rejectReady?.(new Error("invite_ingress_start_failed"));
    }});
  let closing: Promise<{readonly clean:boolean;readonly reason:"closed"|"cleanup_timeout"}>|undefined;
  return {
    dispatcher,
    get status() { return closed ? "closed" : failed ? "failed" : ready && sdk.getConnectionStatus().state === "connected" ? "ready" : started ? "degraded" : "idle"; },
    async start(): Promise<void> {
      if (closed || started) throw new Error("invite_ingress_start_fenced");
      started=true;
      const pending = new Promise<void>((resolve,reject)=>{
        resolveReady=resolve;rejectReady=reject;
        readyTimer=setTimeout(()=>{failed=true;ready=false;sdk.close({force:true});reject(new Error("invite_ingress_ready_timeout"));},readyMs);
      });
      // SDK start resolves before connecting. Only callback+connected settles pending.
      void sdk.start({eventDispatcher:dispatcher}).catch(()=>{failed=true;rejectReady?.(new Error("invite_ingress_start_failed"));});
      return pending;
    },
    close() {
      if (closing) return closing;
      closed=true;ready=false;dispatcher.fence();if(readyTimer)clearTimeout(readyTimer);
      rejectReady?.(new Error("invite_ingress_closed"));
      connection.fence();
      sdk.close({force:true});
      const work = Promise.all([dispatcher.drain(),options.http.close(),options.stopWorker?.() ?? Promise.resolve(true),connection.close(closeMs)]);
      closing = new Promise((resolve)=>{
        const timer=setTimeout(()=>resolve({clean:false,reason:"cleanup_timeout"}),closeMs);
        work.then((results)=>{clearTimeout(timer);resolve(results[2]&&results[3] ? {clean:true,reason:"closed"}:{clean:false,reason:"cleanup_timeout"});},()=>{clearTimeout(timer);resolve({clean:false,reason:"cleanup_timeout"});});
      });
      return closing;
    },
  };
}
