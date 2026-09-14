import assert from "node:assert/strict";
import { test } from "node:test";

import { createFeishuFetchTransport, createFeishuMessageSender, type FeishuHttpTransport } from "../src/adapters/feishu-api.ts";

test("Feishu message adapter uses the documented endpoint, explicit identity type and exact text body", async () => {
  const requests: Parameters<FeishuHttpTransport>[0][] = [];
  const transport: FeishuHttpTransport = async (request) => {
    requests.push(request);
    return { status: 200, body: JSON.stringify({ code: 0, data: { message_id: "om_123" } }) };
  };
  const sender = createFeishuMessageSender({ endpoint: "https://open.feishu.cn", receiveIdType: "open_id", credentials: async () => "fake-token", transport });
  assert.deepEqual(await sender.sendText({ receiveId: "ou_organizer", text: "Meeting notes: Planning\nhttps://example.test/note", uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", timeoutMs: 1234 }), { messageId: "om_123" });
  assert.equal(requests.length, 1);
  assert.ok(requests[0]!.timeoutMs > 0 && requests[0]!.timeoutMs <= 1234);
  assert.deepEqual({ ...requests[0], timeoutMs: 1234 }, {
    url: "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id",
    method: "POST", timeoutMs: 1234,
    headers: { authorization: "Bearer fake-token", "content-type": "application/json" },
    body: JSON.stringify({ receive_id: "ou_organizer", msg_type: "text", content: JSON.stringify({ text: "Meeting notes: Planning\nhttps://example.test/note" }), uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }),
  });
});

test("Feishu adapter requires code zero and a real message id while redacting provider details", async () => {
  const transport: FeishuHttpTransport = async () => ({ status: 400, body: JSON.stringify({ code: 999, msg: "secret tenant detail", data: {} }) });
  const sender = createFeishuMessageSender({ endpoint: "https://open.feishu.cn", receiveIdType: "user_id", credentials: async () => "secret-token", transport });
  await assert.rejects(sender.sendText({ receiveId: "u", text: "x", uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", timeoutMs: 100 }), (error: Error) => {
    assert.doesNotMatch(error.message, /secret|999|tenant|token/i);
    return true;
  });
});

test("Feishu adapter refuses non-HTTPS endpoints before transport", async () => {
  let called = false;
  const sender = createFeishuMessageSender({ endpoint: "http://open.feishu.cn", receiveIdType: "open_id", credentials: async () => "token", transport: async () => { called = true; throw new Error("no"); } });
  await assert.rejects(sender.sendText({ receiveId: "u", text: "x", uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", timeoutMs: 100 }), /HTTPS/i);
  assert.equal(called, false);
});

test("real transport refuses redirects and bounds response bytes", async () => {
  let redirect: RequestRedirect | undefined;
  const transport = createFeishuFetchTransport({
    maxResponseBytes: 3,
    fetchImpl: (async (_url: URL | RequestInfo, init?: RequestInit) => {
      redirect = init?.redirect;
      return new Response("four", { status: 200 });
    }) as typeof fetch,
  });
  await assert.rejects(transport({ url: "https://open.feishu.cn/x", method: "POST", headers: {}, body: "", timeoutMs: 100 }), /delivery failed/i);
  assert.equal(redirect, "error");
});

test("credential lookup is bounded before transport and cannot leak its error", async () => {
  let called = false;
  const sender = createFeishuMessageSender({
    endpoint: "https://open.feishu.cn", receiveIdType: "open_id",
    credentials: () => new Promise(() => undefined),
    transport: async () => { called = true; return { status: 200, body: "{}" }; },
  });
  await assert.rejects(sender.sendText({ receiveId: "u", text: "x", uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", timeoutMs: 5 }), /delivery failed/i);
  assert.equal(called, false);
});
