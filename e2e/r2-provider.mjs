// Explicitly scripted external postmeeting provider, not a transcription of PCM.
// Supported uploads: Runtime's canonical PCM s16le/24000 Hz/mono WAV, 480–524288
// samples. Configured synthetic intervals are checked against EACH uploaded extent.
// No credential/prompt/multipart/PCM bytes enter telemetry or persistent storage.
import { Buffer } from "node:buffer";
import { once } from "node:events";
import { createServer } from "node:http";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16384;
const MAX_RECORDS = 64;
const SYNTHESIS = JSON.stringify({ summary: "Scripted fixture provider output; no model read this meeting.",
  projects: [], decisions: [], action_items: [], discussion_points: [], person_summaries: [] });

function parseUpload(body, contentType) {
  const match = /^multipart\/form-data;\s*boundary=(?:"([A-Za-z0-9'()+_,./:=?-]{1,70})"|([A-Za-z0-9'()+_,./:=?-]{1,70}))$/i.exec(contentType);
  if (!match) throw new Error("invalid upload");
  const boundary = match[1] ?? match[2];
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const first = Buffer.from(`--${boundary}\r\n`);
  if (!body.subarray(0, first.length).equals(first)) throw new Error("invalid upload");
  const fields = new Map();
  let cursor = first.length, terminal = false;
  while (cursor < body.length) {
    const headerEnd = body.indexOf("\r\n\r\n", cursor);
    if (headerEnd < cursor || headerEnd - cursor > 1024 || fields.size >= 5) throw new Error("invalid upload");
    const headers = body.subarray(cursor, headerEnd).toString("utf8").split("\r\n");
    const disposition = /^content-disposition: form-data; name="([a-z_]+)"(?:; filename="window\.wav")?$/i.exec(headers[0]);
    if (!disposition) throw new Error("invalid upload");
    const name = disposition[1];
    if (!["file", "model", "response_format", "chunking_strategy", "language"].includes(name) || fields.has(name)) throw new Error("invalid upload");
    if (name === "file") {
      if (!headers[0].endsWith('; filename="window.wav"') || headers.length !== 2 || !/^content-type: audio\/wav$/i.test(headers[1])) throw new Error("invalid upload");
    } else if (headers.length !== 1 || headers[0].includes("filename=")) throw new Error("invalid upload");
    const end = body.indexOf(delimiter, headerEnd + 4);
    if (end < 0) throw new Error("invalid upload");
    const bytes = body.subarray(headerEnd + 4, end);
    if (name !== "file" && (bytes.length === 0 || bytes.length > 256)) throw new Error("invalid upload");
    fields.set(name, bytes);
    cursor = end + delimiter.length;
    if (body.subarray(cursor).equals(Buffer.from("--\r\n"))) { terminal = true; break; }
    if (!body.subarray(cursor, cursor + 2).equals(Buffer.from("\r\n"))) throw new Error("invalid upload");
    cursor += 2;
  }
  if (!terminal || !fields.has("file") || !fields.has("model") || fields.get("response_format")?.toString() !== "diarized_json"
      || fields.get("chunking_strategy")?.toString() !== "auto") throw new Error("invalid upload");
  const audio = fields.get("file");
  if (audio.length < 44 || audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 16) !== "WAVEfmt "
      || audio.readUInt32LE(4) !== audio.length - 8 || audio.readUInt32LE(16) !== 16 || audio.readUInt16LE(20) !== 1
      || audio.readUInt16LE(22) !== 1 || audio.readUInt32LE(24) !== 24000 || audio.readUInt32LE(28) !== 48000
      || audio.readUInt16LE(32) !== 2 || audio.readUInt16LE(34) !== 16 || audio.toString("ascii", 36, 40) !== "data"
      || audio.readUInt32LE(40) !== audio.length - 44 || (audio.length - 44) % 2 !== 0) throw new Error("invalid upload");
  const samples = (audio.length - 44) / 2;
  if (samples < 480 || samples > 524288) throw new Error("invalid upload");
  return samples / 24000;
}

/** Same handler for component byte-stream tests and the normal HTTP wrapper. */
export function createR2ProviderHandler(options) {
  const { segmentText, segmentStartMs, segmentEndMs } = options ?? {};
  if (typeof segmentText !== "string" || !segmentText.startsWith("Scripted fixture ") || segmentText.trim() === "Scripted fixture"
      || Buffer.byteLength(segmentText) > 4096 || 2 * Buffer.byteLength(JSON.stringify(segmentText)) + 512 > MAX_RESPONSE_BYTES
      || !Number.isSafeInteger(segmentStartMs) || !Number.isSafeInteger(segmentEndMs)
      || segmentStartMs < 0 || segmentEndMs - segmentStartMs < 20 || segmentEndMs > 524288 / 24)
    throw new Error("Invalid scripted segment configuration.");
  const calls = [];
  const unfinished = new Set();
  let ordinal = 0, finalAvailable = true, nextSynthesisFailure = false, held = null, closed = false;
  const record = (entry) => { if (calls.length === MAX_RECORDS) calls.shift(); calls.push(entry); };
  const ensureOpen = () => { if (closed) throw new Error("R2 provider is closed."); };
  const handler = (request, response) => {
    const requestOrdinal = ++ordinal;
    let requestBytes = 0, finished = false;
    const chunks = [];
    const route = request.url === "/health" ? "health" : request.url === "/v1/chat/completions" ? "synthesis"
      : request.url === "/v1/audio/transcriptions" ? "final" : "other";
    const finish = (status, contentType, body, outcome) => {
      if (finished) return;
      finished = true; chunks.length = 0; unfinished.delete(dispose);
      const responseBytes = Buffer.byteLength(body);
      if (responseBytes > MAX_RESPONSE_BYTES) throw new Error("Scripted response exceeds its limit.");
      record({ ordinal: requestOrdinal, route, outcome, requestBytes, responseBytes });
      response.statusCode = status; response.setHeader("content-type", contentType); response.end(body);
    };
    const reject = (status, outcome) => finish(status, "application/json", JSON.stringify({ error: "Scripted R2 provider request refused." }), outcome);
    const dispose = () => {
      if (finished) return;
      finished = true; chunks.length = 0; unfinished.delete(dispose);
      if (held?.response === response) { held.done = true; held.response = null; held.send = null; held.dispose = null; held = null; }
      record({ ordinal: requestOrdinal, route, outcome: "cancelled", requestBytes, responseBytes: 0 });
      response.destroy();
    };
    request.on("error", dispose); request.on("aborted", dispose);
    request.on("close", () => { if (!request.complete) dispose(); });
    response.on("close", dispose);
    unfinished.add(dispose);
    if (request.aborted || request.destroyed || response.destroyed) { dispose(); return; }
    if (closed) { reject(503, "closed"); return; }
    if (route === "other") { reject(404, "unknown_route"); return; }
    if (request.method !== (route === "health" ? "GET" : "POST")) { reject(405, "invalid_method"); return; }
    if (route !== "health" && (typeof request.headers?.authorization !== "string" || !/^Bearer [^\s]{1,4096}$/.test(request.headers.authorization))) {
      reject(401, "invalid_auth"); return;
    }
    const contentType = request.headers?.["content-type"] ?? "";
    if (route === "synthesis" && !/^application\/json(?:;\s*charset=utf-8)?$/i.test(contentType)) { reject(415, "invalid_content_type"); return; }
    if (route === "final" && !/^multipart\/form-data;/i.test(contentType)) { reject(415, "invalid_content_type"); return; }
    request.on("data", (chunk) => {
      if (finished) return;
      requestBytes += chunk.length;
      if (requestBytes > MAX_REQUEST_BYTES) { reject(413, "request_too_large"); return; }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (finished) return;
      if (route === "health") { finish(200, "application/json", "{}", "ok"); return; }
      const body = Buffer.concat(chunks); chunks.length = 0;
      if (route === "synthesis") {
        try {
          const parsed = JSON.parse(body.toString("utf8"));
          if (!parsed || parsed.stream !== true || typeof parsed.model !== "string" || !parsed.model
              || !Array.isArray(parsed.messages) || parsed.messages.length === 0 || parsed.messages.length > 256
              || parsed.messages.some(message => !message || typeof message.content !== "string" || !["system", "user", "assistant"].includes(message.role))) throw new Error("invalid synthesis");
        } catch { reject(400, "invalid_request"); return; }
        if (nextSynthesisFailure) { nextSynthesisFailure = false; reject(503, "armed_failure"); return; }
        finish(200, "text/event-stream", `data: ${JSON.stringify({ choices: [{ delta: { content: SYNTHESIS }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`, "ok");
        return;
      }
      let duration;
      try {
        duration = parseUpload(body, contentType);
        if (segmentEndMs / 1000 > duration) throw new Error("outside extent");
      } catch { reject(400, "invalid_request"); return; }
      const sendFinal = () => {
        if (!finalAvailable) { reject(503, "unavailable"); return; }
        finish(200, "application/json", JSON.stringify({ task: "transcribe", duration, text: segmentText,
          segments: [{ type: "transcript.text.segment", id: "scripted-segment-1", start: segmentStartMs / 1000, end: segmentEndMs / 1000,
            text: segmentText, speaker: "anonymous-scripted-cluster-1" }] }), "ok");
      };
      if (held && !held.response) { held.response = response; held.send = sendFinal; held.dispose = dispose; }
      else sendFinal();
    });
  };
  return {
    handler, calls,
    setFinalAvailable(value) { ensureOpen(); if (typeof value !== "boolean") throw new Error("Availability must be explicit."); finalAvailable = value; },
    armNextSynthesisFailure() { ensureOpen(); nextSynthesisFailure = true; },
    holdNextFinal() {
      ensureOpen(); if (held) throw new Error("A final request is already owned.");
      const owner = { done: false, response: null, send: null, dispose: null }; held = owner;
      return {
        get pending() { return !owner.done && owner.response !== null; },
        release() {
          if (owner.done || !owner.send) return false;
          const send = owner.send; owner.done = true; owner.response = null; owner.send = null; owner.dispose = null; held = null; send(); return true;
        },
        cancel() {
          if (owner.done) return false;
          const dispose = owner.dispose; owner.done = true; owner.response = null; owner.send = null; owner.dispose = null; held = null; dispose?.(); return true;
        },
      };
    },
    close() {
      if (closed) return; closed = true;
      if (held) { held.done = true; held.response = null; held.send = null; held.dispose = null; held = null; }
      for (const dispose of unfinished) dispose();
    },
  };
}

export async function startR2Provider(options) {
  const provider = createR2ProviderHandler(options);
  const server = createServer(provider.handler);
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { ...provider, endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    async close() { provider.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
