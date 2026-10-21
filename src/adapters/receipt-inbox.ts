// Strict readers for TeamMem's producer-authored, atomically-replaced receipt
// and its terminal refusal record. Both are evidence, so malformed or merely
// plausible data is intentionally indistinguishable from no file.

import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { occurrencePathSegment } from "../domain/occurrence-id.ts";

const KEYS = ["artifact_hash", "markdown_path", "markdown_url", "occurrence_id", "revision", "schema", "status", "vault_commit"] as const;
const HASH = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

export type PublicationReceipt = {
  readonly schema: "teammem-meeting-receipt/v1";
  readonly occurrence_id: string;
  readonly revision: number;
  readonly artifact_hash: string;
  readonly status: "published";
  readonly vault_commit: string;
  readonly markdown_path: string;
  readonly markdown_url: string;
};

export type ReadPublicationReceiptInput = {
  readonly receiptsDir: string;
  readonly occurrenceId: string;
  readonly revision: number;
  readonly artifactHash: string;
};

export function readPublicationReceipt(input: ReadPublicationReceiptInput): PublicationReceipt | null {
  try {
    const filename = path.join(path.resolve(input.receiptsDir), `${occurrencePathSegment(input.occurrenceId as `${string}@${string}`)}.json`);
    const stat = lstatSync(filename);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const raw = readFileSync(filename);
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    if (!isReceipt(parsed)) return null;
    const canonical = `${JSON.stringify(sortedReceipt(parsed))}\n`;
    if (!raw.equals(Buffer.from(canonical, "utf8"))) return null;
    if (parsed.occurrence_id !== input.occurrenceId || parsed.revision !== input.revision || parsed.artifact_hash !== input.artifactHash) return null;
    return parsed;
  } catch { return null; }
}

const REFUSAL_KEYS = ["artifact_hash", "invariants", "occurrence_id", "reason_code", "revision", "schema", "status"] as const;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const INVARIANT = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MAX_REFUSAL_BYTES = 16 * 1024;

/** TeamMem refused this exact revision for good; only a higher revision can
 * publish. Carries a reason code and invariant names, never meeting text. */
export type PublicationRefusal = {
  readonly schema: "teammem-meeting-refusal/v1";
  readonly occurrence_id: string;
  readonly revision: number;
  readonly artifact_hash: string;
  readonly status: "refused";
  readonly reason_code: string;
  readonly invariants: readonly string[];
};

/** Reads `<receiptsDir>/<segment>/<revision>.refused.json`. Only a regular
 * file under a real directory, with the exact key set, canonical bytes and an
 * exact occurrence, revision and hash match, is a refusal. */
export function readPublicationRefusal(input: ReadPublicationReceiptInput): PublicationRefusal | null {
  try {
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) return null;
    const directory = path.join(path.resolve(input.receiptsDir), occurrencePathSegment(input.occurrenceId as `${string}@${string}`));
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory()) return null; // lstat: a symlinked directory is not one
    const filename = path.join(directory, `${input.revision}.refused.json`);
    const stat = lstatSync(filename);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_REFUSAL_BYTES) return null;
    const raw = readFileSync(filename);
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    if (!isRefusal(parsed)) return null;
    const canonical = `${JSON.stringify(Object.fromEntries(REFUSAL_KEYS.map((key) => [key, parsed[key]])))}\n`;
    if (!raw.equals(Buffer.from(canonical, "utf8"))) return null;
    if (parsed.occurrence_id !== input.occurrenceId || parsed.revision !== input.revision || parsed.artifact_hash !== input.artifactHash) return null;
    return parsed;
  } catch { return null; }
}

function isRefusal(value: unknown): value is PublicationRefusal {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== REFUSAL_KEYS.join("\0")) return false;
  if (record.schema !== "teammem-meeting-refusal/v1" || record.status !== "refused" || typeof record.occurrence_id !== "string"
    || !isUnicodeScalarString(record.occurrence_id) || !Number.isSafeInteger(record.revision) || (record.revision as number) < 1
    || typeof record.artifact_hash !== "string" || !HASH.test(record.artifact_hash)
    || typeof record.reason_code !== "string" || !CODE.test(record.reason_code) || !Array.isArray(record.invariants)) return false;
  const invariants = record.invariants as unknown[];
  return invariants.length <= 64 && invariants.every((name, index) => typeof name === "string" && INVARIANT.test(name)
    && (index === 0 || (invariants[index - 1] as string) < name));
}

function isReceipt(value: unknown): value is PublicationReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== [...KEYS].sort().join("\0")) return false;
  if (record.schema !== "teammem-meeting-receipt/v1" || record.status !== "published" || typeof record.occurrence_id !== "string"
    || !Number.isSafeInteger(record.revision) || (record.revision as number) < 1 || typeof record.artifact_hash !== "string"
    || !HASH.test(record.artifact_hash) || typeof record.vault_commit !== "string" || !COMMIT.test(record.vault_commit)
    || !safeMarkdownPath(record.markdown_path) || typeof record.markdown_url !== "string") return false;
  return validCommitUrl(record.markdown_url, record.vault_commit, record.markdown_path);
}

function sortedReceipt(receipt: PublicationReceipt): Record<string, unknown> {
  return Object.fromEntries(Object.keys(receipt).sort().map((key) => [key, receipt[key as keyof PublicationReceipt]]));
}

function safeMarkdownPath(value: unknown): value is string {
  if (typeof value !== "string" || !isUnicodeScalarString(value) || value.length === 0 || value.startsWith("/") || value.includes("\\") || hasControlCharacter(value)) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function producerQuote(value: string): string {
  return encodeURIComponent(value).replace(/[!*'()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function validCommitUrl(raw: string, commit: string, markdownPath: string): boolean {
  if (!isUnicodeScalarString(raw)) return false;
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return false;
  const suffix = `/-/blob/${commit}/${markdownPath.split("/").map(producerQuote).join("/")}`;
  return url.pathname.endsWith(suffix) && url.pathname.slice(0, -suffix.length).length > 0;
}

function isUnicodeScalarString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
