// The scripted bridge's answer to `renew_media_lease`, mirroring the Swift
// bridge (BridgeProcess.acceptRenewal + TimedMediaSession.renew): only a later
// expiry of the connected lease's own Runtime session is accepted, and the
// answer never touches capture.

const UINT = /^(0|[1-9][0-9]*)$/;
/** Null for a malformed renewal: the real bridge treats that as a protocol failure. */
export function parseLeaseRenewal(command) {
  const keys = Object.keys(command).sort().join(",");
  const renewal = command.leaseRenewal;
  if (keys !== "commandId,leaseRenewal,schema,sessionId,type" || renewal === null || typeof renewal !== "object" || Array.isArray(renewal)) return null;
  if (Object.keys(renewal).sort().join(",") !== "expiresAtMs,sessionId") return null;
  for (const value of [renewal.sessionId, renewal.expiresAtMs]) {
    if (typeof value !== "string" || !UINT.test(value) || value.length > 20 || BigInt(value) === 0n || BigInt(value) > 18446744073709551615n) return null;
  }
  return { sessionId: renewal.sessionId, expiresAtMs: BigInt(renewal.expiresAtMs) };
}

/** `lease` is the connected lease ({ sessionId, expiresAtMs: bigint }) or null; updated in place on ok. */
export function answerLeaseRenewal(lease, renewal, nowMs) {
  if (lease === null) return { outcome: "rejected", detail: "media_not_connected" };
  if (renewal.sessionId !== lease.sessionId) return { outcome: "rejected", detail: "media_session_mismatch" };
  if (renewal.expiresAtMs < lease.expiresAtMs) return { outcome: "rejected", detail: "lease_expiry_regressed" };
  if (renewal.expiresAtMs <= BigInt(nowMs)) return { outcome: "rejected", detail: "lease_expired" };
  lease.expiresAtMs = renewal.expiresAtMs;
  return { outcome: "ok", detail: null };
}
