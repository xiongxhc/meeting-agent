// Opt-in producer contract only. The existing application does not select v2.
import type { BridgeCommandMessageV2 } from "../contracts/bridge-session-v2.ts";
export type { BridgeCommandV2, BridgeEventV2, BridgeCommandMessageV2, BridgeEventMessageV2, TimedMediaLease, ObservationTiming, UiSnapshot } from "../contracts/bridge-session-v2.ts";
export type BridgeTransportV2 = {
  send(message: BridgeCommandMessageV2): Promise<void>;
  subscribe(listener: (raw: unknown) => void): () => void;
};
