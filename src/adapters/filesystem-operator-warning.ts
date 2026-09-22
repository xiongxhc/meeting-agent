import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

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
  } };
}
