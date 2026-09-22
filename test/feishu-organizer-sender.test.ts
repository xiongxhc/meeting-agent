import assert from "node:assert/strict";
import { Agent } from "node:http";
import { test } from "node:test";

import { createFeishuOrganizerSender } from "../src/adapters/feishu-organizer-sender.ts";
import { createFeishuSdkHttp } from "../src/adapters/feishu-sdk-http.ts";
import { createFeishuSocketOwner } from "../src/adapters/feishu-sdk-connection.ts";
import { RedactedSecret } from "../src/config.ts";
import { httpPeer, scope } from "./lib/feishu-fixtures.ts";

const TENANT_TOKEN = "synthetic-tenant-token";
const APP_SECRET = "synthetic-app-secret";
const UUID = "0f9b1a2c-3d4e-5f60-8a9b-0c1d2e3f4a5b";

type Call = {
  readonly method: string | undefined;
  readonly pathname: string;
  readonly receiveIdType: string | null;
  readonly authorization: string | undefined;
  readonly body: string;
};

/** Scripted Feishu origin: the SDK's token manager is the only holder of the
 * tenant token, so the peer issues it on the documented credential endpoint
 * and the message route records whatever bearer the SDK attached. */
async function sender(reply: (call: Call) => { status?: number; payload: unknown }, log: string[] = []) {
  const calls: Call[] = [];
  const peer = await httpPeer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url!, "http://fixture");
      response.setHeader("content-type", "application/json");
      if (url.pathname.endsWith("/auth/v3/tenant_access_token/internal")) {
        assert.ok(Buffer.concat(chunks).toString("utf8").includes(APP_SECRET), "the SDK, not Meeting, presents the app secret");
        response.end(JSON.stringify({ code: 0, msg: "ok", tenant_access_token: TENANT_TOKEN, expire: 7200 }));
        return;
      }
      const call: Call = {
        method: request.method, pathname: url.pathname,
        receiveIdType: url.searchParams.get("receive_id_type"),
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      calls.push(call);
      const { status = 200, payload } = reply(call);
      response.writeHead(status);
      response.end(JSON.stringify(payload));
    });
  });
  const http = createFeishuSdkHttp({ request: peer.request, connection: createFeishuSocketOwner(Agent) });
  const adapter = createFeishuOrganizerSender({ ...scope, appSecret: new RedactedSecret(APP_SECRET), http, log: (code) => log.push(code) });
  return { adapter, calls, log, async close() { await http.close(); await peer.close(); } };
}

test("a verified receipt becomes exactly one organizer DM carrying the SDK's tenant token, never Meeting's", async () => {
  const log: string[] = [];
  const f = await sender(() => ({ payload: { code: 0, msg: "ok", data: { message_id: "om_synthetic_1" } } }), log);
  try {
    const sent = await f.adapter.sendText({ receiveId: "ou_organizer", text: "Minutes ready\nhttps://vault.invalid/m", uuid: UUID, timeoutMs: 2_000 });
    assert.deepEqual(sent, { messageId: "om_synthetic_1" });
    assert.equal(f.calls.length, 1, "the adapter never retries; the worker owns retries and the dedup window");
    const call = f.calls[0]!;
    assert.equal(call.method, "POST");
    assert.equal(call.pathname, "/open-apis/im/v1/messages");
    assert.equal(call.receiveIdType, "open_id");
    assert.equal(call.authorization, `Bearer ${TENANT_TOKEN}`, "the bearer is the one the scripted token endpoint issued");
    assert.deepEqual(JSON.parse(call.body), {
      receive_id: "ou_organizer", msg_type: "text",
      content: JSON.stringify({ text: "Minutes ready\nhttps://vault.invalid/m" }), uuid: UUID,
    });
    assert.equal(JSON.parse(call.body).uuid, UUID, "the durable request uuid is passed through byte for byte");
    const logged = log.join("\n");
    assert.ok(!logged.includes(TENANT_TOKEN) && !logged.includes(APP_SECRET), "Meeting never logs the credential");
    assert.ok(!logged.includes("ou_organizer") && !logged.includes("Minutes ready"), "Meeting never logs the recipient or the text");
    assert.ok(log.every((code) => /^[a-z0-9_]+$/.test(code)), "only static codes are logged");
  } finally { await f.close(); }
});

test("a non-zero provider code rejects with a static code that never carries the response text", async () => {
  const log: string[] = [];
  const f = await sender(() => ({ payload: { code: 230_002, msg: "bot is not in the chat: ou_organizer", data: {} } }), log);
  try {
    await assert.rejects(
      f.adapter.sendText({ receiveId: "ou_organizer", text: "Minutes ready", uuid: UUID, timeoutMs: 2_000 }),
      (error: Error & { deliveryKind?: string }) => {
        assert.equal(error.message, "notification_send_rejected");
        assert.equal(error.deliveryKind, undefined, "a refused request is not ambiguous; the worker retries it under the same uuid");
        assert.ok(!/bot is not in the chat|230002|230_002/.test(String(error.message)));
        return true;
      },
    );
    assert.equal(f.calls.length, 1);
    assert.ok(!log.join("\n").includes("bot is not in the chat"));
  } finally { await f.close(); }
});

test("a missing message id is a rejection, never a fabricated receipt", async () => {
  const f = await sender(() => ({ payload: { code: 0, msg: "ok", data: {} } }));
  try {
    await assert.rejects(f.adapter.sendText({ receiveId: "ou_organizer", text: "Minutes ready", uuid: UUID, timeoutMs: 2_000 }), /notification_send_rejected/);
  } finally { await f.close(); }
});

test("an ambiguous timeout rejects inside the worker's budget and is marked ambiguous, never retried in the adapter", async () => {
  const log: string[] = [];
  const calls: string[] = [];
  const peer = await httpPeer((request, response) => {
    const url = new URL(request.url!, "http://fixture");
    calls.push(url.pathname);
    if (url.pathname.endsWith("/auth/v3/tenant_access_token/internal")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ code: 0, msg: "ok", tenant_access_token: TENANT_TOKEN, expire: 7200 }));
      return;
    }
    // The message request is accepted by the socket and never answered.
  });
  const http = createFeishuSdkHttp({ request: peer.request, connection: createFeishuSocketOwner(Agent) });
  const adapter = createFeishuOrganizerSender({ ...scope, appSecret: new RedactedSecret(APP_SECRET), http, log: (code) => log.push(code) });
  const timeoutMs = 120;
  const startedAt = Date.now();
  try {
    await assert.rejects(
      adapter.sendText({ receiveId: "ou_organizer", text: "Minutes ready", uuid: UUID, timeoutMs }),
      (error: Error & { deliveryKind?: string }) => {
        assert.equal(error.message, "notification_send_timeout");
        assert.equal(error.deliveryKind, "ambiguous", "the worker maps this to its bounded uncertain outcome");
        return true;
      },
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < timeoutMs + 2_000, `the send honours its budget (${elapsed}ms)`);
    assert.equal(calls.filter((pathname) => pathname.endsWith("/im/v1/messages")).length, 1, "no retry inside the adapter");
    assert.ok(!log.join("\n").includes(TENANT_TOKEN));
  } finally { await http.close(); await peer.close(); }
});

test("an out-of-scope app id is refused at composition, before any socket work", async () => {
  const http = createFeishuSdkHttp({ request: async () => { throw new Error("must_not_call"); } });
  try {
    assert.throws(() => createFeishuOrganizerSender({ ...scope, appId: "not-an-app-id", appSecret: new RedactedSecret(APP_SECRET), http }), /invalid_invite_scope/);
  } finally { await http.close(); }
});
