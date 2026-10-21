// The e2e post-meeting lane runs in the live session's pinned online profile:
// Meeting refuses a post-meeting Runtime in any other profile, so a lane that
// swapped to offline would never build or publish.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// @ts-expect-error Test-only JavaScript module has no public declaration.
import { liveGatewayToml, postmeetingOnlineGatewayToml } from "./gateway-config.mjs";
// @ts-expect-error Test-only JavaScript fixture module has no public declaration.
import { createFixtureProviderHandler } from "./fixture-provider.mjs";

const options = { recordingsDir: "/private/issued-recordings", keyEnv: "E2E_RECORDING_KEY", credentialEnv: "E2E_PROVIDER_CREDENTIAL",
  languageEndpoint: "http://127.0.0.1:12001/v1", recognitionEndpoint: "ws://127.0.0.1:12002/v1/realtime?intent=transcription",
  speechEndpoint: "http://127.0.0.1:12002/v1" };

test("the post-meeting configuration is the live online deployment plus loopback scripted providers", () => {
  const text: string = postmeetingOnlineGatewayToml(options);
  const live: string = liveGatewayToml(options);
  assert.ok(text.startsWith(live), "the live online deployment table is unchanged");
  assert.match(text, /^schema_version = 3\nprofile = "online"\n/);
  assert.equal(text.slice(live.length), '\n[scripted_providers]\nlanguage = "http://127.0.0.1:12001/v1"\n' +
    'recognition = "ws://127.0.0.1:12002/v1/realtime?intent=transcription"\nspeech = "http://127.0.0.1:12002/v1"\n');
  assert.doesNotMatch(text, /profile = "offline"|ollama-compatible/);
});

test("the post-meeting configuration refuses a non-loopback, portless or injecting scripted endpoint", () => {
  for (const [name, value] of [["languageEndpoint", "http://example.invalid:1/v1"], ["languageEndpoint", "http://127.0.0.1/v1"],
    ["speechEndpoint", 'http://127.0.0.1:1/v1"\n[evil]'], ["recognitionEndpoint", "http://127.0.0.1:1/v1"], ["languageEndpoint", undefined]] as const) {
    assert.throws(() => postmeetingOnlineGatewayToml({ ...options, [name]: value }), /invalid scripted post-meeting endpoint/);
  }
});

function exchange(handler: (request: unknown, response: unknown) => void, route: string, body: string) {
  const request = Object.assign(new EventEmitter(), { url: route });
  const response = { statusCode: 200, headers: {} as Record<string, string>, chunks: [] as string[],
    setHeader(name: string, value: string) { this.headers[name] = value; },
    write(chunk: string) { this.chunks.push(chunk); }, end(chunk = "") { this.chunks.push(chunk); } };
  handler(request, response);
  request.emit("data", Buffer.from(body)); request.emit("end");
  return response;
}

const synthesis = JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "meeting synthesis" }] });

test("the fixture answers the online lane's synthesis as OpenAI-compatible events with the same placeholder body", () => {
  const provider = createFixtureProviderHandler();
  const response = exchange(provider.handler, "/v1/chat/completions", synthesis);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "text/event-stream");
  const events = response.chunks.join("").split("\n\n").filter(Boolean);
  assert.equal(events.at(-1), "data: [DONE]");
  const content = JSON.parse(JSON.parse(events[0]!.slice("data: ".length)).choices[0].delta.content);
  assert.deepEqual(content, { summary: "Scripted fixture provider output; no model read this meeting.", projects: [], decisions: [],
    action_items: [], discussion_points: [], person_summaries: [] });
  assert.deepEqual(provider.calls.map(({ route, outcome }: { route: string; outcome: string }) => ({ route, outcome })), [{ route: "chat", outcome: "ok" }]);
});

test("an armed synthesis failure is still observed as the chat failure the R1 oracles look for", () => {
  const provider = createFixtureProviderHandler();
  provider.armNextChatFailure();
  assert.equal(exchange(provider.handler, "/v1/chat/completions", synthesis).statusCode, 503);
  assert.ok(provider.calls.some((call: { route: string; outcome: string }) => call.route === "chat" && call.outcome === "armed_failure"));
});

test("provider-fault cuts end through the ordinary post-meeting swap, so they get the online configuration and an idle voice peer", async () => {
  // @ts-expect-error Test-only JavaScript module has no public declaration.
  const { PROVIDER_FAULT_CUTS } = await import("./provider-fault-oracles.mjs");
  // @ts-expect-error Test-only JavaScript module has no public declaration.
  const { publicationRequired } = await import("./run.mjs");
  const cuts = Object.keys(PROVIDER_FAULT_CUTS);
  assert.ok(cuts.length >= 5);
  for (const d2Cut of cuts) assert.equal(publicationRequired({ d2Cut }), true, d2Cut);
  const entry = readFileSync(new URL("entry.mjs", import.meta.url), "utf8");
  assert.match(entry, /unusedVoice: async \(\) => plan\.d2Cut === "repeated-close" \? null : startInteractiveProvider\(\),/);
  assert.match(entry, /\} else selectPostmeetingGatewayConfig\(provider\.endpoint, unusedVoice\);/, "only the R2 lane writes its own post-meeting configuration");
});

test("every e2e entry that processes an online meeting writes the online post-meeting configuration", () => {
  for (const name of ["entry.mjs", "recovery-entry.mjs"]) {
    const source = readFileSync(new URL(name, import.meta.url), "utf8");
    assert.match(source, /postmeetingOnlineGatewayToml\(/, name);
    assert.doesNotMatch(source, /postmeetingGatewayToml\(/, `${name} must not switch an online meeting's post-meeting lane to offline`);
  }
  const stage = readFileSync(new URL("stage.mjs", import.meta.url), "utf8");
  assert.match(stage, /const scripted = !expiryEvidence;/, "the scripted gateway is staged for every ordinary lane");
});
