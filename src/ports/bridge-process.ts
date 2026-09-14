import type { CustodyBinding, BridgeProcessOutcome } from "../contracts/bridge-process-outcome-v1.ts";
import type { BridgeTransport } from "./bridge.ts";

export type BridgeProcessFailure = "launch_failed" | "protocol_failed" | "outcome_missing" | "child_failed" | "reap_failed" | "cleanup_failed";
export type BridgeShutdownResult = {
  readonly reaped: boolean;
  readonly outcome: BridgeProcessOutcome | null;
  readonly failure: BridgeProcessFailure | null;
  /** Process audit only; never proves or vetoes physical departure. */
  readonly exitDiagnostic: "nonzero_exit" | null;
};
export type OwnedBridgeProcess = {
  readonly bridge: BridgeTransport;
  /** Idempotent, awaited, bounded cleanup; never equates exit with departure. */
  shutdown(): Promise<BridgeShutdownResult>;
};
export type BridgeProcessSlot = {
  readonly physicalClientId: string;
  readonly bridgeId: string;
  /** No operation before this call may spawn or write bridge control. */
  launch(binding: CustodyBinding): Promise<OwnedBridgeProcess>;
};
