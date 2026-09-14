import { makeOccurrenceId } from "../domain/occurrence-id.ts";
import { parseCommandShape } from "./bridge-session-v1.ts";

export type CustodyBinding = {
  readonly physicalClientId: string;
  readonly physicalGenerationId: string;
  readonly occurrenceId: string;
  readonly bridgeSessionId: string;
};
export type BridgeProcessOutcome = CustodyBinding & {
  readonly schema: "bridge-process-outcome/v1";
  readonly observedAt: string;
} & (
  | { readonly outcome: "departure_confirmed"; readonly reason: "departure_observed" }
  | { readonly outcome: "no_join_action"; readonly reason: "join_not_issued" }
  | { readonly outcome: "departure_unconfirmed"; readonly reason: "departure_not_observed" | "evidence_unavailable" | "input_reap_failed" | "cleanup_failed" }
);
export const OUTCOME_MAX_BYTES = 4096;
const bindingKeys = ["physicalClientId", "physicalGenerationId", "occurrenceId", "bridgeSessionId"] as const;
function invalid(): never { throw new Error("invalid_bridge_process_contract"); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key))) invalid();
  return result;
}
export function validateCustodyBinding(value: unknown): CustodyBinding {
  const raw = object(value, bindingKeys);
  if (bindingKeys.some((key) => typeof raw[key] !== "string")) invalid();
  const binding = raw as unknown as CustodyBinding;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(binding.physicalClientId) || [".", ".."].includes(binding.physicalClientId) ||
      !/^[a-f0-9]{32}$/.test(binding.physicalGenerationId) || Buffer.byteLength(binding.occurrenceId) > OUTCOME_MAX_BYTES ||
      Buffer.byteLength(binding.bridgeSessionId) > OUTCOME_MAX_BYTES) invalid();
  try {
    const at = binding.occurrenceId.lastIndexOf("@");
    if (makeOccurrenceId(binding.occurrenceId.slice(0, at), binding.occurrenceId.slice(at + 1)) !== binding.occurrenceId) invalid();
  } catch { invalid(); }
  if (!parseCommandShape({ schema: "bridge-session/v1", sessionId: binding.bridgeSessionId, commandId: "binding", type: "join", meetingOccurrenceId: binding.occurrenceId, meetingNo: "000000001", leaseId: "binding" }).ok) invalid();
  const largest = { schema: "bridge-process-outcome/v1", ...binding, outcome: "departure_unconfirmed", reason: "departure_not_observed", observedAt: "9999-12-31T23:59:59.999Z" };
  if (Buffer.byteLength(JSON.stringify(largest)) + 1 > OUTCOME_MAX_BYTES) invalid();
  return { physicalClientId: binding.physicalClientId, physicalGenerationId: binding.physicalGenerationId, occurrenceId: binding.occurrenceId, bridgeSessionId: binding.bridgeSessionId };
}
export function sameCustodyBinding(a: CustodyBinding, b: CustodyBinding): boolean {
  return bindingKeys.every((key) => a[key] === b[key]);
}
export function parseBridgeProcessOutcome(value: unknown): BridgeProcessOutcome {
  const raw = object(value, ["schema", ...bindingKeys, "outcome", "reason", "observedAt"]);
  const binding = validateCustodyBinding(Object.fromEntries(bindingKeys.map((key) => [key, raw[key]])));
  if (raw.schema !== "bridge-process-outcome/v1" || typeof raw.observedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(raw.observedAt)) invalid();
  const ms = Date.parse(raw.observedAt);
  const canonical = raw.observedAt.includes(".") ? raw.observedAt : raw.observedAt.replace(/Z$/, ".000Z");
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== canonical) invalid();
  const valid = raw.outcome === "departure_confirmed" && raw.reason === "departure_observed" ||
    raw.outcome === "no_join_action" && raw.reason === "join_not_issued" ||
    raw.outcome === "departure_unconfirmed" && typeof raw.reason === "string" && ["departure_not_observed", "evidence_unavailable", "input_reap_failed", "cleanup_failed"].includes(raw.reason);
  if (!valid || Buffer.byteLength(JSON.stringify(raw)) + 1 > OUTCOME_MAX_BYTES) invalid();
  return { ...raw, ...binding } as BridgeProcessOutcome;
}

/** Validated outcomes are flat, string-valued objects with exactly eight keys.
 * Count only structural colons to reject duplicate keys lost by JSON.parse,
 * without interpreting escaped string content as a member separator. */
export function decodeBridgeProcessOutcome(text: string): BridgeProcessOutcome {
  const result = parseBridgeProcessOutcome(JSON.parse(text));
  let quoted = false, escaped = false, members = 0;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === ":") members += 1;
  }
  if (members !== 8 || Buffer.byteLength(text) + 1 > OUTCOME_MAX_BYTES) invalid();
  return result;
}
