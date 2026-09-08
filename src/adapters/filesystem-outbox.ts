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
  rmdirSync,
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
  /** Persisted Runtime handle for production callers. */
  readonly recordingHandle?: string | null;
  /** Durable delivery capability from the local journal. Never reaches READY. */
  readonly stageToken?: string;
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

export type DeleteFaultPoint = "after_recording_detach" | "after_bundle_detach" | "after_stage_detach";

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
  const audio = readVerifiedRecording(recordings, input.recordingPath, artifact, input.recordingHandle ?? undefined);
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

  const stageToken = input.stageToken ?? randomUUID().replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/.test(stageToken)) throw new Error("delivery stage token is invalid");
  const staging = path.join(occurrenceDir, `.${revision}.staging-${stageToken}`);
  assertPathUnderRoot(outbox, staging, false);
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  writeDurableOrVerify(path.join(staging, OWNER), Buffer.from(stageToken, "ascii"));
  fsyncDirectory(occurrenceDir, input);
  checkpoint(input, "before_meeting_write");
    writeDurableOrVerify(path.join(staging, "meeting.json"), Buffer.from(canonical, "utf8"));
    checkpoint(input, "after_meeting_write");
    checkpoint(input, "before_audio_write");
    writeDurableOrVerify(path.join(staging, "audio.enc"), audio);
    checkpoint(input, "after_audio_write");
    checkpoint(input, "before_manifest_write");
    writeDurableOrVerify(path.join(staging, "manifest.json"), Buffer.from(manifest, "utf8"));
    checkpoint(input, "after_manifest_write");
    checkpoint(input, "before_staging_fsync");
    fsyncDirectory(staging, input);
    checkpoint(input, "after_staging_fsync");
    checkpoint(input, "before_rename");
    try { rmSync(path.join(staging, OWNER)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    fsyncDirectory(staging, input);
    try { renameSync(staging, destination); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      verifyExistingBundle(destination, canonical, canonicalHash, audio, manifest);
      return destination;
    }
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
  readonly stageToken?: string;
  readonly recordingHandle?: string | null;
  /** The worker decides source eligibility from all owned journal rows. */
  readonly deleteRecording?: boolean;
  /** Test-only process-cut seam, invoked after atomic detach before removal. */
  readonly fault?: (step: DeleteFaultPoint) => void;
}): void {
  const outbox = safeDirectory(input.outboxDir, false, "outbox");
  const expected = path.join(outbox, occurrencePathSegment(input.occurrenceId as OccurrenceId), String(input.revision));
  if (path.resolve(input.bundlePath) !== expected) throw new Error("refusing to delete a bundle outside its occurrence and revision");
  const handle = requireRecordingHandle(input.recordingPath, input.recordingHandle ?? undefined);
  const token = input.stageToken ?? "0".repeat(32);
  const suffix = `${token}-${handle}-${input.revision}`;
  if (input.deleteRecording !== false) {
    removeRegularOwnedFile(safeDirectory(input.recordingsDir, false, "recordings"), input.recordingPath, `.recording-delete-${suffix}`, input.fault);
  }
  removeOwnedBundle(outbox, expected, `.bundle-delete-${suffix}`, input.fault);
  removeAbandonedStages(outbox, path.dirname(expected), input.revision, input.stageToken, suffix, input.fault);
  removeEmptyOccurrence(outbox, path.dirname(expected));
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

function readVerifiedRecording(recordings: string, recordingPath: string, artifact: TeamMemMeetingArtifact, persistedHandle?: string): Buffer {
  const target = path.resolve(recordingPath);
  assertPathUnderRoot(recordings, target, true);
  if (path.dirname(target) !== recordings) throw new Error("recording must be a direct child of the configured recordings root");
  requireRecordingHandle(target, persistedHandle);
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

function writeDurableOrVerify(filename: string, content: Buffer): void {
  try {
    writeDurable(filename, content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const current = lstatSync(filename);
    if (current.isSymbolicLink() || !current.isFile() || !readFileSync(filename).equals(content)) {
      throw new Error("delivery stage has conflicting content");
    }
  }
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
  // The destination is a direct child of its occurrence directory. Detach it
  // first so a later component swap cannot make recursive removal traverse a
  // caller-controlled path.
  detachAndRemove(path.dirname(destination), destination, "incomplete");
}

function removeRegularOwnedFile(root: string, filename: string, tombstone: string, fault?: (step: DeleteFaultPoint) => void): void {
  const target = path.resolve(filename);
  try {
    assertPathUnderRoot(root, target, true);
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("refusing to delete non-regular recording");
    if (path.dirname(target) !== root) throw new Error("recording must be a direct child of the configured recordings root");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  detachAndRemove(root, target, tombstone, fault, "after_recording_detach");
}

function removeOwnedBundle(root: string, bundle: string, tombstone: string, fault?: (step: DeleteFaultPoint) => void): void {
  const target = path.resolve(bundle);
  const detached = path.join(path.dirname(target), tombstone);
  if (!existsSync(target)) {
    if (existsSync(detached)) detachAndRemove(path.dirname(target), target, tombstone, fault, "after_bundle_detach");
    return;
  }
  try {
    assertPathUnderRoot(root, target, true);
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("refusing to delete non-directory bundle");
    assertPathUnderRoot(root, path.dirname(target), true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !existsSync(detached)) return;
    throw error;
  }
  detachAndRemove(path.dirname(target), target, tombstone, fault, "after_bundle_detach");
}

function removeEmptyOccurrence(root: string, occurrence: string): void {
  try {
    assertPathUnderRoot(root, occurrence, true);
    if (path.dirname(occurrence) !== root || !lstatSync(occurrence).isDirectory()) return;
    // rmdir is intentionally non-recursive: a concurrent or unowned stage
    // keeps its parent and is never detached by another token's cleanup.
    rmdirSync(occurrence);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTEMPTY") return;
    throw error;
  }
}

function detachAndRemove(root: string, target: string, tombstoneName: string, fault?: (step: DeleteFaultPoint) => void, step?: DeleteFaultPoint): void {
  const tombstone = path.join(root, tombstoneName);
  assertPathUnderRoot(root, tombstone, false);
  if (!existsSync(target) && existsSync(tombstone)) {
    removeDetached(tombstone);
    return;
  }
  try { renameSync(target, tombstone); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !existsSync(tombstone)) return;
    throw error;
  }
  if (step !== undefined) fault?.(step);
  removeDetached(tombstone);
}

function removeDetached(tombstone: string): void {
  const detached = lstatSync(tombstone);
  if (detached.isSymbolicLink()) rmSync(tombstone);
  else if (detached.isFile()) rmSync(tombstone);
  else if (detached.isDirectory()) rmSync(tombstone, { recursive: true, force: true });
  else throw new Error("refusing to remove detached special file");
}

/** Private stages are owned by a durable journal capability. PID liveness is
 * deliberately irrelevant: a restarted worker can finish the same stage. */
function removeAbandonedStages(root: string, occurrenceDir: string, revision: number, expectedToken: string | undefined, suffix: string, fault?: (step: DeleteFaultPoint) => void): void {
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
    if (!stageOwnerMatches(stage, expectedToken)) continue;
    detachAndRemove(occurrenceDir, stage, `.stage-delete-${suffix}`, fault, "after_stage_detach");
  }
}

function requireRecordingHandle(recordingPath: string, persistedHandle?: string): string {
  const fromName = /^([0-9a-f]{32})\.crsr$/.exec(path.basename(recordingPath))?.[1];
  if (fromName === undefined) throw new Error("recording basename must be a 32-lowercase-hex Runtime handle plus .crsr");
  if (persistedHandle !== undefined && (!/^[0-9a-f]{32}$/.test(persistedHandle) || persistedHandle !== fromName)) {
    throw new Error("recording basename does not match persisted Runtime handle");
  }
  return fromName;
}

function stageOwnerMatches(stage: string, expectedToken?: string): boolean {
  const owner = path.join(stage, OWNER);
  try {
    const stat = lstatSync(owner);
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    const raw = readFileSync(owner, "ascii");
    return /^[0-9a-f]{32}$/.test(raw) && (expectedToken === undefined || raw === expectedToken);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
