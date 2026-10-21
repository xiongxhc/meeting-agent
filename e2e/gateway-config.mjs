// The two deployment configurations the packaged gateway is started with.
//
// The shipped Meeting client pins the Runtime profile to "online" for every
// timed voice admission (src/adapters/conversation-runtime-client.ts), and the
// gateway refuses a session whose requested profile differs from its own
// (apps/runtime-gateway/src/session.rs). An online gateway in turn requires
// remote HTTPS/WSS provider endpoints on a non-loopback host, so a local run
// can reach no language, transcription or speech provider at all.
//
// The live configuration therefore names unreachable `.invalid` providers:
// the session starts, the media lease is issued and the recorder runs, while
// speech recognition fails with `recovery: "continue_session"`. No transcript
// turn can be produced that way, and none is faked.
//
// A meeting's profile is pinned for its post-meeting processing too, and
// Meeting refuses a post-meeting Runtime in another profile. The post-meeting
// configuration is therefore the same online deployment plus loopback
// scripted providers (the launcher routes a `[scripted_providers]`
// configuration to the separately pinned scripted gateway), pointed at the
// SAME recordings directory and recording key, so the backfill lane's
// alignment traversal and its one `processText` call are answered by a local
// fixture rather than invented. The offline fixture-provider configuration
// remains for runs whose live session is itself offline (calibration).

const PERSONA = `[persona]
mode = "direct-answer"
warmth = 50
humor = 50
teasing = 50
initiative = 50
directness = 50
intimacy = 50
verbosity = 50
follow_up_frequency = 50
`;

function media(bind, { credentialLifetimeMs = 60000, reconnectWindowMs = 10000, maxOutboundQueueMs = 10000 } = {}) {
  if (![credentialLifetimeMs, reconnectWindowMs, maxOutboundQueueMs].every(value => Number.isSafeInteger(value) && value > 0) || reconnectWindowMs > credentialLifetimeMs || maxOutboundQueueMs > reconnectWindowMs) throw new Error("invalid synthetic media timing");
  return `[media]
bind = "${bind}"
advertised_endpoint = "tcp://${bind}"
credential_lifetime_ms = ${credentialLifetimeMs}
reconnect_window_ms = ${reconnectWindowMs}
max_frames_per_second = 100
max_payload_bytes = 16384
max_outbound_queue_bytes = 262144
max_outbound_queue_ms = ${maxOutboundQueueMs}
capture_format = "pcm_s16le/24000/1/20ms"
`;
}

function recording(directory, keyEnv) {
  return `[recording]
directory = "${directory}"
key_env = "${keyEnv}"
`;
}

/** Online profile, unreachable providers: the only profile the shipped client admits. */
export function liveGatewayToml({ recordingsDir, keyEnv, credentialEnv }) {
  return `schema_version = 3
profile = "online"
privacy_mode = "cloud"
[language]
backend = "openai-compatible"
execution = "remote"
provider = "e2e-unreachable-language"
endpoint = "https://meeting-e2e.invalid/v1"
model = "e2e-text-model"
credential_env = "${credentialEnv}"
thinking = false
temperature = 0.0
seed = 1
num_predict = 128
num_ctx = 1024
max_assistant_content_bytes = 65536
${PERSONA}[voice]
response_mode = "external_gate"
${media("127.0.0.1:0")}[voice.capture]
device = "system-default"
[voice.turn]
speech_start_ms = 200
final_silence_ms = 600
[voice.asr]
backend = "openai-streaming"
execution = "remote"
provider = "e2e-unreachable-asr"
endpoint = "wss://meeting-e2e.invalid/v1/realtime?intent=transcription"
model = "e2e-asr-model"
credential_env = "${credentialEnv}"
[voice.asr.server_vad]
threshold = 0.5
prefix_padding_ms = 300
silence_duration_ms = 500
[voice.speech]
backend = "openai-compatible"
execution = "remote"
provider = "e2e-unreachable-speech"
mode = "streaming"
streaming_interval = 0.2
endpoint = "https://meeting-e2e.invalid/v1"
model = "e2e-speech-model"
voice = "e2e-voice"
credential_env = "${credentialEnv}"
speed = 1.0
language = "auto"
instructions = "scripted"
max_tokens = 128
repetition_penalty = 1.0
max_text_bytes = 4096
max_audio_bytes = 8388608
[voice.audio]
backend = "managed-sidecar"
execution = "local"
provider = "e2e-audio"
sidecar_executable = "/bin/sh"
max_error_bytes = 65536
${recording(recordingsDir, keyEnv)}`;
}

