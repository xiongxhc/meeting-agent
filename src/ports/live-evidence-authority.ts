import type { TimedEvidenceOwner } from "./session-store.ts";
declare const brand: unique symbol;
export type LiveRecoveryPermit = { readonly [brand]: never };
const permits = new WeakMap<object, TimedEvidenceOwner>();
/** Internal only; caller has awaited trusted prior-owner lifecycle proof. */
export function mintLiveRecoveryPermit(owner: TimedEvidenceOwner): LiveRecoveryPermit {
  const permit = Object.freeze({}) as LiveRecoveryPermit;
  permits.set(permit, { ...owner }); return permit;
}
export function consumeLiveRecoveryPermit(permit: LiveRecoveryPermit, owner: TimedEvidenceOwner): void {
  const bound = typeof permit === "object" && permit !== null ? permits.get(permit) : undefined;
  if (!bound || bound.storeIdentity !== owner.storeIdentity || bound.generationId !== owner.generationId || bound.token !== owner.token ||
    bound.occurrenceId !== owner.occurrenceId || bound.bridgeSessionId !== owner.bridgeSessionId || bound.runtimeSessionId !== owner.runtimeSessionId) throw new Error("invalid live recovery authority");
  permits.delete(permit);
}
