// External scripted transports only. All inputs are synthetic; PCM stays in memory.
import { Buffer } from "node:buffer";
import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

function wav() {
  // Ten 20 ms frames stay below Runtime's bounded pending-playback queue
  // while the peer holds Rendered for the actual interruption cut.
  const pcm = Buffer.alloc(9_600);
  for (let i = 0; i < pcm.length / 2; i += 1) pcm.writeInt16LE(0x1234, i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(pcm.length + 36, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24); header.writeUInt32LE(48_000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function startInteractiveProvider() {
  const calls = [], sockets = new Set(), heldResponses = new Set();
  let holdLanguage = false, bargeOnSpeech = false;
  let recognition = null, previous = null, ordinal = 0, appended = 0;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (request.url.endsWith("/chat/completions")) {
        const prompt = (body.messages ?? []).map((entry) => String(entry.content ?? "")).join("\n");
        const grounded = prompt.includes("[Team Vault:") ? "vault" : prompt.includes("[current meeting]") ? "current" : "none";
        const unavailable = prompt.includes("Historical team memory (Team Vault) is currently unavailable");
        // Cross the shipped utterance assembler's soft limit so speech starts
        // while the external language stream remains held for cancellation.
        const answer = holdLanguage ? "A synthetic story continues through this sentence. ".repeat(10) : unavailable ? "Historical team memory is unavailable." : grounded === "vault"
          ? "Orion launch code is violet." : grounded === "current" ? "Copper budget is seven." : "Scripted named reply.";
        calls.push({ route: "language", grounded, unavailable, currentFact: prompt.includes("Copper budget is seven"),
          vaultFact: prompt.includes("Orion launch code is violet"), at: Date.now() });
        response.setHeader("content-type", "text/event-stream");
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: null }] })}\n\n`);
        if (holdLanguage) {
          heldResponses.add(response);
          response.on("close", () => heldResponses.delete(response));
        } else response.end("data: [DONE]\n\n");
      } else if (request.url.endsWith("/audio/speech")) {
        calls.push({ route: "speech", text: body.input, at: Date.now() });
        response.setHeader("content-type", "application/octet-stream");
        response.end(wav());
      } else { response.statusCode = 404; response.end(); }
    });
  });
  const websocket = new WebSocketServer({ server });
  websocket.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.send(JSON.stringify({ type: "session.created", session: { type: "transcription" } }));
    socket.on("message", (bytes) => {
      const event = JSON.parse(bytes.toString());
      if (event.type === "session.update") {
        socket.send(JSON.stringify({ type: "session.updated", session: event.session }));
        recognition = socket;
      } else if (event.type === "input_audio_buffer.append") {
        appended += 1;
        if (bargeOnSpeech && Buffer.from(event.audio, "base64").some((byte) => byte !== 0)) {
          bargeOnSpeech = false; ordinal += 1;
          socket.send(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: `interactive-${ordinal}`, audio_start_ms: (appended - 1) * 20 }));
          calls.push({ route: "barge_activity", at: Date.now() });
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `127.0.0.1:${server.address().port}`;
  return {
    calls, endpoint: `http://${origin}/v1`, recognitionEndpoint: `ws://${origin}/v1/realtime?intent=transcription`,
    get ready() { return recognition !== null && appended > 0; },
    get appended() { return appended; },
    holdLanguage() { holdLanguage = true; },
    armBargeOnSpeech() { bargeOnSpeech = true; },
    releaseLanguage() { holdLanguage = false; for (const response of heldResponses) response.end("data: [DONE]\n\n"); heldResponses.clear(); },
    transcript(text) {
      if (recognition === null) throw new Error("scripted recognition is not ready");
      ordinal += 1;
      const item = `interactive-${ordinal}`, start = (ordinal - 1) * 20;
      for (const event of [
        { type: "input_audio_buffer.speech_started", item_id: item, audio_start_ms: start },
        { type: "input_audio_buffer.speech_stopped", item_id: item, audio_end_ms: start + 20 },
        { type: "input_audio_buffer.committed", item_id: item, previous_item_id: previous },
        { type: "conversation.item.input_audio_transcription.completed", item_id: item, content_index: 0, transcript: text },
      ]) recognition.send(JSON.stringify(event));
      previous = item;
    },
    async close() {
      for (const response of heldResponses) response.destroy();
      for (const socket of sockets) socket.terminate();
      websocket.close(); server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
