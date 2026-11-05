// A meeting too long for one Runtime input, built through the pinned scripted
// gateway and the e2e fixture provider: every window and every reduce call
// crosses the real Runtime boundary (D047). No spine lane can inject a
// transcript this long, so the builder is driven directly.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { StdioGatewayTransport } from "@conversation/runtime";

import { connectPostmeetingRuntime } from "../src/adapters/conversation-runtime-client.ts";
import { buildTimedTeamMemMeetingArtifactV2, MAX_PROCESSING_INPUT_BYTES, type TimedArtifactBuildInput } from "../src/delivery/artifact-builder.ts";
import type { TimedReconciledSegment } from "../src/domain/transcript.ts";
import { buildInput, meeting } from "../test/fixtures/long-meeting.ts";
// @ts-expect-error Test-only JavaScript module has no public declaration.
import { postmeetingOnlineGatewayToml } from "./gateway-config.mjs";
// @ts-expect-error Test-only JavaScript fixture module has no public declaration.
import { createFixtureProviderHandler, startFixtureProvider } from "./fixture-provider.mjs";
// @ts-expect-error Test-only JavaScript module has no public declaration.
import { RUNTIME_PIN, verifyPins } from "./pins.mjs";

type Call = { readonly kind: "window" | "reduce"; readonly inputBytes: number; readonly segments: readonly string[]; outcome?: string };

async function throughGateway(segments: readonly TimedReconciledSegment[], options: {
  readonly citedProject?: { readonly name: string; readonly idsPerWindow: number }; readonly knownProjects?: readonly string[];
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "long-meeting-"));
  mkdirSync(path.join(root, "rec"), { mode: 0o700 });
  const provider = await startFixtureProvider({ citedProject: options.citedProject });
  const configPath = path.join(root, "gateway.toml");
  writeFileSync(configPath, postmeetingOnlineGatewayToml({ recordingsDir: path.join(root, "rec"), keyEnv: "E2E_RUNTIME_RECORDING_KEY",
    credentialEnv: "E2E_PROVIDER_CREDENTIAL", languageEndpoint: `${provider.endpoint}/v1`,
    recognitionEndpoint: `ws://${provider.endpoint.slice("http://".length)}/v1/realtime?intent=transcription`, speechEndpoint: `${provider.endpoint}/v1` }), { mode: 0o600 });
  const transport = await StdioGatewayTransport.start({ gatewayPath: RUNTIME_PIN.scriptedGateway.path, configPath, protocolVersion: 4,
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, TMPDIR: tmpdir(), E2E_RUNTIME_RECORDING_KEY: "ab".repeat(32), E2E_PROVIDER_CREDENTIAL: "synthetic-not-real" } });
  const connected = await connectPostmeetingRuntime(transport);
  const calls: Call[] = [];
  const runtime: TimedArtifactBuildInput["runtime"] = { async processText(request) {
    const input = JSON.parse(request.input) as { transcript?: { segment_id: string }[] };
    const call: Call = { kind: input.transcript === undefined ? "reduce" : "window", inputBytes: Buffer.byteLength(request.input),
      segments: input.transcript?.map(({ segment_id }) => segment_id) ?? [] };
    calls.push(call);
    try { const answer = await connected.processText(request); call.outcome = "ok"; return answer; }
    catch (error) { call.outcome = String(error); throw error; }
  } };
  try {
    const sessionId = connected.currentSessionId;
    if (typeof sessionId !== "bigint") throw new Error("the post-meeting Runtime supplied no control session identity");
    const built = await buildTimedTeamMemMeetingArtifactV2(buildInput(segments, runtime, { sessionId, ...(options.knownProjects === undefined ? {} : { knownProjects: options.knownProjects }) }));
    return { built, calls, chats: provider.calls.filter(({ route }: { route: string }) => route === "chat").length };
  } finally {
    await connected.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await provider.close();
  }
}

