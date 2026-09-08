// Strict reader for TeamMem's producer-authored, atomically-replaced receipt.
// A receipt is publication evidence, so malformed or merely plausible data is
// intentionally indistinguishable from no receipt.

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
  const filename = path.join(path.resolve(input.receiptsDir), `${occurrencePathSegment(input.occurrenceId as `${string}@${string}`)}.json`);
  let raw: Buffer;
  try {
    const stat = lstatSync(filename);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    raw = readFileSync(filename);
  } catch {
    return null;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString("utf8")); } catch { return null; }
  if (!isReceipt(parsed)) return null;
  const canonical = `${JSON.stringify(sortedReceipt(parsed))}\n`;
  if (!raw.equals(Buffer.from(canonical, "utf8"))) return null;
  if (parsed.occurrence_id !== input.occurrenceId || parsed.revision !== input.revision || parsed.artifact_hash !== input.artifactHash) return null;
  return parsed;
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
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.includes("\\") || hasControlCharacter(value)) return false;
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
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return false;
  const suffix = `/-/blob/${commit}/${markdownPath.split("/").map(producerQuote).join("/")}`;
  return url.pathname.endsWith(suffix) && url.pathname.slice(0, -suffix.length).length > 0;
}
