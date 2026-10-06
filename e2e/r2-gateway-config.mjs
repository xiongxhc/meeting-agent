// Additive scripted-entry configuration. Production TLS/profile rules stay intact.
import { Buffer } from "node:buffer";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { URL } from "node:url";
import { liveGatewayToml } from "./gateway-config.mjs";

function invalid() { throw new Error("Invalid R2 gateway configuration."); }
function safeText(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /["\\]/.test(value)
      || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) invalid();
  return value;
}
function endpoint(value, protocol, scripted) {
  safeText(value);
  if (Buffer.byteLength(value) > 2048) invalid();
  let parsed;
  try { parsed = new URL(value); } catch { invalid(); }
  if (parsed.protocol !== `${protocol}:` || parsed.username || parsed.password || parsed.hash || !parsed.hostname) invalid();
  if ((protocol === "http" || protocol === "https") && value.includes("?")) invalid();
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (scripted) {
    if (host !== "127.0.0.1" || !parsed.port || Number(parsed.port) < 1) invalid();
  } else if (host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || host.startsWith("127.")
      || host === "0.0.0.0" || host === "[::]" || isIP(host.replace(/^\[|\]$/g, ""))) invalid();
  return value;
}

/** All authority/endpoint inputs are caller-issued, with no fixture defaults. */
export function r2GatewayToml(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) invalid();
  const { recordingsDir, keyEnv, credentialEnv, languageEndpoint, recognitionEndpoint, speechEndpoint, diarizationEndpoint, scriptedProviders } = options;
  safeText(recordingsDir);
  if (!isAbsolute(recordingsDir) || recordingsDir === "/" || recordingsDir.split("/").includes("..")) invalid();
  for (const name of [keyEnv, credentialEnv]) if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) invalid();
  const replacements = new Map([
    ["language", endpoint(languageEndpoint, "https", false)],
    ["voice.asr", endpoint(recognitionEndpoint, "wss", false)],
    ["voice.speech", endpoint(speechEndpoint, "https", false)],
  ]);
  endpoint(diarizationEndpoint, "https", false);
  if (!scriptedProviders || typeof scriptedProviders !== "object" || Array.isArray(scriptedProviders)) invalid();
  for (const name of ["language", "recognition", "speech", "diarization"]) endpoint(scriptedProviders[name], name === "recognition" ? "ws" : "http", true);
  // Replace only one known endpoint property in each exact deployment section.
  // Refuse unexpected baseline shape rather than guessing at a changed template.
  const expected = new Map([
    ["language", 'endpoint = "https://meeting-e2e.invalid/v1"'],
    ["voice.asr", 'endpoint = "wss://meeting-e2e.invalid/v1/realtime?intent=transcription"'],
    ["voice.speech", 'endpoint = "https://meeting-e2e.invalid/v1"'],
  ]);
  const seenSections = new Set(), seenEndpoints = new Set();
  let section = "";
  const base = liveGatewayToml({ recordingsDir, keyEnv, credentialEnv }).split("\n").map(line => {
    if (line.startsWith("[")) {
      section = line.slice(1, -1);
      if (replacements.has(section)) {
        if (seenSections.has(section)) invalid();
        seenSections.add(section);
      }
    }
    if (replacements.has(section) && line.startsWith("endpoint = ")) {
      if (line !== expected.get(section) || seenEndpoints.has(section)) invalid();
      seenEndpoints.add(section);
      return `endpoint = "${replacements.get(section)}"`;
    }
    return line;
  }).join("\n");
  if (seenEndpoints.size !== 3 || seenSections.size !== 3) invalid();
  return `${base}[voice.diarization]\nbackend = "openai"\nexecution = "remote"\nprovider = "r2-scripted-diarization"\nmodel = "r2-scripted-diarization-model"\nendpoint = "${diarizationEndpoint}"\ncredential_env = "${credentialEnv}"\n\n[scripted_providers]\nlanguage = "${scriptedProviders.language}"\nrecognition = "${scriptedProviders.recognition}"\nspeech = "${scriptedProviders.speech}"\ndiarization = "${scriptedProviders.diarization}"\n`;
}
