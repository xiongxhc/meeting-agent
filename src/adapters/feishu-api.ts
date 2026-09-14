import type { FeishuMessageSender } from "../ports/feishu.ts";

export type FeishuReceiveIdType = "open_id" | "user_id" | "union_id" | "email";
export type FeishuHttpRequest = {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
};
export type FeishuHttpTransport = (request: FeishuHttpRequest) => Promise<{ readonly status: number; readonly body: string }>;

export class FeishuDeliveryError extends Error {
  readonly deliveryKind: "retryable" | "ambiguous" | "terminal";
  constructor(kind: "retryable" | "ambiguous" | "terminal", message = "Feishu message delivery failed") {
    super(message);
    this.name = "FeishuDeliveryError";
    this.deliveryKind = kind;
  }
}

export function createFeishuMessageSender(options: {
  readonly endpoint: string;
  readonly receiveIdType: FeishuReceiveIdType;
  readonly credentials: () => Promise<string>;
  readonly transport: FeishuHttpTransport;
}): FeishuMessageSender {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== "https:") {
    return { sendText: async () => { throw new FeishuDeliveryError("terminal", "Feishu endpoint must use HTTPS"); } };
  }
  const messagesUrl = new URL("/open-apis/im/v1/messages", endpoint);
  messagesUrl.searchParams.set("receive_id_type", options.receiveIdType);
  return {
    async sendText(input) {
      let token: string;
      const deadline = Date.now() + input.timeoutMs;
      try {
        token = await within(options.credentials(), input.timeoutMs);
        if (token.length === 0) throw new Error("empty credential");
      } catch { throw new FeishuDeliveryError("retryable"); }
      let response: { status: number; body: string };
      try {
        response = await options.transport({
          url: messagesUrl.toString(), method: "POST", timeoutMs: Math.max(1, deadline - Date.now()),
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ receive_id: input.receiveId, msg_type: "text", content: JSON.stringify({ text: input.text }), uuid: input.uuid }),
        });
      } catch (error) {
        if ((error as { deliveryKind?: unknown }).deliveryKind === "terminal") throw new FeishuDeliveryError("terminal");
        throw new FeishuDeliveryError("ambiguous");
      }
      let parsed: unknown;
      try { parsed = JSON.parse(response.body); } catch { throw new FeishuDeliveryError(response.status >= 500 ? "ambiguous" : "terminal"); }
      const payload = parsed as { code?: unknown; data?: { message_id?: unknown } };
      if (response.status >= 200 && response.status < 300 && payload.code === 0 && typeof payload.data?.message_id === "string" && payload.data.message_id.length > 0) {
        return { messageId: payload.data.message_id };
      }
      throw new FeishuDeliveryError(response.status >= 500 || response.status === 429 ? "ambiguous" : "terminal");
    },
  };
}

/** Production transport: HTTPS only, redirect refusal, bounded time and body. */
export function createFeishuFetchTransport(options: { readonly maxResponseBytes: number; readonly fetchImpl?: typeof fetch }): FeishuHttpTransport {
  if (!Number.isInteger(options.maxResponseBytes) || options.maxResponseBytes < 1) throw new Error("maxResponseBytes must be positive");
  return async (request) => {
    const url = new URL(request.url);
    if (url.protocol !== "https:") throw new FeishuDeliveryError("terminal");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await (options.fetchImpl ?? fetch)(url, { method: request.method, headers: request.headers, body: request.body, redirect: "error", signal: controller.signal });
      if (response.body === null) return { status: response.status, body: "" };
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > options.maxResponseBytes) {
          await reader.cancel();
          throw new FeishuDeliveryError("ambiguous");
        }
        chunks.push(value);
      }
      return { status: response.status, body: Buffer.concat(chunks).toString("utf8") };
    } catch (error) {
      if (error instanceof FeishuDeliveryError) throw error;
      throw new FeishuDeliveryError("ambiguous");
    } finally { clearTimeout(timeout); }
  };
}

function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timeout); resolve(value); },
      (error: unknown) => { clearTimeout(timeout); reject(error); },
    );
  });
}
