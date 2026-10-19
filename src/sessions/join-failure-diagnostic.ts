// PRIVATE observation only: one attempt, one closed failure row, exit-only IO.
import { types } from "node:util";
import { writeJoinFailureDiagnostic } from "../adapters/filesystem-join-failure-diagnostic.ts";

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
  // The sink never throws, so the exit status is untouched.
  try { if (directory && !invalid && record) writeJoinFailureDiagnostic(directory, record); }
  finally { record = undefined; }
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
