// The local fixture provider host the post-meeting gateway configuration
// names. It answers the gateway's readiness poll and the one ollama-compatible
// NDJSON chat stream the artifact build's `processText` makes. It is a
// fixture, not a model: it returns a fixed, clearly synthetic body that
// satisfies the requested output schema and states nothing about the meeting
// it did not receive.

import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { once } from "node:events";
import { createServer } from "node:http";

import { l4Configuration, l4PersonSummaries } from "./l4-campaign.mjs";

const PLACEHOLDER = "Scripted fixture provider output; no model read this meeting.";
const MAX_REQUEST_BYTES = 1024 * 1024;

/** The shipped artifact build asks for one synthesis object with six required
 * members. The fixture answers exactly that shape, with a visible placeholder
 * summary and no invented project, decision, action item, discussion point or
 * person, so nothing in the artifact can be mistaken for a reading of the
 * recording. Any other prompt gets a one-key object. */
function schemaShapedAnswer(prompt, messages, l4Case) {
  if (prompt.includes("meeting synthesis")) {
    return JSON.stringify({
      summary: PLACEHOLDER, projects: [], decisions: [],
      action_items: [], discussion_points: [], person_summaries: l4Case === undefined ? [] : l4PersonSummaries(messages, l4Case),
    });
  }
  return JSON.stringify({ summary: PLACEHOLDER });
}

/** Component-testable HTTP handler; fault arming is explicit and instance-local. */
export function createFixtureProviderHandler({ l4Case } = {}) {
  l4Configuration({ l4Case, interactive: true });
  const calls = [];
  let nextChatFailure = false;
  const handler = (request, response) => {
    const chunks = [];
    let requestBytes = 0;
    let finished = false;
    const recordChat = (outcome, promptBytes = 0) => calls.push({ route: "chat", outcome, promptBytes, requestBytes, at: Date.now() });
    const reject = (status, message, outcome, chatRoute) => {
      if (finished) return;
      finished = true;
      chunks.length = 0;
      if (chatRoute) recordChat(outcome);
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: message }));
    };
    let route;
    try { route = new URL(request.url ?? "/", "http://fixture.invalid").pathname; }
    catch { reject(400, "Invalid fixture provider request.", "invalid_request", false); return; }
    const chatRoute = route.endsWith("/api/chat");
    request.on("data", (chunk) => {
      if (finished) return;
      requestBytes += chunk.length;
      if (requestBytes > MAX_REQUEST_BYTES) {
        reject(413, "Fixture provider request exceeds its byte limit.", "request_too_large", chatRoute);
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", () => reject(400, "Invalid fixture provider request.", "invalid_request", chatRoute));
    request.on("end", () => {
      if (finished) return;
      if (chatRoute) {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          if (body === null || typeof body !== "object" || Array.isArray(body)
              || (body.messages !== undefined && (!Array.isArray(body.messages)
                || body.messages.some((message) => message === null || typeof message !== "object" || Array.isArray(message))))) {
            throw new Error("invalid request shape");
          }
        } catch { reject(400, "Invalid fixture provider request.", "invalid_request", true); return; }
        const text = (body.messages ?? []).map((message) => String(message.content ?? "")).join("\n");
        const promptBytes = Buffer.byteLength(text);
        finished = true;
        if (nextChatFailure) {
          nextChatFailure = false;
          recordChat("armed_failure", promptBytes);
          response.statusCode = 503;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ error: "Scripted fixture provider chat failure." }));
          return;
        }
        recordChat("ok", promptBytes);
        const content = schemaShapedAnswer(text, body.messages ?? [], l4Case);
        response.setHeader("content-type", "application/x-ndjson");
        response.write(`${JSON.stringify({ model: "synthetic", message: { role: "assistant", content }, done: false })}\n`);
        response.end(`${JSON.stringify({ model: "synthetic", message: { role: "assistant", content: "" }, done: true, total_duration: 1000, load_duration: 1, prompt_eval_count: 1, prompt_eval_duration: 1, eval_count: 1, eval_duration: 1 })}\n`);
        return;
      }
      finished = true;
      calls.push({ route: route.endsWith("/health") ? "health" : "other", at: Date.now() });
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
  };
  return { handler, calls, armNextChatFailure() { nextChatFailure = true; } };
}

export async function startFixtureProvider(options = {}) {
  const { handler, calls, armNextChatFailure } = createFixtureProviderHandler(options);
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  return {
    endpoint, calls, armNextChatFailure,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
