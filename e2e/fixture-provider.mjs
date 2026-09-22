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

const PLACEHOLDER = "Scripted fixture provider output; no model read this meeting.";

/** The shipped artifact build asks for one synthesis object with six required
 * members. The fixture answers exactly that shape, with a visible placeholder
 * summary and no invented project, decision, action item, discussion point or
 * person, so nothing in the artifact can be mistaken for a reading of the
 * recording. Any other prompt gets a one-key object. */
function schemaShapedAnswer(prompt) {
  if (prompt.includes("meeting synthesis")) {
    return JSON.stringify({
      summary: PLACEHOLDER, projects: [], decisions: [],
      action_items: [], discussion_points: [], person_summaries: [],
    });
  }
  return JSON.stringify({ summary: PLACEHOLDER });
}

export async function startFixtureProvider() {
  const calls = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
      if (path.endsWith("/api/chat")) {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        const text = (body.messages ?? []).map((message) => String(message.content ?? "")).join("\n");
        calls.push({ route: "chat", promptBytes: Buffer.byteLength(text), at: Date.now() });
        const content = schemaShapedAnswer(text);
        response.setHeader("content-type", "application/x-ndjson");
        response.write(`${JSON.stringify({ model: "synthetic", message: { role: "assistant", content }, done: false })}\n`);
        response.end(`${JSON.stringify({ model: "synthetic", message: { role: "assistant", content: "" }, done: true, total_duration: 1000, load_duration: 1, prompt_eval_count: 1, prompt_eval_duration: 1, eval_count: 1, eval_duration: 1 })}\n`);
        return;
      }
      calls.push({ route: path.endsWith("/health") ? "health" : "other", at: Date.now() });
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  return {
    endpoint, calls,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
