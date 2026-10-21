import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";
// @ts-expect-error Test-only scripted transport has no public declaration.
import { startInteractiveProvider } from "./interactive-provider.mjs";

// Loopback scripted recognition transport only; no Runtime, no audio.
async function refusedStatus(endpoint: string): Promise<number> {
  const socket = new WebSocket(endpoint);
  socket.on("error", () => undefined);
  const [request, response] = await once(socket, "unexpected-response") as [{ destroy(): void }, { statusCode: number; resume(): void }];
  response.resume(); request.destroy();
  return response.statusCode;
}
async function streaming(endpoint: string) {
  const socket = new WebSocket(endpoint), messages: Array<{ type: string }> = [];
  socket.on("message", bytes => messages.push(JSON.parse(String(bytes))));
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "session.update", session: { type: "transcription" } }));
  const until = async (type: string) => { while (!messages.some(m => m.type === type)) await new Promise(r => setTimeout(r, 5)); };
  await until("session.updated");
  const append = () => socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: Buffer.alloc(960).toString("base64") }));
  return { socket, messages, until, append };
}

test("connect fault refuses every recognition upgrade with HTTP 503", async () => {
  const provider = await startInteractiveProvider({ refuseRecognition: true });
  try {
    assert.equal(await refusedStatus(provider.recognitionEndpoint), 503);
    assert.equal(await refusedStatus(provider.recognitionEndpoint), 503);
    assert.equal(provider.fault.mode, "connect"); assert.equal(provider.fault.refusedConnections, 2);
    assert.equal(provider.connections.recognition, 0); assert.equal(provider.ready, false);
  } finally { await provider.close(); }
});

test("an unfaulted provider accepts recognition and reports no fault", async () => {
  const provider = await startInteractiveProvider();
  try {
    const live = await streaming(provider.recognitionEndpoint); live.append();
    while (!provider.ready) await new Promise(r => setTimeout(r, 5));
    assert.equal(provider.fault, null); live.socket.terminate();
  } finally { await provider.close(); }
});

test("error fault sends one provider error at the next append, then refuses reconnects", async () => {
  const provider = await startInteractiveProvider();
  try {
    const live = await streaming(provider.recognitionEndpoint); live.append();
    while (!provider.ready) await new Promise(r => setTimeout(r, 5));
    provider.armRecognitionFault("error");
    assert.throws(() => provider.armRecognitionFault("stall"), /recognition fault refused/);
    live.append(); await live.until("error");
    assert.equal(live.messages.filter(m => m.type === "error").length, 1);
    assert.equal(provider.fault.mode, "error"); assert.equal(provider.fault.appendedBefore, 2);
    assert.equal(await refusedStatus(provider.recognitionEndpoint), 503);
    assert.equal(provider.fault.refusedConnections, 1); live.socket.terminate();
  } finally { await provider.close(); }
});

test("stall fault stops reading the live socket and refuses reconnects", async () => {
  const provider = await startInteractiveProvider();
  try {
    const live = await streaming(provider.recognitionEndpoint); live.append();
    while (!provider.ready) await new Promise(r => setTimeout(r, 5));
    provider.armRecognitionFault("stall"); live.append();
    while (provider.fault === null) await new Promise(r => setTimeout(r, 5));
    for (let i = 0; i < 20; i += 1) live.append();
    await new Promise(r => setTimeout(r, 100));
    assert.equal(provider.fault.mode, "stall"); assert.equal(provider.appended, 2); assert.equal(provider.fault.appendedAfterFault, 0);
    assert.equal(live.messages.some(m => m.type === "error"), false);
    assert.equal(await refusedStatus(provider.recognitionEndpoint), 503); live.socket.terminate();
  } finally { await provider.close(); }
});

test("arming refuses an unknown fault or a provider without a live recognition socket", async () => {
  const provider = await startInteractiveProvider();
  try {
    assert.throws(() => provider.armRecognitionFault("error"), /recognition fault refused/);
    const live = await streaming(provider.recognitionEndpoint);
    assert.throws(() => provider.armRecognitionFault("connect"), /recognition fault refused/);
    live.socket.terminate();
  } finally { await provider.close(); }
});
