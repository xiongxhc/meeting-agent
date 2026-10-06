import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { test } from "node:test";

// @ts-expect-error Test-only JavaScript fixture module has no public declaration.
import * as fixtureProvider from "./fixture-provider.mjs";

function provider() {
  assert.equal(typeof fixtureProvider.createFixtureProviderHandler, "function", "listener-free production HTTP handler must exist");
  return fixtureProvider.createFixtureProviderHandler();
}

function exchange(handler: (request: unknown, response: unknown) => void, route: string, chunks: string[]) {
  const request = Object.assign(new EventEmitter(), { url: route });
  const response = {
    statusCode: 200, headers: {} as Record<string, string>, chunks: [] as string[], endCount: 0,
    setHeader(name: string, value: string) { this.headers[name] = value; },
    write(chunk: string) { this.chunks.push(chunk); },
    end(chunk = "") { this.chunks.push(chunk); this.endCount++; },
  };
  handler(request, response);
  for (const chunk of chunks) request.emit("data", Buffer.from(chunk));
  request.emit("end");
  return response;
}

const chat = JSON.stringify({ messages: [{ role: "user", content: "meeting synthesis private-input-do-not-log" }] });

test("component HTTP handler defaults to finite successful synthesis NDJSON without faults", () => {
  const p = provider();
  const response = exchange(p.handler, "/api/chat", [chat]);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "application/x-ndjson");
  assert.equal(response.endCount, 1);
  const messages = response.chunks.join("").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].done, false);
  assert.equal(messages[1].done, true);
  assert.deepEqual(JSON.parse(messages[0].message.content), {
    summary: "Scripted fixture provider output; no model read this meeting.", projects: [], decisions: [],
    action_items: [], discussion_points: [], person_summaries: [],
  });
  assert.equal(p.calls[0].outcome, "ok");
});

test("explicit next-chat fault survives readiness polls, fails once with503 and nextchat recovers", () => {
  const p = provider();
  p.armNextChatFailure();
  for (const route of ["/health", "/api/tags"]) {
    const ready = exchange(p.handler, route, []);
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.chunks.join(""), "{}");
  }
  const failed = exchange(p.handler, "/api/chat", [chat.slice(0, 17), chat.slice(17)]);
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.headers["content-type"], "application/json");
  assert.equal(failed.endCount, 1);
  assert.deepEqual(JSON.parse(failed.chunks.join("")), { error: "Scripted fixture provider chat failure." });
  const recovered = exchange(p.handler, "/api/chat", [chat]);
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.endCount, 1);
  assert.deepEqual(p.calls.filter((call: { route: string }) => call.route === "chat").map((call: { outcome: string }) => call.outcome), ["armed_failure", "ok"]);
  const telemetry = JSON.stringify(p.calls);
  assert.equal(telemetry.includes("private-input-do-not-log"), false);
  const chatCalls = p.calls.filter((call: { route: string }) => call.route === "chat");
  for (const call of chatCalls) {
    assert.equal(call.promptBytes, Buffer.byteLength("meeting synthesis private-input-do-not-log"));
    assert.equal(call.requestBytes, Buffer.byteLength(chat));
    assert.equal(typeof call.at, "number");
    assert.deepEqual(Object.keys(call).sort(), ["at", "outcome", "promptBytes", "requestBytes", "route"]);
  }
});

test("malformed JSON and oversized requests return finite errors without consuming an armed fault", () => {
  const p = provider();
  p.armNextChatFailure();
  for (const body of ["{invalid", "null", '{"messages":{}}', '{"messages":[null]}']) {
    const rejected = exchange(p.handler, "/api/chat", [body]);
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.endCount, 1);
    assert.deepEqual(JSON.parse(rejected.chunks.join("")), { error: "Invalid fixture provider request." });
  }
  const oversized = exchange(p.handler, "/api/chat", ["x".repeat(1024 * 1024), "x", "ignored trailing bytes"]);
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.endCount, 1);
  assert.deepEqual(JSON.parse(oversized.chunks.join("")), { error: "Fixture provider request exceeds its byte limit." });
  assert.equal(exchange(p.handler, "/health", []).statusCode, 200);
  assert.equal(exchange(p.handler, "/api/chat", [chat]).statusCode, 503);
  assert.equal(exchange(p.handler, "/api/chat", [chat]).statusCode, 200);
  assert.deepEqual(p.calls.filter((call: { route: string }) => call.route === "chat").map((call: { outcome: string }) => call.outcome), [
    "invalid_request", "invalid_request", "invalid_request", "invalid_request", "request_too_large", "armed_failure", "ok",
  ]);
});
