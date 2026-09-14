import { AsyncLocalStorage } from "node:async_hooks";
import { defaultHttpInstance, type HttpInstance, type Logger } from "@larksuiteoapi/node-sdk";
import { createFeishuSocketOwner, type FeishuSocketOwner } from "./feishu-sdk-connection.ts";

export function redactedFeishuLogger(log: (code: string) => void = () => {}): Logger {
  return { error:()=>log("feishu_sdk_error"),warn:()=>log("feishu_sdk_warning"),info:()=>log("feishu_sdk_info"),
    debug:()=>log("feishu_sdk_debug"),trace:()=>log("feishu_sdk_trace") };
}
export class FeishuHttpError extends Error {
  readonly status: number | null;
  constructor(reason: "timeout" | "cancelled" | "failed" | "closed" | "busy", status: number | null = null) {
    super(`feishu_http_${reason}`); this.status = status;
  }
}
/** Public SDK HttpInstance, without singleton/interceptor mutation. Owns abort AND settlement. */
export function createFeishuSdkHttp(options: { readonly request?: typeof defaultHttpInstance.request; readonly timeoutMs?: number; readonly connection?: FeishuSocketOwner } = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error("invalid_feishu_http_budget");
  const context = new AsyncLocalStorage<AbortSignal>();
  const connection=options.connection ?? createFeishuSocketOwner();
  const active = new Map<Promise<unknown>,AbortController>();
  let closed = false;
  const request: HttpInstance["request"] = async <T,R=T,D=unknown>(opts: Parameters<HttpInstance["request"]>[0]): Promise<R> => {
    if (closed) throw new FeishuHttpError("closed");
    if (active.size !== 0) throw new FeishuHttpError("busy");
    const signal = context.getStore(), controller = new AbortController();
    if (signal?.aborted) throw new FeishuHttpError("cancelled");
    const cancel = () => controller.abort(); signal?.addEventListener("abort",cancel,{once:true});
    let timedOut = false;
    const timer = setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
    const pending = Promise.resolve().then(()=>(options.request ?? defaultHttpInstance.request)<T,R,D>({ ...opts, data: opts.data as D,
      signal:controller.signal,httpsAgent:connection.agent,httpAgent:connection.agent,
      timeout:Math.min(timeoutMs,opts.timeout ?? timeoutMs),maxContentLength:65536,maxBodyLength:65536,maxRedirects:0 }));
    active.set(pending,controller);
    // The SDK's installed response interceptor returns data (or its documented
    // $return_headers shape), not AxiosResponse; HttpInstance's R is that value.
    try { return await pending as R; }
    catch (error) {
      const status = (error as {response?:{status?:number}})?.response?.status;
      throw new FeishuHttpError(timedOut ? "timeout" : controller.signal.aborted ? "cancelled" : "failed",typeof status === "number" ? status:null);
    } finally { clearTimeout(timer); signal?.removeEventListener("abort",cancel); active.delete(pending); }
  };
  const instance: HttpInstance = {
    request,
    get:(url,opts)=>request({...opts,url,method:"GET"}),delete:(url,opts)=>request({...opts,url,method:"DELETE"}),
    head:(url,opts)=>request({...opts,url,method:"HEAD"}),options:(url,opts)=>request({...opts,url,method:"OPTIONS"}),
    post:(url,data,opts)=>request({...opts,url,data,method:"POST"}),put:(url,data,opts)=>request({...opts,url,data,method:"PUT"}),
    patch:(url,data,opts)=>request({...opts,url,data,method:"PATCH"}),
  };
  return { instance, get activeCount() {return active.size;},
    withSignal<T>(signal: AbortSignal, run:()=>Promise<T>): Promise<T> { return context.run(signal,run); },
    async close(): Promise<void> {
      closed=true;connection.fence();for(const controller of active.values())controller.abort();
      const sockets=connection.close();await Promise.allSettled([...active.keys()]);
      if(!await sockets)throw new Error("feishu_http_cleanup_timeout");
    },
  };
}
export type FeishuSdkHttp = ReturnType<typeof createFeishuSdkHttp>;
