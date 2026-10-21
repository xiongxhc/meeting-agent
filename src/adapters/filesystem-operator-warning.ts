import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { makeOccurrenceId } from "../domain/occurrence-id.ts";
import { operatorWarningKey, type OperatorWarningSink } from "../ports/operator-warning.ts";

const refused = () => new Error("operator warning inbox is unsafe or conflicting");

/** The application exclusively owns this private outbox; this is not an
 * atomic defence against a hostile same-UID process replacing ancestors. */
function verifyOwnedPath(filename: string, fd: number, directory: boolean): void {
  const named = lstatSync(filename, { bigint: true });
  const opened = fstatSync(fd, { bigint: true });
  if (named.isSymbolicLink() || named.dev !== opened.dev || named.ino !== opened.ino ||
      (directory ? !opened.isDirectory() : !opened.isFile()) ||
      (opened.mode & 0o777n) !== (directory ? 0o700n : 0o600n) ||
      process.getuid === undefined || opened.uid !== BigInt(process.getuid()) ||
      (!directory && opened.size > 4096n)) throw refused();
}

function openDirectory(filename: string): number {
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try { verifyOwnedPath(filename, fd, true); return fd; }
  catch (error) { closeSync(fd); throw error; }
}

export function createFilesystemOperatorWarningSink(options: {
  readonly outboxDir: string;
  /** Test-only failure seam, immediately before the respective fsync. */
  readonly durabilityCheckpoint?: (step: "file" | "directory") => void;
}): OperatorWarningSink {
  return { async accept({ key, payload }) {
    if (key !== operatorWarningKey(payload)) throw new Error("invalid operator warning key");
    const bytes = Buffer.from(JSON.stringify({
      schema: payload.schema, occurrenceId: payload.occurrenceId,
      stopAt: payload.stopAt, expiresAt: payload.expiresAt, reason: payload.reason,
    }) + "\n");
    return writeOperatorWarning(options, key, bytes);
  } };
}

type PublicationRefusalAlertInput = {
  readonly occurrenceId: string; readonly revision: number; readonly artifactHash: string; readonly reasonCode: string;
};

/** The operator alert for a revision TeamMem refused for good: identity, hash
 * and reason code only, never a title or meeting text. `raise` writes it
 * synchronously, once per exact refusal (a replay is a no-op); `clear` removes
 * exactly that file once the occurrence publishes (a missing file is a no-op). */
export function createFilesystemPublicationRefusalAlert(options: { readonly outboxDir: string }): {
  raise(alert: PublicationRefusalAlertInput): void;
  clear(alert: PublicationRefusalAlertInput): void;
} {
  return {
    raise(alert) {
      const { key, bytes } = refusalAlertFile(alert);
      writeOperatorWarning(options, key, bytes);
    },
    clear(alert) {
      const { key, bytes } = refusalAlertFile(alert);
      const root = path.resolve(options.outboxDir);
      const directory = path.join(root, "operator-warnings");
      let directoryFd: number;
      try { directoryFd = openDirectory(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      try {
        const filename = path.join(directory, `${key}.json`);
        let fd: number;
        try { fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
        try {
          verifyOwnedPath(filename, fd, false);
          if (!readFileSync(fd).equals(bytes)) throw refused();
        } finally { closeSync(fd); }
        unlinkSync(filename);
        fsyncSync(directoryFd);
      } finally { closeSync(directoryFd); }
    },
  };
}

function refusalAlertFile(alert: PublicationRefusalAlertInput): { key: string; bytes: Buffer } {
  const invalid = () => new Error("invalid publication refusal alert");
  const split = alert.occurrenceId.lastIndexOf("@");
  try {
    encodeURIComponent(alert.occurrenceId);
    if (split < 1 || alert.occurrenceId.length > 400 || makeOccurrenceId(alert.occurrenceId.slice(0, split), alert.occurrenceId.slice(split + 1)) !== alert.occurrenceId) throw invalid();
  } catch { throw invalid(); }
  if (!Number.isSafeInteger(alert.revision) || alert.revision < 1 || alert.revision > 1_000_000 ||
      !/^sha256:[0-9a-f]{64}$/.test(alert.artifactHash) || !/^[a-z][a-z0-9_]{0,63}$/.test(alert.reasonCode)) throw invalid();
  const schema = "meeting-publication-refusal-alert/v1";
  const key = createHash("sha256").update(JSON.stringify([schema, alert.occurrenceId, alert.revision, alert.artifactHash, alert.reasonCode])).digest("hex");
  return { key, bytes: Buffer.from(JSON.stringify({
    schema, occurrenceId: alert.occurrenceId, revision: alert.revision, artifactHash: alert.artifactHash,
    reason: "publication_refused", reasonCode: alert.reasonCode,
  }) + "\n") };
}

function writeOperatorWarning(options: { readonly outboxDir: string; readonly durabilityCheckpoint?: (step: "file" | "directory") => void },
  key: string, bytes: Buffer): { key: string } {
  if (bytes.length > 4096) throw new Error("invalid operator warning size");
  const root = path.resolve(options.outboxDir);
  const directory = path.join(root, "operator-warnings");
  const filename = path.join(directory, `${key}.json`);
  const rootFd = openDirectory(root);
  try {
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const directoryFd = openDirectory(directory);
    try {
      let fd: number;
      try {
        fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // Publish only a fully written/fsynced file. A hard crash may leave a
        // private .tmp orphan, but never poisons the stable key with a partial
        // final file. link is atomic no-replace, unlike rename.
        const staging = path.join(directory, `.${key}-${randomUUID()}.tmp`);
        const stageFd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          verifyOwnedPath(staging, stageFd, false);
          writeFileSync(stageFd, bytes);
          options.durabilityCheckpoint?.("file");
          fsyncSync(stageFd);
          verifyOwnedPath(staging, stageFd, false);
          verifyOwnedPath(directory, directoryFd, true);
          verifyOwnedPath(root, rootFd, true);
          try { linkSync(staging, filename); }
          catch (linkError) { if ((linkError as NodeJS.ErrnoException).code !== "EEXIST") throw linkError; }
        } finally {
          try { unlinkSync(staging); } finally { closeSync(stageFd); }
        }
        fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      }
      try {
        verifyOwnedPath(filename, fd, false);
        if (!readFileSync(fd).equals(bytes)) throw refused();
        // Replay never writes existing bytes. Multiple links are valid after
        // a crash between link and unlink of our private staging name.
        fsyncSync(fd);
        verifyOwnedPath(filename, fd, false);
        options.durabilityCheckpoint?.("directory");
        fsyncSync(directoryFd);
        fsyncSync(rootFd);
        verifyOwnedPath(directory, directoryFd, true);
        verifyOwnedPath(root, rootFd, true);
        return { key };
      } finally { closeSync(fd); }
    } finally { closeSync(directoryFd); }
  } finally { closeSync(rootFd); }
}