test("a 45-minute meeting builds through the pinned scripted Runtime in 17 windows and two reduce rounds", { timeout: 600_000 }, async () => {
  await verifyPins();
  const segments = meeting(45);
  const { built, calls, chats } = await throughGateway(segments);
  assert.deepEqual(calls.filter(({ outcome }) => outcome !== "ok"), []);
  const windows = calls.filter(({ kind }) => kind === "window");
  assert.equal(windows.length, 17);
  assert.deepEqual(calls.map(({ kind }) => kind), [...Array(17).fill("window"), ...Array(4).fill("reduce")]);
  assert.equal(chats, 21, "one provider chat per call: no schema retry");
  // Every segment is sent exactly once, in artifact order, and every input fits.
  const sent = windows.flatMap(({ segments: ids }) => ids);
  assert.equal(sent.length, segments.length);
  assert.deepEqual(sent, built.artifact.transcript.map(({ segment_id }) => segment_id));
  assert.equal(new Set(sent).size, segments.length);
  assert.ok(calls.every(({ inputBytes }) => inputBytes <= MAX_PROCESSING_INPUT_BYTES));
  assert.equal(built.artifact.summary, "Scripted fixture provider output; no model read this meeting.");
  assert.deepEqual(built.artifact.processing_warnings.slice(-2), [
    { code: "synthesis_reduced", detail: "the 17 window summaries were merged by the model in 2 reduce round(s) of 3, 1 call(s)" },
    { code: "synthesis_windowed", detail: `transcript synthesized in 17 windows covering all ${segments.length} segments` },
  ]);
});

test("a published project cited across all 17 windows, 119 IDs in all, builds through the pinned scripted Runtime with 100 of them and a warning", { timeout: 600_000 }, async () => {
  await verifyPins();
  const { built, calls, chats } = await throughGateway(meeting(45), { citedProject: { name: "Payments", idsPerWindow: 7 }, knownProjects: ["Payments"] });
  assert.deepEqual(calls.filter(({ outcome }) => outcome !== "ok"), []);
  const windows = calls.filter(({ kind }) => kind === "window").map(({ segments: ids }) => ids);
  assert.equal(windows.length, 17);
  assert.equal(chats, 21, "no extra model call");
  // Seven IDs in each of 17 windows: the first 15 windows keep six, the last two keep five, in transcript order.
  const kept = windows.flatMap((ids, index) => (index < 15 ? [0, 1, 2, 4, 5, 6] : [0, 2, 3, 4, 6]).map((at) => ids[at]!));
  assert.deepEqual(built.artifact.projects, [{ name: "Payments", evidence_segment_ids: kept }]);
  assert.deepEqual(built.artifact.processing_warnings.slice(-3), [
    { code: "evidence_thinned", detail: 'projects item "Payments": kept 100 of 119 evidence segment IDs, spread across the 17 windows that cite it' },
    { code: "synthesis_reduced", detail: "the 17 window summaries were merged by the model in 2 reduce round(s) of 3, 1 call(s)" },
    { code: "synthesis_windowed", detail: "transcript synthesized in 17 windows covering all 674 segments" },
  ]);
});

test("a meeting that fits one input still makes one call through the pinned scripted Runtime", { timeout: 120_000 }, async () => {
  const { built, calls, chats } = await throughGateway(meeting(1));
  assert.deepEqual(calls.map(({ kind, outcome }) => ({ kind, outcome })), [{ kind: "window", outcome: "ok" }]);
  assert.equal(chats, 1);
  assert.ok(!built.artifact.processing_warnings.some(({ code }) => code.startsWith("synthesis_")));
});

test("the fixture answers a merge with the placeholder and one summary for each person its parts name", () => {
  const provider = createFixtureProviderHandler();
  const parts = [{ first_window: 1, last_window: 1, summary: "a", person_summaries: [{ person_id: "ou_ada", display_name: "Ada", text: "x" }] },
    { first_window: 2, last_window: 2, summary: "b", person_summaries: [{ person_id: "ou_ada", display_name: "Ada", text: "y" }, { person_id: "ou_ben", display_name: "Ben", text: "z" }] }];
  const body = JSON.stringify({ model: "m", stream: true, messages: [{ role: "system", content: "Merge these per-window syntheses" }, { role: "user", content: JSON.stringify({ parts }) }] });
  const request = Object.assign(new EventEmitter(), { url: "/v1/chat/completions" });
  const chunks: string[] = [];
  provider.handler(request, { statusCode: 200, setHeader() {}, write(chunk: string) { chunks.push(chunk); }, end(chunk = "") { chunks.push(chunk); } });
  request.emit("data", Buffer.from(body)); request.emit("end");
  const content = JSON.parse(JSON.parse(chunks.join("").split("\n\n")[0]!.slice("data: ".length)).choices[0].delta.content);
  assert.deepEqual(content, { summary: "Scripted fixture provider output; no model read this meeting.", person_summaries: [
    { person_id: "ou_ada", display_name: "Ada", text: "Scripted fixture provider merge; no model read this meeting." },
    { person_id: "ou_ben", display_name: "Ben", text: "Scripted fixture provider merge; no model read this meeting." }] });
});
