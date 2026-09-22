import { createHash } from "node:crypto";

import { makeOccurrenceId } from "../domain/occurrence-id.ts";

/** Private operator metadata, never a TeamMem artifact or organizer message. */
export type OperatorWarningPayload = {
  readonly schema: "meeting-operator-warning/v1";
  readonly occurrenceId: string;
  /** Canonical millisecond UTC; the original immutable calendar deadlines. */
  readonly stopAt: string;
  readonly expiresAt: string;
  readonly reason: "backfill_stopped";
};

export type OperatorWarningReceipt = { readonly key: string };
export type OperatorWarningSink = {
  /** Resolves only after durable acceptance; the caller commits its DB receipt later. */
  accept(input: { readonly key: string; readonly payload: OperatorWarningPayload }): Promise<OperatorWarningReceipt>;
};

/** Validates bounded metadata before deriving the stable occurrence/deadline key. */
export function operatorWarningKey(payload: OperatorWarningPayload): string {
  const invalid = () => new Error("invalid operator warning metadata");
  if (payload === null || typeof payload !== "object" ||
      Object.keys(payload).sort().join(",") !== "expiresAt,occurrenceId,reason,schema,stopAt" ||
      payload.schema !== "meeting-operator-warning/v1" || payload.reason !== "backfill_stopped" ||
      typeof payload.occurrenceId !== "string" || payload.occurrenceId.length > 400) throw invalid();
  const split = payload.occurrenceId.lastIndexOf("@");
  const start = payload.occurrenceId.slice(split + 1);
  try {
    encodeURIComponent(payload.occurrenceId); // Reject unpaired UTF-16 surrogates.
    if (split < 1 || makeOccurrenceId(payload.occurrenceId.slice(0, split), start) !== payload.occurrenceId) throw invalid();
  } catch { throw invalid(); }
  const dates = [payload.stopAt, payload.expiresAt];
  for (const date of dates) {
    const ms = typeof date === "string" ? Date.parse(date) : NaN;
    if (!Number.isSafeInteger(ms) || ms < 0 || new Date(ms).toISOString() !== date) throw invalid();
  }
  if (Date.parse(payload.expiresAt) - Date.parse(payload.stopAt) !== 3 * 86_400_000 ||
      Date.parse(start) > Date.parse(payload.stopAt)) throw invalid();
  return createHash("sha256").update(JSON.stringify([
    payload.schema, payload.occurrenceId, payload.stopAt, payload.expiresAt,
  ])).digest("hex");
}
