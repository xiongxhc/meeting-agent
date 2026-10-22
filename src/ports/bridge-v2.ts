// Opt-in producer contract only. The existing application does not select v2.
import type { BridgeCommandMessageV2, BridgeLeaseRenewalCommandV2 } from "../contracts/bridge-session-v2.ts";
export type { BridgeCommandV2, BridgeLeaseRenewalCommandV2, BridgeEventV2, BridgeCommandMessageV2, BridgeEventMessageV2, TimedMediaLease, MediaLeaseRenewal, ObservationTiming, UiSnapshot } from "../contracts/bridge-session-v2.ts";
export type BridgeTransportV2 = {
  send(message: BridgeCommandMessageV2): Promise<void>;
  subscribe(listener: (raw: unknown) => void): () => void;
  onClosed?(listener: () => void): () => void;
};

/**
 * Forwards a renewed media-lease expiry to the bridge, so its reconnect
 * admission follows the Runtime's renewal. Bound to one Runtime session; only a
 * strictly later expiry is sent, and the forwarded expiry advances only once
 * the command was written. The answer arrives as a `command_result`.
 */
export type BridgeMediaLeaseRenewer = {
  /** True when a command was sent; false when the expiry is not later. */
  forward(expiresAtMs: bigint): Promise<boolean>;
  expiresAtMs(): bigint;
};

export function createBridgeMediaLeaseRenewer(
  sessionId: bigint,
  initialExpiresAtMs: bigint,
  issue: (command: BridgeLeaseRenewalCommandV2) => Promise<void>,
): BridgeMediaLeaseRenewer {
  let forwarded = initialExpiresAtMs;
  return {
    async forward(expiresAtMs) {
      if (expiresAtMs <= forwarded) return false;
      await issue({ type: "renew_media_lease", leaseRenewal: { sessionId: sessionId.toString(), expiresAtMs: expiresAtMs.toString() } });
      if (expiresAtMs > forwarded) forwarded = expiresAtMs;
      return true;
    },
    expiresAtMs: () => forwarded,
  };
}
