// PRIVATE observation only: one attempt, one closed failure row, exit-only IO.
import { constants, closeSync, lstatSync, openSync, realpathSync, writeSync } from "node:fs";
import path from "node:path";
import { types } from "node:util";

type Phase = "lease_setup" | "timed_control" | "subscriptions" | "join_send" | "join_cancel_check" |
  "runtime_admission" | "admitted_binding" | "admission_cancel_check" | "connect_media_send" |
  "media_cancel_check" | "disclosure" | "disclosure_cancel_check";
const phases: readonly Phase[] = ["lease_setup", "timed_control", "subscriptions", "join_send", "join_cancel_check",
  "runtime_admission", "admitted_binding", "admission_cancel_check", "connect_media_send", "media_cancel_check", "disclosure", "disclosure_cancel_check"];
type Failure = { schema: "join-failure-diagnostic/v1"; phase: Phase; errorClass: "native_error" | "unknown" };
const directory = process.env.MEETING_PRIVATE_JOIN_DIAGNOSTIC_DIR;
let attempted = false, invalid = false, flushed = false;
let record: Failure | undefined;

function flushJoinFailureDiagnostic(): void {
  if (flushed) return;
  flushed = true;
  let fd: number | undefined;
  try {
    if (!directory || invalid || !record) return;
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || realpathSync(directory) !== directory) return;
    fd = openSync(path.join(directory, "join-failure.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeSync(fd, JSON.stringify(record) + "\n");
  } catch { /* Missing/partial export is missing evidence, never admission. */ }
  finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* Exit status is untouched. */ } }
    record = undefined;
  }
}
// Disabled imports register no listener and factories return no observer.
if (directory) { try { process.once("exit", flushJoinFailureDiagnostic); } catch { invalid = true; } }

export function createJoinFailureDiagnostic() {
  if (!directory || invalid || flushed) return undefined;
  if (attempted) { invalid = true; record = undefined; return undefined; }
  attempted = true;
  let current: Phase = "lease_setup", failed = false;
  return {
    phase(value: Phase): void {
      try {
        if (failed || invalid || flushed) return;
        if (!phases.includes(value)) { invalid = true; record = undefined; return; }
        current = value;
      } catch { invalid = true; record = undefined; }
    },
    fail(error: unknown): void {
      try {
        if (failed || invalid || flushed) return;
        failed = true;
        // Native tagging inspects no user properties/prototypes, including
        // Proxy/revoked Proxy/accessor/custom-prototype throw values.
        record = { schema: "join-failure-diagnostic/v1", phase: current,
          errorClass: types.isNativeError(error) ? "native_error" : "unknown" };
      } catch { invalid = true; record = undefined; }
    },
  };
}
