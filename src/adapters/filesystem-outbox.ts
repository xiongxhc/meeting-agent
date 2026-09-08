// The durable TeamMem handoff.  This module deliberately owns only the local
// filesystem protocol; it never opens TeamMem storage or performs a network
// send.

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { canonicalArtifactHash, canonicalArtifactJson, parseTeamMemMeetingArtifact, type TeamMemMeetingArtifact } from "../contracts/teammem-meeting-v1.ts";
import { occurrencePathSegment, type OccurrenceId } from "../domain/occurrence-id.ts";

const NAMES = ["meeting.json", "audio.enc", "manifest.json", "READY"] as const;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const OWNER = "OWNER";

export type WriteMeetingBundleInput = {
  readonly recordingsDir: string;
  readonly outboxDir: string;
  readonly artifact: TeamMemMeetingArtifact;
  /** Task 8's already-canonical bytes: delivery must not reserialize them. */
  readonly serializedArtifact: string;
  readonly artifactHash: string;
  /** The exact finalized recording path persisted by the coordinator. */
  readonly recordingPath: string;
  /** Test-only crash seam. Production callers do not provide this. */
  readonly fault?: (step: OutboxFaultPoint) => void;
  /** Test-only directory durability probe. */
  readonly directoryFsync?: (directory: string) => void;
};

export type OutboxFaultPoint =
  | "before_meeting_write" | "after_meeting_write"
  | "before_audio_write" | "after_audio_write"
  | "before_manifest_write" | "after_manifest_write"
  | "before_staging_fsync" | "after_staging_fsync"
  | "before_rename" | "after_rename"
  | "before_ready_write" | "after_ready_write"
  | "before_bundle_fsync" | "after_bundle_fsync";

