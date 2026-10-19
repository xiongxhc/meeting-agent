// PRIVATE join-failure diagnostic sink: one exclusive, no-follow 0600 file.
import { constants, closeSync, lstatSync, openSync, realpathSync, writeSync } from "node:fs";
import path from "node:path";

/** Writes `record` once into `<directory>/join-failure.json` only when the
 * directory is a real (non-symlink, canonical) 0700 directory. Never throws:
 * a missing or partial export is missing evidence, never admission. */
export function writeJoinFailureDiagnostic(directory: string, record: object): void {
  let fd: number | undefined;
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || realpathSync(directory) !== directory) return;
    fd = openSync(path.join(directory, "join-failure.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeSync(fd, JSON.stringify(record) + "\n");
  } catch { /* Missing/partial export is missing evidence, never admission. */ }
  finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* Exit status is untouched. */ } }
  }
}