/** Test-only entry; the production loader continues to refuse this table. */
export function interactiveGatewayToml(options) {
  return `${liveGatewayToml(options)}\n[scripted_providers]\nlanguage = "${options.endpoint}"\nrecognition = "${options.recognitionEndpoint}"\nspeech = "${options.endpoint}"\n`;
}

/** Post-meeting lane in the live session's online profile. Language answers
 * the synthesis; recognition and speech are an idle peer post-meeting work
 * never calls. Every scripted endpoint is loopback with an explicit port. */
export function postmeetingOnlineGatewayToml({ recordingsDir, keyEnv, credentialEnv, languageEndpoint, recognitionEndpoint, speechEndpoint }) {
  for (const [value, scheme] of [[languageEndpoint, "http"], [recognitionEndpoint, "ws"], [speechEndpoint, "http"]]) {
    if (typeof value !== "string" || !new RegExp(`^${scheme}://127\\.0\\.0\\.1:[1-9][0-9]*/`).test(value) || /["\\\s]/.test(value))
      throw new Error("invalid scripted post-meeting endpoint");
  }
  return `${liveGatewayToml({ recordingsDir, keyEnv, credentialEnv })}\n[scripted_providers]\nlanguage = "${languageEndpoint}"\nrecognition = "${recognitionEndpoint}"\nspeech = "${speechEndpoint}"\n`;
}

/** Offline profile with the accepted local fixture provider host. */
export function postmeetingGatewayToml({ recordingsDir, keyEnv, modelsDir, fixtureEndpoint, mediaTiming }) {
  return `schema_version = 3
profile = "offline"
privacy_mode = "local-only"
[language]
backend = "ollama-compatible"
execution = "local"
provider = "e2e-fixture-language"
provider_host = "fixture"
endpoint = "${fixtureEndpoint}"
model = "synthetic"
thinking = false
temperature = 0.0
seed = 1
num_predict = 128
num_ctx = 1024
max_assistant_content_bytes = 65536
${PERSONA}[[provider_hosts]]
id = "fixture"
ownership = "external"
readiness_url = "${fixtureEndpoint}/health"
startup_timeout_ms = 5000
environment = "inherit"
${media("127.0.0.1:0", mediaTiming)}[voice.capture]
device = "system-default"
[voice.turn]
speech_start_ms = 200
final_silence_ms = 600
[voice.asr]
backend = "whisperkit"
execution = "local"
provider = "e2e-fixture-asr"
model_path = "${modelsDir}"
download = false
[voice.speech]
backend = "openai-compatible"
execution = "local"
provider = "e2e-fixture-speech"
provider_host = "fixture"
mode = "buffered"
endpoint = "${fixtureEndpoint}/v1"
model = "fixture"
voice = "fixture"
speed = 1.0
language = "auto"
instructions = "scripted"
max_tokens = 128
repetition_penalty = 1.0
max_text_bytes = 4096
max_audio_bytes = 8388608
[voice.audio]
backend = "managed-sidecar"
execution = "local"
provider = "e2e-fixture-audio"
sidecar_executable = "/bin/sh"
max_error_bytes = 65536
${recording(recordingsDir, keyEnv)}`;
}
