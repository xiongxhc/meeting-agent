// D031: the Runtime enforces STRUCTURE, Meeting enforces BOUNDS.
//
// The Runtime refuses any output schema that uses a keyword outside its
// supported set, as a whole-schema guarantee, so a schema Meeting cannot
// spell to the Runtime is not "partly checked" — it is refused. These proofs
// pin the wire schema against a port of the Runtime's own rules, pin the
// wire schema against the local zod contract that remains the authority for
// bounds, and pin `maxOutputBytes` against the bound the installed SDK
// itself enforces.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import { RuntimeClient, StdioGatewayTransport, validateClientCommand } from "@conversation/runtime";

import {
  MAX_PROCESSED_OUTPUT_BYTES,
  TEAMMEM_TEXT_OUTPUT_SCHEMA,
  textSynthesisContract,
} from "../src/delivery/artifact-builder.ts";

// ---------------------------------------------------------------------------
// A port of the Runtime's schema rules. Ported, not copied: the Rust walks a
// serde Value, this walks a JSON value, and both admit exactly the six
// keywords and seven type names of crates/runtime/src/text_processing.rs.
// ---------------------------------------------------------------------------

const SUPPORTED_KEYWORDS = ["type", "properties", "required", "items", "enum", "additionalProperties"];
const SUPPORTED_TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"];
const MAX_SCHEMA_NODES = 256;
const MAX_SCHEMA_DEPTH = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns the Runtime's refusal reason, or null when the schema is admitted. */
function runtimeSchemaRefusal(schema: unknown): string | null {
  const counter = { nodes: 0 };
  const walk = (node: unknown, depth: number): string | null => {
    counter.nodes += 1;
    if (depth > MAX_SCHEMA_DEPTH) return "schema depth exceeded";
    if (counter.nodes > MAX_SCHEMA_NODES) return "schema node count exceeded";
    if (!isRecord(node)) return "schema member is not an object";
    for (const [keyword, value] of Object.entries(node)) {
      if (!SUPPORTED_KEYWORDS.includes(keyword)) return `unsupported keyword ${keyword}`;
      if (keyword === "type") {
        if (typeof value !== "string") return "type must be one string";
        if (!SUPPORTED_TYPES.includes(value)) return `unsupported type ${value}`;
      }
      if (keyword === "properties") {
        if (!isRecord(value)) return "properties must be an object";
        for (const property of Object.values(value)) {
          const refusal = walk(property, depth + 1);
          if (refusal !== null) return refusal;
        }
      }
      if (keyword === "required") {
        if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) return "required must be strings";
      }
      if (keyword === "items") {
        const refusal = walk(value, depth + 1);
        if (refusal !== null) return refusal;
      }
      if (keyword === "enum" && (!Array.isArray(value) || value.length === 0)) return "enum must be a non-empty array";
      if (keyword === "additionalProperties" && typeof value !== "boolean") return "additionalProperties must be a boolean";
    }
    return null;
  };
  return walk(schema, 0);
}

test("the port of the Runtime's rules refuses what the Runtime refuses", () => {
  assert.equal(runtimeSchemaRefusal({ type: "object" }), null);
  assert.equal(runtimeSchemaRefusal({ anyOf: [{ type: "null" }] }), "unsupported keyword anyOf");
  assert.equal(runtimeSchemaRefusal({ type: "string", minLength: 1 }), "unsupported keyword minLength");
  assert.equal(runtimeSchemaRefusal({ type: ["string", "null"] }), "type must be one string");
  assert.equal(runtimeSchemaRefusal({ type: "object", additionalProperties: {} }), "additionalProperties must be a boolean");
  assert.equal(runtimeSchemaRefusal({ enum: [] }), "enum must be a non-empty array");
  assert.equal(runtimeSchemaRefusal({ type: "object", properties: { a: { const: true } } }), "unsupported keyword const");
});

test("the wire synthesis schema uses only the keywords the Runtime enforces", () => {
  assert.equal(runtimeSchemaRefusal(TEAMMEM_TEXT_OUTPUT_SCHEMA), null);
});

// ---------------------------------------------------------------------------
// The wire schema and the zod contract cannot drift apart: same property
// names, same required lists, at every object level.
// ---------------------------------------------------------------------------

type Shape = { readonly properties: readonly string[]; readonly required: readonly string[]; readonly members: ReadonlyMap<string, Shape | null> };

/** The object shape of a wire schema node, descending through `items`. */
function wireShape(node: unknown): Shape | null {
  if (!isRecord(node)) return null;
  if (node["type"] === "array") return wireShape(node["items"]);
  if (node["type"] !== "object") return null;
  const properties = isRecord(node["properties"]) ? node["properties"] : {};
  const members = new Map<string, Shape | null>();
  for (const [name, member] of Object.entries(properties)) members.set(name, wireShape(member));
  return {
    properties: Object.keys(properties).sort(),
    required: [...(Array.isArray(node["required"]) ? node["required"] as string[] : [])].sort(),
    members,
  };
}

