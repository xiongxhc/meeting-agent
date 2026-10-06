import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error Test-only JavaScript module has no public declaration.
import { liveGatewayToml, postmeetingGatewayToml } from "./gateway-config.mjs";
// @ts-expect-error Test-only JavaScript module has no public declaration.
const module = await import("./r2-gateway-config.mjs").catch(() => ({}));
const options = {
  recordingsDir: "/private/issued-recordings", keyEnv: "R2_RECORDING_KEY", credentialEnv: "R2_PROVIDER_CREDENTIAL",
  languageEndpoint: "https://language.example.invalid/v1", recognitionEndpoint: "wss://recognition.example.invalid/v1/realtime?intent=transcription",
  speechEndpoint: "https://speech.example.invalid/v1", diarizationEndpoint: "https://diarization.example.invalid/v1",
  scriptedProviders: { language: "http://127.0.0.1:12001/v1", recognition: "ws://127.0.0.1:12002/v1/realtime?intent=transcription", speech: "http://127.0.0.1:12003/v1", diarization: "http://127.0.0.1:12004/v1" },
};
function config(values: Record<string, unknown> = options) {
  const create = Reflect.get(module, "r2GatewayToml");
  assert.equal(typeof create, "function", "additive R2 online configuration helper must exist");
  return create(values);
}
function section(text: string, name: string) { return text.split(`[${name}]\n`)[1]?.split(/\n\[/)[0]; }
// Wrong table/endpoint replacement, lost online policy or missing issued authority must fail.
test("R2 config supplies separate accepted remote deployment and explicit four scripted overrides", () => {
  const text = config();
  assert.match(text, /^schema_version = 3\nprofile = "online"\nprivacy_mode = "cloud"/);
  assert.match(section(text, "language")!, /endpoint = "https:\/\/language.example.invalid\/v1"/);
  assert.match(section(text, "voice.asr")!, /endpoint = "wss:\/\/recognition.example.invalid\/v1\/realtime\?intent=transcription"/);
  assert.match(section(text, "voice.speech")!, /endpoint = "https:\/\/speech.example.invalid\/v1"/);
  assert.equal(section(text, "voice.diarization"), 'backend = "openai"\nexecution = "remote"\nprovider = "r2-scripted-diarization"\nmodel = "r2-scripted-diarization-model"\nendpoint = "https://diarization.example.invalid/v1"\ncredential_env = "R2_PROVIDER_CREDENTIAL"\n');
  assert.equal(section(text, "scripted_providers"), 'language = "http://127.0.0.1:12001/v1"\nrecognition = "ws://127.0.0.1:12002/v1/realtime?intent=transcription"\nspeech = "http://127.0.0.1:12003/v1"\ndiarization = "http://127.0.0.1:12004/v1"\n');
  assert.match(section(text, "recording")!, /directory = "\/private\/issued-recordings"\nkey_env = "R2_RECORDING_KEY"/);
  assert.equal((text.match(/credential_env = "R2_PROVIDER_CREDENTIAL"/g) ?? []).length, 4);
  assert.doesNotMatch(text, /meeting-e2e.invalid|tls|insecure|local-only/);
});
test("R2 refuses absent arguments, TOML injection, relative authority and unsafe endpoints without fallback", () => {
  for (const name of Object.keys(options)) {
    const bad = { ...options }; delete (bad as Record<string, unknown>)[name];
    assert.throws(() => config(bad), /Invalid R2 gateway configuration/);
  }
  for (const [name, value] of [["recordingsDir", "relative"], ["recordingsDir", '/private/x"\n[evil]'], ["keyEnv", "bad-name"], ["credentialEnv", "secret value"],
    ["languageEndpoint", "http://language.example.invalid/v1"], ["speechEndpoint", "https://127.0.0.1/v1"], ["diarizationEndpoint", "https://localhost/v1"],
    ["recognitionEndpoint", "ws://recognition.example.invalid"], ["languageEndpoint", "https://user:secret@example.invalid"], ["languageEndpoint", "https://example.invalid/#fragment"],
    ["languageEndpoint", "https://example.invalid/" + "x".repeat(2048)]])
    assert.throws(() => config({ ...options, [name as string]: value }), /Invalid R2 gateway configuration/);
  for (const name of Object.keys(options.scriptedProviders)) {
    const bad = { ...options.scriptedProviders }; delete (bad as Record<string, unknown>)[name];
    assert.throws(() => config({ ...options, scriptedProviders: bad }), /Invalid R2 gateway configuration/);
  }
  for (const value of ["http://production.example.com/v1", "http://127.0.0.1/v1", "http://user:secret@127.0.0.1:12/v1", "http://127.0.0.1:12/v1#fragment", "ws://127.0.0.1:12/v1"])
    assert.throws(() => config({ ...options, scriptedProviders: { ...options.scriptedProviders, diarization: value } }), /Invalid R2 gateway configuration/);
});
test("additive helper leaves original live and R1 offline configuration behavior intact", () => {
  const before = liveGatewayToml(options);
  const offlineOptions = { recordingsDir: options.recordingsDir, keyEnv: options.keyEnv, modelsDir: "/private/models", fixtureEndpoint: "http://127.0.0.1:12" };
  const r1Before = postmeetingGatewayToml(offlineOptions);
  config();
  assert.equal(liveGatewayToml(options), before); assert.equal(postmeetingGatewayToml(offlineOptions), r1Before);
  assert.match(before, /https:\/\/meeting-e2e.invalid\/v1/); assert.doesNotMatch(before, /voice.diarization|scripted_providers/);
  assert.match(r1Before, /profile = "offline"/); assert.match(r1Before, /backend = "ollama-compatible"/); assert.doesNotMatch(r1Before, /voice.diarization|scripted_providers/);
});
// Runtime refuses query presence (including a trailing empty '?') on HTTP(S).
test("all six HTTP endpoint fields refuse nonempty and empty queries while WS recognition retains queries", () => {
  for (const suffix of ["?x=1", "?"]) {
    for (const field of ["languageEndpoint", "speechEndpoint", "diarizationEndpoint"] as const)
      assert.throws(() => config({ ...options, [field]: options[field] + suffix }), /Invalid R2 gateway configuration/);
    for (const field of ["language", "speech", "diarization"] as const)
      assert.throws(() => config({ ...options, scriptedProviders: { ...options.scriptedProviders, [field]: options.scriptedProviders[field] + suffix } }), /Invalid R2 gateway configuration/);
  }
  for (const query of ["?intent=transcription&language=en", "?"]) {
    const recognitionEndpoint = "wss://recognition.example.invalid/v1/realtime" + query;
    const recognition = "ws://127.0.0.1:12002/v1/realtime" + query;
    const text = config({ ...options, recognitionEndpoint, scriptedProviders: { ...options.scriptedProviders, recognition } });
    assert.ok(section(text, "voice.asr")?.includes(`endpoint = "${recognitionEndpoint}"`));
    assert.ok(section(text, "scripted_providers")?.includes(`recognition = "${recognition}"`));
  }
});
