// Run from a fresh external consumer after installing BOTH real tarballs.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { RuntimeClient } from "@conversation/runtime";
import { createConversationRuntimeClient, RecordingAlignmentOwner, openSessionStore } from "meeting-agent";

const root = process.cwd(), meeting = path.join(root, "node_modules/meeting-agent");
assert.equal(typeof openSessionStore, "function"); assert.equal(typeof RecordingAlignmentOwner, "function");
const messages = new Readable({ objectMode: true, read() {} });
messages.push({ type: "ready", protocol_version: 4, current_session_id: "42", status: { profile: "offline", transport: "stdio",
  privacy_mode: "local_only", language_location: "local", model_id: "synthetic", memory_enabled: false, memory_location: null,
  telemetry_enabled: false, capabilities: ["text"], components: [{ kind: "language_model", execution_location: "local", provider_label: "Synthetic" }], last_context_seed_operation_id: null } });
const client = await RuntimeClient.connect({ messages, async send() {}, async close() { messages.push(null); } }, 4);
const runtime = createConversationRuntimeClient(client);
assert.equal(typeof runtime.readRecordingAlignment, "function");
await assert.rejects(runtime.startVoiceSession({ profile: "online", responseMode: "external_gate" }), /Task 11/);
await runtime.close();

const secretPath = path.join(root, "synthetic-app-secret");
writeFileSync(secretPath, "synthetic-package-only-secret", { mode: 0o600 });
const env = { PATH: process.env.PATH, MEETING_AGENT_FEISHU_APP_ID: "synthetic-app",
  MEETING_AGENT_FEISHU_APP_SECRET_FILE: secretPath, MEETING_AGENT_RUNTIME_ENDPOINT: "https://runtime.invalid:9443",
  MEETING_AGENT_RUNTIME_PROFILE: "online", MEETING_AGENT_ALIASES: "Synthetic",
  MEETING_AGENT_RECORDINGS_DIR: path.join(root, "recordings"), MEETING_AGENT_OUTBOX_DIR: path.join(root, "outbox"),
  MEETING_AGENT_RECEIPTS_DIR: path.join(root, "receipts"), MEETING_AGENT_TEAM_VAULT_DIR: path.join(root, "vault") };
function start() {
  const result = spawnSync("npm", ["start", "--silent"], { cwd: meeting, env, encoding: "utf8", timeout: 15000, maxBuffer: 65536 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 1);
  assert.equal(result.stderr.includes("synthetic-package-only-secret"), false);
  return result.stderr;
}
assert.match(start(), /adapter composition is required/);
const sdkPath = path.join(root, "node_modules/@conversation/runtime"), parked = path.join(root, "parked-sdk");
renameSync(sdkPath, parked);
try { assert.match(start(), /Runtime SDK prerequisite missing or incompatible/); }
finally { renameSync(parked, sdkPath); }
const index = path.join(sdkPath, "dist/src/index.js"), original = readFileSync(index);
writeFileSync(index, Buffer.concat([original, Buffer.from("\n// synthetic incompatible build\n")]));
try { assert.match(start(), /Runtime SDK prerequisite missing or incompatible/); }
finally { writeFileSync(index, original); }
process.stdout.write("External package roots/types and installed/missing/wrong SDK startup prerequisites verified; no live composition.\n");
