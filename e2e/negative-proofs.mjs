import { Buffer } from "node:buffer";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { processCleanupProof } from "./process-evidence.mjs";
import { PROVIDER_CREDENTIAL, PROVIDER_CREDENTIAL_ENV, RECORDING_KEY_ENV } from "./stage.mjs";

function walkFiles(root, errors, skip = []) {
  const files = [];
  const visit = (directory) => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { errors.push(`${directory}: directory scan failed`); return; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (skip.some((prefix) => target.startsWith(prefix))) continue;
      if (entry.isSymbolicLink()) { errors.push(`${target}: symlink cannot establish absence`); continue; }
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  visit(root);
  return files;
}

export function keyPresent(staged) {
  try { return /^[0-9a-f]{64}$/.test(readFileSync(staged.keyPath, "utf8").trim()); } catch { return false; }
}

export function recordedProcessProof({ staged, live, probe }) {
  const knownPids = [];
  try {
    for (const line of readFileSync(staged.gatewayPidsPath, "utf8").split("\n").map(value => value.trim()).filter(Boolean)) {
      knownPids.push({ role: "gateway", pid: /^[1-9][0-9]*$/.test(line) ? Number(line) : null });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") knownPids.push({ role: "gateway_pid_file_unavailable", pid: null });
  }
  if (live.childState?.pid !== undefined) knownPids.push({ role: "bridge_child", pid: live.childState.pid });
  return processCleanupProof({ evidence: live.processEvidence, knownPids, probe });
}

export function negativeProofs({ staged, live, teammem, outDir, probe }) {
  const key = existsSync(staged.keyPath) ? readFileSync(staged.keyPath, "utf8").trim() : null;
  const secret = readFileSync(staged.appSecretFile, "utf8").trim();
  const scanErrors = [];
  const scanned = [
    ...walkFiles(staged.directories.recordingsDir, scanErrors),
    ...walkFiles(staged.directories.outboxDir, scanErrors),
    ...walkFiles(staged.directories.receiptsDir, scanErrors),
    ...walkFiles(staged.directories.control, scanErrors),
    ...walkFiles(staged.directories.stateRoot, scanErrors),
    // The staged key file is the one place the key belongs.
    ...walkFiles(staged.directories.runtimeRoot, scanErrors, [staged.directories.runtimeKeyDir]),
    ...walkFiles(outDir, scanErrors),
    ...walkFiles(staged.directories.teammem, scanErrors, [path.join(staged.directories.teammem, "src"), path.join(staged.directories.teammem, "wheel-venv"), path.join(staged.directories.teammem, "wheelhouse")]),
    ...[staged.launcherLog, teammem?.paths.envFile].filter((file) => file && existsSync(file)),
  ];
  const leaks = { key: [], secret: [], credential: [] };
  const needles = [
    ["key", key], ["secret", secret], ["credential", PROVIDER_CREDENTIAL],
  ].filter(([, value]) => typeof value === "string" && value.length >= 16).map(([name, value]) => [name, Buffer.from(value, "utf8")]);
  // The key is staged as hex text; its raw 32 bytes must not appear either.
  if (typeof key === "string" && /^[0-9a-f]{64}$/.test(key)) needles.push(["key", Buffer.from(key, "hex")]);
  for (const file of scanned) {
    let bytes;
    try { bytes = readFileSync(file); } catch { scanErrors.push(`${file}: file scan failed`); continue; }
    for (const [name, needle] of needles) {
      if (bytes.includes(needle) && !leaks[name].includes(file)) leaks[name].push(file);
    }
  }
  // The harness's own evidence copies are scanned too, after they are written.
  const envLeaks = [];
  if (!live.childState || !live.summary?.entryEnvKeys || !teammem?.env) envLeaks.push("mandatory process environment evidence missing");
  const childEnvKeys = live.childState?.envKeys ?? [];
  for (const [role, keys] of [["bridge", childEnvKeys], ["meeting", live.summary?.entryEnvKeys ?? []], ["teammem", Object.keys(teammem?.env ?? {})]]) {
    for (const name of [RECORDING_KEY_ENV, PROVIDER_CREDENTIAL_ENV, "FEISHU_APP_SECRET"]) {
      if (keys.includes(name)) envLeaks.push(`${role} environment carried ${name}`);
    }
  }
  const permissions = [[staged.root, 0o700], [staged.directories.runtimeKeyDir, 0o700], [staged.keyPath, 0o600]].map(([filename, mode]) => {
    try { const info = lstatSync(filename); return { path: filename, valid: !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o777) === mode }; }
    catch { return { path: filename, valid: false }; }
  });

  // Plaintext audio: a silent pcm_s16le frame is 960 NUL bytes; neither the
  // encrypted recording nor the published audio may contain such a run, and
  // neither may carry a WAV/RIFF container header.
  const audioFiles = [
    ...walkFiles(staged.directories.recordingsDir, scanErrors),
    ...(live.artifact?.audioPath ? [live.artifact.audioPath] : []),
    ...walkFiles(teammem?.paths.audioStore ?? staged.directories.recordingsDir, scanErrors),
  ];
  const pcmMarkers = [];
  const zeroRun = Buffer.alloc(960);
  const speechMarker = Buffer.alloc(64), voicedMarker = Buffer.alloc(64);
  for (let i = 0; i < 32; i += 1) {
    speechMarker.writeInt16LE(0x1234, i * 2);
    voicedMarker.writeInt16LE(Math.round(20_000 * Math.sin(i * 2 * Math.PI * 440 / 24_000)), i * 2);
  }
  for (const file of new Set(audioFiles)) {
    let bytes;
    try { bytes = readFileSync(file); } catch { scanErrors.push(`${file}: file scan failed`); continue; }
    if (bytes.subarray(0, 4).toString("latin1") === "RIFF" || bytes.includes(Buffer.from("WAVEfmt "))) pcmMarkers.push(`${file}: container header`);
    if (bytes.includes(zeroRun)) pcmMarkers.push(`${file}: 960-byte silent PCM run`);
    if (bytes.includes(speechMarker) || bytes.includes(voicedMarker)) pcmMarkers.push(`${file}: scripted speech/capture PCM marker`);
  }
  // Meeting's own store may hold zero-filled pages, so only the scripted
  // speech/capture markers apply there, not the silent-frame run.
  for (const file of walkFiles(staged.directories.stateRoot, scanErrors)) {
    let bytes;
    try { bytes = readFileSync(file); } catch { scanErrors.push(`${file}: file scan failed`); continue; }
    if (bytes.includes(speechMarker) || bytes.includes(voicedMarker)) pcmMarkers.push(`${file}: scripted speech/capture PCM marker`);
  }

  const processCleanup = recordedProcessProof({ staged, live, probe });
  const { pids, orphans } = processCleanup;

  const trace = live.summary?.trace ?? [];
  const storeClosedAt = trace.lastIndexOf("shutdown_store_closed");
  const afterStoreClose = storeClosedAt === -1 ? ["shutdown_store_closed_absent"] : trace.slice(storeClosedAt + 1);

  const identities = new Set();
  for (const row of live.reopen?.rows.sessions ?? []) if (row.occurrence_id) identities.add(row.occurrence_id);
  for (const row of live.reopen?.rows.delivery ?? []) if (row.occurrence_id) identities.add(row.occurrence_id);
  if (live.artifact?.occurrenceId) identities.add(live.artifact.occurrenceId);
  for (const entry of live.receipt?.checks ?? []) if (entry.occurrenceMatchesArtifact === false) identities.add("receipt-mismatch");

  return { scannedFiles: scanned.length, scanErrors, leaks, envLeaks, permissions, pcmMarkers, pids, orphans, processCleanup, afterStoreClose, identities: [...identities] };
}