/** The same shape read off the zod contract that parses the answer, through
 * zod's public surface: `.shape` for an object, `.element` for an array,
 * `.unwrap()` for a nullable member. */
function zodShape(schema: unknown): Shape | null {
  const node = schema as { shape?: Record<string, unknown>; element?: unknown; unwrap?: () => unknown };
  // A `null | object` member is deliberately unconstrained on the wire
  // (D031), so the contract is its only shape; the proof below pins that.
  if (typeof node?.unwrap === "function" && node.shape === undefined) return null;
  if (node?.element !== undefined) return zodShape(node.element);
  if (node?.shape === undefined) return null;
  const members = new Map<string, Shape | null>();
  for (const [name, member] of Object.entries(node.shape)) members.set(name, zodShape(member));
  const names = Object.keys(node.shape).sort();
  return { properties: names, required: names, members };
}

function assertSameShape(wire: Shape | null, zod: Shape | null, at: string): void {
  if (zod === null) return;
  assert.ok(wire !== null, `${at}: the wire schema has no object shape where the contract has one`);
  assert.deepEqual(wire.properties, zod.properties, `${at}: property names differ`);
  assert.deepEqual(wire.required, zod.required, `${at}: required lists differ`);
  for (const [name, member] of zod.members) assertSameShape(wire.members.get(name) ?? null, member, `${at}.${name}`);
}

test("the wire schema and the local contract agree on every property name and required list", () => {
  assertSameShape(wireShape(TEAMMEM_TEXT_OUTPUT_SCHEMA), zodShape(textSynthesisContract), "synthesis");
});

test("nullable members stay required and unconstrained on the wire", () => {
  const items = (TEAMMEM_TEXT_OUTPUT_SCHEMA as { properties: Record<string, { items: Record<string, unknown> }> })
    .properties["action_items"]!.items;
  const properties = items["properties"] as Record<string, unknown>;
  assert.deepEqual(properties["owner"], {});
  assert.deepEqual(properties["due_date"], {});
  assert.ok((items["required"] as string[]).includes("owner"));
  assert.ok((items["required"] as string[]).includes("due_date"));
  // The contract still refuses an owner that is neither null nor the explicit shape.
  assert.throws(() => textSynthesisContract.parse({
    summary: "s", projects: [], decisions: [], discussion_points: [], person_summaries: [],
    action_items: [{ text: "t", owner: { person_id: "p" }, due_date: null, evidence_segment_ids: ["seg"] }],
  }));
});

// ---------------------------------------------------------------------------
// `maxOutputBytes` is the bound the installed SDK enforces, not a restatement.
// ---------------------------------------------------------------------------

function sdkAdmits(maxOutputBytes: number): boolean {
  try {
    validateClientCommand({
      type: "process_text", requestId: "output-bound-probe", sessionId: 1n, instructions: "i", input: "i",
      outputSchema: { type: "object" }, maxOutputBytes,
    }, 4);
    return true;
  } catch { return false; }
}

test("the artifact build asks for exactly the largest output the SDK admits", () => {
  assert.ok(sdkAdmits(MAX_PROCESSED_OUTPUT_BYTES), "the SDK must admit the bound the builder sends");
  assert.ok(!sdkAdmits(MAX_PROCESSED_OUTPUT_BYTES + 1), "the bound must be the SDK's largest admitted value");
  assert.ok(!sdkAdmits(1_000_000), "the pre-D031 value must stay refused");
});

// ---------------------------------------------------------------------------
// The packaged gateway answers the wire schema: no `unsupported_schema`, and
// the answer the offline fixture provider produces passes the local contract.
// ---------------------------------------------------------------------------