/** Writes a complete ready bundle, or leaves no TeamMem-visible partial bundle. */
export function writeMeetingBundle(input: WriteMeetingBundleInput): string {
  const artifact = parseTeamMemMeetingArtifact(input.artifact);
  const canonical = canonicalArtifactJson(artifact);
  const canonicalHash = canonicalArtifactHash(artifact);
  if (input.serializedArtifact !== canonical || input.artifactHash !== canonicalHash) {
    throw new Error("artifact bytes or hash are not Task 8 canonical output");
  }
  const outboxCreated = !existsSync(path.resolve(input.outboxDir));
  const outbox = safeDirectory(input.outboxDir, true, "outbox");
  if (outboxCreated) fsyncDirectory(path.dirname(outbox), input);
  const recordings = safeDirectory(input.recordingsDir, false, "recordings");
  const audio = readVerifiedRecording(recordings, input.recordingPath, artifact);
  const segment = occurrencePathSegment(artifact.occurrence_id as OccurrenceId);
  const revision = String(artifact.revision);
  const occurrenceDir = path.join(outbox, segment);
  assertPathUnderRoot(outbox, occurrenceDir, false);
  const occurrenceCreated = !existsSync(occurrenceDir);
  mkdirSync(occurrenceDir, { recursive: true, mode: 0o700 });
  assertPathUnderRoot(outbox, occurrenceDir, true);
  if (occurrenceCreated) fsyncDirectory(outbox, input);
  const destination = path.join(occurrenceDir, revision);
  const manifest = canonicalManifest(artifact, canonicalHash, audio);

  if (existsSync(destination)) {
    assertPathUnderRoot(outbox, destination, true);
    if (existsSync(path.join(destination, "READY"))) {
      verifyExistingBundle(destination, canonical, canonicalHash, audio, manifest);
      return destination;
    }
    removeIncompleteDestination(destination);
  }

  const staging = path.join(occurrenceDir, `.${revision}.staging-${randomUUID()}`);
  assertPathUnderRoot(outbox, staging, false);
  mkdirSync(staging, { mode: 0o700 });
  writeDurable(path.join(staging, OWNER), Buffer.from(String(process.pid), "ascii"));
  fsyncDirectory(occurrenceDir, input);
  try {
    checkpoint(input, "before_meeting_write");
    writeDurable(path.join(staging, "meeting.json"), Buffer.from(canonical, "utf8"));
    checkpoint(input, "after_meeting_write");
    checkpoint(input, "before_audio_write");
    writeDurable(path.join(staging, "audio.enc"), audio);
    checkpoint(input, "after_audio_write");
    checkpoint(input, "before_manifest_write");
    writeDurable(path.join(staging, "manifest.json"), Buffer.from(manifest, "utf8"));
    checkpoint(input, "after_manifest_write");
    checkpoint(input, "before_staging_fsync");
    fsyncDirectory(staging, input);
    checkpoint(input, "after_staging_fsync");
    checkpoint(input, "before_rename");
    rmSync(path.join(staging, OWNER));
    fsyncDirectory(staging, input);
    renameSync(staging, destination);
    checkpoint(input, "after_rename");
    fsyncDirectory(occurrenceDir, input);
    // READY is deliberately last: a consumer treats its existence as the
    // visibility commit for the directory above.
    checkpoint(input, "before_ready_write");
    writeDurable(path.join(destination, "READY"), Buffer.alloc(0));
    checkpoint(input, "after_ready_write");
    checkpoint(input, "before_bundle_fsync");
    fsyncDirectory(destination, input);
    checkpoint(input, "after_bundle_fsync");
    fsyncDirectory(occurrenceDir, input);
    return destination;
  } catch (error) {
    // Staging is private.  It is safe to discard only our uniquely owned
    // staging directory; a visible destination is left for idempotent replay.
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function checkpoint(input: WriteMeetingBundleInput, step: OutboxFaultPoint): void {
  input.fault?.(step);
}

/** Removes only paths previously derived by this adapter after the delivery
 * journal has recorded an accepted complete receipt or the exact deadline. */
export function deleteDeliveredEvidence(input: {
  readonly recordingsDir: string;
  readonly outboxDir: string;
  readonly occurrenceId: string;
  readonly revision: number;
  readonly recordingPath: string;
  readonly bundlePath: string;
}): void {
  const outbox = safeDirectory(input.outboxDir, false, "outbox");
  const expected = path.join(outbox, occurrencePathSegment(input.occurrenceId as OccurrenceId), String(input.revision));
  if (path.resolve(input.bundlePath) !== expected) throw new Error("refusing to delete a bundle outside its occurrence and revision");
  assertPathUnderRoot(outbox, expected, false);
  removeRegularOwnedFile(safeDirectory(input.recordingsDir, false, "recordings"), input.recordingPath);
  removeOwnedBundle(outbox, expected);
  removeAbandonedStages(outbox, path.dirname(expected), input.revision);
}

function safeDirectory(directory: string, create: boolean, label: string): string {
  const resolved = path.resolve(directory);
  if (create) mkdirSync(resolved, { recursive: true, mode: 0o700 });
  requireDirectoryNotLink(resolved, label);
  return resolved;
}

function requireDirectoryNotLink(directory: string, label: string): void {
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a real directory`);
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Lexical containment follows symlinked parents. Validate every extant path
 * component below the configured root before a read, write, or removal. */
function assertPathUnderRoot(root: string, target: string, requireTarget: boolean): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  requireDirectoryNotLink(resolvedRoot, "configured root");
  if (!isInside(resolvedRoot, resolvedTarget)) throw new Error("path escapes configured root");
  const parts = path.relative(resolvedRoot, resolvedTarget).split(path.sep);
  let current = resolvedRoot;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    const final = index === parts.length - 1;
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error("path contains a symlink");
      if (!final && !stat.isDirectory()) throw new Error("path has a non-directory ancestor");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && (!final || !requireTarget)) return;
      throw error;
    }
  }
}

function readVerifiedRecording(recordings: string, recordingPath: string, artifact: TeamMemMeetingArtifact): Buffer {
  const target = path.resolve(recordingPath);
  assertPathUnderRoot(recordings, target, true);
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("recording must be a regular non-symlink file");
  const bytes = readFileSync(target);
  if (looksLikePlaintextAudio(bytes)) throw new Error("recording appears to be plaintext audio, not encrypted bytes");
  if (bytes.length !== artifact.audio.bytes) throw new Error("recording byte count does not match artifact");
  const digest = sha256(bytes);
  if (digest !== artifact.audio.sha256) throw new Error("recording hash does not match artifact");
  return bytes;
}

function looksLikePlaintextAudio(bytes: Buffer): boolean {
  return bytes.subarray(0, 4).equals(Buffer.from("RIFF"))
    || bytes.subarray(0, 4).equals(Buffer.from("OggS"))
    || bytes.subarray(0, 4).equals(Buffer.from("fLaC"))
    || bytes.subarray(0, 3).equals(Buffer.from("ID3"))
    || bytes.subarray(4, 8).equals(Buffer.from("ftyp"))
    || (bytes[0] === 0xff && bytes[1] !== undefined && bytes[1] >= 0xe0);
}

function canonicalManifest(artifact: TeamMemMeetingArtifact, artifactHash: string, audio: Buffer): string {
  const audioSha = sha256(audio);
  if (!SHA256.test(artifactHash) || audioSha !== artifact.audio.sha256 || audio.length !== artifact.audio.bytes) {
    throw new Error("manifest integrity claims are invalid");
  }
  return `${JSON.stringify({
    artifact_hash: artifactHash,
    audio_bytes: audio.length,
    audio_sha256: audioSha,
    occurrence_id: artifact.occurrence_id,
    revision: artifact.revision,
    schema: "teammem-meeting-manifest/v1",
  })}\n`;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function writeDurable(filename: string, content: Buffer): void {
  writeFileSync(filename, content, { mode: 0o600, flag: "wx" });
  const fd = openSync(filename, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function fsyncDirectory(directory: string, input?: Pick<WriteMeetingBundleInput, "directoryFsync">): void {
  input?.directoryFsync?.(path.resolve(directory));
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function verifyExistingBundle(destination: string, artifact: string, artifactHash: string, audio: Buffer, manifest: string): void {
  const dir = lstatSync(destination);
  if (dir.isSymbolicLink() || !dir.isDirectory()) throw new Error("existing bundle is not a regular directory");
  const names = readdirSync(destination).sort();
  const expectedNames = [...NAMES].sort();
  if (names.length !== expectedNames.length || names.some((name, i) => name !== expectedNames[i])) throw new Error("existing bundle has an unexpected entry");
  for (const name of NAMES) {
    const file = lstatSync(path.join(destination, name));
    if (file.isSymbolicLink() || !file.isFile()) throw new Error("existing bundle has a non-regular entry");
  }
  if (readFileSync(path.join(destination, "meeting.json"), "utf8") !== artifact
    || !readFileSync(path.join(destination, "audio.enc")).equals(audio)
    || readFileSync(path.join(destination, "manifest.json"), "utf8") !== manifest
    || !readFileSync(path.join(destination, "READY")).equals(Buffer.alloc(0))) {
    throw new Error(`artifact revision is immutable: conflicting content (${artifactHash})`);
  }
}

/** A crash after rename but before READY leaves a directory no consumer may
 * use. It is safe to remove only if every entry is an expected regular payload
 * file; otherwise refuse rather than erasing unknown evidence. */
function removeIncompleteDestination(destination: string): void {
  const dir = lstatSync(destination);
  if (dir.isSymbolicLink() || !dir.isDirectory()) throw new Error("incomplete bundle is not a regular directory");
  const allowed = new Set(["meeting.json", "audio.enc", "manifest.json"]);
  for (const name of readdirSync(destination)) {
    if (!allowed.has(name)) throw new Error("incomplete bundle has an unexpected entry");
    const item = lstatSync(path.join(destination, name));
    if (item.isSymbolicLink() || !item.isFile()) throw new Error("incomplete bundle has a non-regular entry");
  }
  rmSync(destination, { recursive: true });
}

function removeRegularOwnedFile(root: string, filename: string): void {
  const target = path.resolve(filename);
  try {
    assertPathUnderRoot(root, target, true);
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("refusing to delete non-regular recording");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  rmSync(target);
}

function removeOwnedBundle(root: string, bundle: string): void {
  const target = path.resolve(bundle);
  try {
    assertPathUnderRoot(root, target, true);
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("refusing to delete non-directory bundle");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  rmSync(target, { recursive: true });
}

/** Private staging carries its creator PID until just before atomic rename.
 * A dead process leaves recoverable encrypted bytes; a live owner is skipped
 * so receipt/deadline cleanup cannot erase a concurrent writer. */
function removeAbandonedStages(root: string, occurrenceDir: string, revision: number): void {
  try { assertPathUnderRoot(root, occurrenceDir, true); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const prefix = `.${revision}.staging-`;
  for (const name of readdirSync(occurrenceDir)) {
    if (!name.startsWith(prefix)) continue;
    const stage = path.join(occurrenceDir, name);
    assertPathUnderRoot(root, stage, true);
    const stat = lstatSync(stage);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("refusing to delete unsafe staging directory");
    if (stageOwnerIsLive(stage)) continue;
    rmSync(stage, { recursive: true });
  }
}

function stageOwnerIsLive(stage: string): boolean {
  const owner = path.join(stage, OWNER);
  try {
    const stat = lstatSync(owner);
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    const raw = readFileSync(owner, "ascii");
    const pid = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(pid) || pid <= 0 || String(pid) !== raw) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
