import type { AlignmentAttempt } from "./session-store.ts";

declare const recoveryPermitBrand: unique symbol;
export type AlignmentRecoveryPermit = { readonly [recoveryPermitBrand]: never };
const permits = new WeakMap<object, AlignmentAttempt>();

/** Internal application-authority seam, deliberately absent from package exports.
 * Call only after owned cleanup or the trusted supervisor proof has completed. */
export function mintAlignmentRecoveryPermit(attempt: AlignmentAttempt): AlignmentRecoveryPermit {
  const permit = Object.freeze({}) as AlignmentRecoveryPermit;
  permits.set(permit, { ...attempt });
  return permit;
}

export function consumeAlignmentRecoveryPermit(permit: AlignmentRecoveryPermit, attempt: AlignmentAttempt): void {
  const bound = typeof permit === "object" && permit !== null ? permits.get(permit) : undefined;
  if (!bound || bound.storeIdentity !== attempt.storeIdentity || bound.generationId !== attempt.generationId ||
    bound.attemptId !== attempt.attemptId || bound.ownerId !== attempt.ownerId || bound.token !== attempt.token) {
    throw new Error("invalid alignment recovery authority");
  }
  permits.delete(permit);
}