async function offlineGateway() {
  const binary = process.env["MEETING_TEST_RUNTIME_GATEWAY"];
  assert.ok(binary && path.isAbsolute(binary), "Prebuild the Runtime gateway and set MEETING_TEST_RUNTIME_GATEWAY; do not skip this proof");
  const root = mkdtempSync(path.join(os.tmpdir(), "meeting-wire-schema-"));
  const runtimeRoot = path.join(root, "runtime");
  mkdirSync(runtimeRoot, { mode: 0o700 });
  mkdirSync(path.join(runtimeRoot, "models"), { mode: 0o700 });
  mkdirSync(path.join(runtimeRoot, "recordings"), { mode: 0o700 });

  const answers: string[] = [];
  const provider = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (!(request.url ?? "").endsWith("/api/chat")) { response.end("{}"); return; }
      const content = JSON.stringify({
        summary: "Scripted fixture provider output; no model read this meeting.",
        projects: [], decisions: [], action_items: [], discussion_points: [], person_summaries: [],
      });
      answers.push(content);
      response.setHeader("content-type", "application/x-ndjson");
      response.write(`${JSON.stringify({ model: "synthetic", message: { role: "assistant", content }, done: false })}\n`);
      response.end(`${JSON.stringify({ model: "synthetic", message: { role: "assistant", content: "" }, done: true, total_duration: 1000, load_duration: 1, prompt_eval_count: 1, prompt_eval_duration: 1, eval_count: 1, eval_duration: 1 })}\n`);
    });
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;

  const config = path.join(runtimeRoot, "gateway.toml"), wrapper = path.join(runtimeRoot, "gateway-exec");
  const loader = path.resolve(import.meta.dirname, "fixtures/runtime-alignment-child.mjs");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const errorPath = path.join(runtimeRoot, "runtime-startup.log");
  const script = `${quote(process.execPath)} ${quote(loader)} ${quote(config)} || exit 2
IFS= read -r MEETING_TEST_RUNTIME_KEY < ${quote(path.join(runtimeRoot, "runtime-synthetic.key"))} || [ -n "$MEETING_TEST_RUNTIME_KEY" ] || exit 2
export MEETING_TEST_RUNTIME_KEY
exec ${quote(binary)} "$@"`;
  writeFileSync(wrapper, `#!/bin/sh\nexec /usr/bin/env -i PATH=${quote(process.env["PATH"] ?? "/usr/bin:/bin")} TMPDIR=${quote(runtimeRoot)} /bin/sh -c ${quote(script)} gateway-exec "$@" 2>${quote(errorPath)}\n`, { mode: 0o700 });
  writeFileSync(config, `schema_version = 3
profile = "offline"
privacy_mode = "local-only"
[language]
backend = "ollama-compatible"
execution = "local"
provider = "fixture-language"
provider_host = "fixture"
endpoint = "${endpoint}"
model = "synthetic"
thinking = false
temperature = 0.0
seed = 1
num_predict = 128
num_ctx = 1024
max_assistant_content_bytes = 65536
[persona]
mode = "direct-answer"
warmth = 50
humor = 50
teasing = 50
initiative = 50
directness = 50
intimacy = 50
verbosity = 50
follow_up_frequency = 50
[[provider_hosts]]
id = "fixture"
ownership = "external"
readiness_url = "${endpoint}/health"
startup_timeout_ms = 5000
environment = "inherit"
[voice.capture]
device = "system-default"
[voice.turn]
speech_start_ms = 200
final_silence_ms = 600
[voice.asr]
backend = "whisperkit"
execution = "local"
provider = "fixture-asr"
model_path = "${runtimeRoot}/models"
download = false
[voice.speech]
backend = "openai-compatible"
execution = "local"
provider = "fixture-speech"
provider_host = "fixture"
mode = "buffered"
endpoint = "${endpoint}/v1"
model = "fixture"
voice = "fixture"
speed = 1.0
language = "auto"
instructions = "fixture"
max_tokens = 128
repetition_penalty = 1.0
max_text_bytes = 4096
max_audio_bytes = 8388608
[voice.audio]
backend = "managed-sidecar"
execution = "local"
provider = "fixture-audio"
sidecar_executable = "/bin/sh"
max_error_bytes = 65536
[recording]
directory = "${runtimeRoot}/recordings"
key_env = "MEETING_TEST_RUNTIME_KEY"
[media]
bind = "127.0.0.1:0"
advertised_endpoint = "tcp://127.0.0.1:0"
credential_lifetime_ms = 60000
reconnect_window_ms = 10000
max_frames_per_second = 100
max_payload_bytes = 16384
max_outbound_queue_bytes = 262144
max_outbound_queue_ms = 10000
capture_format = "pcm_s16le/24000/1/20ms"
`, { mode: 0o600 });

  const transport = await StdioGatewayTransport.start({ gatewayPath: wrapper, configPath: config, protocolVersion: 4 });
  const client = await RuntimeClient.connect(transport, 4);
  return {
    client, answers,
    startupLog: () => { try { return readFileSync(errorPath, "utf8"); } catch { return ""; } },
    async close() {
      await client.close().catch(() => {});
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("the packaged gateway accepts the wire schema and its answer passes the contract", async () => {
  const boot = await offlineGateway();
  try {
    const sessionId = boot.client.currentSessionId;
    assert.ok(sessionId, boot.startupLog());
    const processed = await boot.client.processText({
      sessionId,
      instructions: "Produce only the requested factual meeting synthesis.",
      input: JSON.stringify([{ segment_id: "seg_001", text: "Atlas is ready.", speaker: { kind: "anonymous", cluster_id: "speaker_01" } }]),
      outputSchema: TEAMMEM_TEXT_OUTPUT_SCHEMA,
      maxOutputBytes: MAX_PROCESSED_OUTPUT_BYTES,
    });
    assert.equal(boot.answers.length >= 1, true, "the fixture provider answered the one call");
    const synthesis = textSynthesisContract.parse(processed.output);
    assert.equal(synthesis.projects.length, 0);
    assert.ok(synthesis.summary.length > 0);
  } finally {
    await boot.close();
  }
});
