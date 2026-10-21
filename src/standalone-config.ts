// Standalone operator config, schema meeting-agent-standalone/v1 (Cut A).
//
// This is the explicit-file counterpart to the legacy environment config in
// ./config.ts, not an extension of it: the standalone entry never calls
// loadConfig. Parsing reads the selected config bytes only. It never reads
// the Feishu secret file, never creates, repairs or removes anything, never
// opens SQLite, never spawns and never connects. Every refusal names only a
// category and a field so the message can be logged without leaking a path,
// a credential, an argument vector or a label.
//
// Categories map to the entry's static exits: "grammar" (invocation-level
// shape, exit 64) and "reference" (an unsafe file or root reference, exit 65).

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";

import { createChildBridgeSlot } from "./adapters/child-bridge-process.ts";
import { validateBridgeSlots } from "./config.ts";

export const STANDALONE_SCHEMA = "meeting-agent-standalone/v1";
export const MAX_STANDALONE_CONFIG_BYTES = 65_536;
const MAX_BRIDGE_SLOTS = 8;
const MAX_READ_CALLS = 1024;

export type StandaloneBridgeSlot = {
  readonly physicalClientId: string;
  readonly bridgeId: string;
  readonly executable: string;
  readonly staticConfigPath: string;
  readonly argv?: readonly string[];
  readonly cooperativeGraceMs?: number;
};

export type StandaloneConfigV1 = {
  readonly schema: typeof STANDALONE_SCHEMA;
  readonly stateRoot: string;
  readonly feishu: {
    readonly region: "feishu" | "lark";
    readonly tenantKey: string;
    readonly appId: string;
    /** A reference only; the bytes are read by a later owner after admission. */
    readonly appSecretFile: string;
  };
  readonly agentIdentity: { readonly aliases: readonly string[] };
  readonly dataPaths: {
    readonly recordingsDir: string;
    readonly outboxDir: string;
    readonly receiptsDir: string;
    readonly teamVaultDir: string;
  };
  readonly runtime: {
    readonly launcherPath: string;
    readonly gatewayConfigPath: string;
    readonly protocolVersion: 4;
  };
  readonly bridgeSlots: readonly StandaloneBridgeSlot[];
  /** Invite allowlist. Only invites from a listed inviter (Feishu user open_id, matched against the event's
   * `inviter.id`) or chat are joined; absent or empty refuses every invite. */
  readonly admission?: { readonly allowedInviterIds: readonly string[]; readonly allowedChatIds: readonly string[] };
};

export type StandaloneConfigErrorCategory = "grammar" | "reference";

export class StandaloneConfigError extends Error {
  readonly category: StandaloneConfigErrorCategory;
  readonly field: string;

  constructor(category: StandaloneConfigErrorCategory, field: string) {
    super(`standalone config ${category} error in ${field}`);
    this.name = "StandaloneConfigError";
    this.category = category;
    this.field = field;
  }
}

type JsonObject = Record<string, unknown>;
type DataPathField = keyof StandaloneConfigV1["dataPaths"];

const DATA_PATH_FIELDS: readonly DataPathField[] = ["recordingsDir", "outboxDir", "receiptsDir", "teamVaultDir"];

function grammar(field: string): StandaloneConfigError {
  return new StandaloneConfigError("grammar", field);
}

function reference(field: string): StandaloneConfigError {
  return new StandaloneConfigError("reference", field);
}

/** Absolute, normalized, NUL-free and free of trailing separators: the only
 * path spelling the standalone config accepts, so nothing is ever rewritten. */
export function isCanonicalPathShape(value: string): boolean {
  return value.length > 0 && !value.includes("\0") && path.isAbsolute(value) && path.resolve(value) === value;
}

function expectObject(value: unknown, field: string, required: readonly string[], optional: readonly string[] = []): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw grammar(field);
  const record = value as JsonObject;
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) throw grammar(field);
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) throw grammar(field);
  }
  return record;
}

function expectPath(value: unknown, field: string): string {
  if (typeof value !== "string" || !isCanonicalPathShape(value)) throw grammar(field);
  return value;
}

function expectString(value: unknown, field: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw grammar(field);
  return value;
}

function parseBridgeSlot(value: unknown, field: string): StandaloneBridgeSlot {
  const record = expectObject(value, field, ["physicalClientId", "bridgeId", "executable", "staticConfigPath"], ["argv", "cooperativeGraceMs"]);
  if (typeof record.physicalClientId !== "string" || typeof record.bridgeId !== "string") throw grammar(field);
  const slot: { -readonly [K in keyof StandaloneBridgeSlot]: StandaloneBridgeSlot[K] } = {
    physicalClientId: record.physicalClientId,
    bridgeId: record.bridgeId,
    executable: expectPath(record.executable, field),
    staticConfigPath: expectPath(record.staticConfigPath, field),
  };
  if (Object.hasOwn(record, "argv")) {
    if (!Array.isArray(record.argv) || record.argv.some((item) => typeof item !== "string")) throw grammar(field);
    slot.argv = [...(record.argv as string[])];
  }
  if (Object.hasOwn(record, "cooperativeGraceMs")) {
    if (typeof record.cooperativeGraceMs !== "number") throw grammar(field);
    slot.cooperativeGraceMs = record.cooperativeGraceMs;
  }
  // The child adapter owns the launch limits (label grammar, absolute paths,
  // argv 16 values / 4096 bytes / no NUL, grace 1000..30000). Constructing a
  // slot validates them without spawning anything; the result is discarded.
  try { createChildBridgeSlot(slot); }
  catch { throw grammar(field); }
  return slot;
}

/** Grammar-only validation of already-read config bytes. No filesystem access. */
export function parseStandaloneConfig(bytes: Uint8Array): StandaloneConfigV1 {
  if (bytes.byteLength > MAX_STANDALONE_CONFIG_BYTES) throw grammar("config");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw grammar("config");
  }
  const root = expectObject(value, "config", ["schema", "stateRoot", "feishu", "agentIdentity", "dataPaths", "runtime", "bridgeSlots"], ["admission"]);
  if (root.schema !== STANDALONE_SCHEMA) throw grammar("schema");
  const stateRoot = expectPath(root.stateRoot, "stateRoot");

  const feishu = expectObject(root.feishu, "feishu", ["region", "tenantKey", "appId", "appSecretFile"]);
  if (feishu.region !== "feishu" && feishu.region !== "lark") throw grammar("feishu.region");
  const tenantKey = expectString(feishu.tenantKey, "feishu.tenantKey", /^[\x21-\x7e]{1,128}$/);
  const appId = expectString(feishu.appId, "feishu.appId", /^cli_[A-Za-z0-9_-]{1,128}$/);
  const appSecretFile = expectPath(feishu.appSecretFile, "feishu.appSecretFile");

  const identity = expectObject(root.agentIdentity, "agentIdentity", ["aliases"]);
  if (!Array.isArray(identity.aliases) || identity.aliases.length === 0 ||
      identity.aliases.some((alias) => typeof alias !== "string" || alias.trim().length === 0)) {
    throw grammar("agentIdentity.aliases");
  }
  const aliases = [...(identity.aliases as string[])];

  const dataRecord = expectObject(root.dataPaths, "dataPaths", DATA_PATH_FIELDS);
  const dataPaths = {
    recordingsDir: expectPath(dataRecord.recordingsDir, "dataPaths.recordingsDir"),
    outboxDir: expectPath(dataRecord.outboxDir, "dataPaths.outboxDir"),
    receiptsDir: expectPath(dataRecord.receiptsDir, "dataPaths.receiptsDir"),
    teamVaultDir: expectPath(dataRecord.teamVaultDir, "dataPaths.teamVaultDir"),
  };

  const runtime = expectObject(root.runtime, "runtime", ["launcherPath", "gatewayConfigPath", "protocolVersion"]);
  const launcherPath = expectPath(runtime.launcherPath, "runtime.launcherPath");
  const gatewayConfigPath = expectPath(runtime.gatewayConfigPath, "runtime.gatewayConfigPath");
  if (runtime.protocolVersion !== 4) throw grammar("runtime.protocolVersion");

  if (!Array.isArray(root.bridgeSlots) || root.bridgeSlots.length < 1 || root.bridgeSlots.length > MAX_BRIDGE_SLOTS) throw grammar("bridgeSlots");
  const bridgeSlots = root.bridgeSlots.map((slot, index) => parseBridgeSlot(slot, `bridgeSlots[${index}]`));
  try { validateBridgeSlots(bridgeSlots); }
  catch { throw grammar("bridgeSlots"); }

  let admission: StandaloneConfigV1["admission"];
  if (Object.hasOwn(root, "admission")) {
    const record = expectObject(root.admission, "admission", [], ["allowedInviterIds", "allowedChatIds"]);
    const list = (field: "allowedInviterIds" | "allowedChatIds"): string[] => {
      const ids = record[field] ?? [];
      if (!Array.isArray(ids) || ids.length > 256 ||
          ids.some((id) => typeof id !== "string" || !/^[\x21-\x7e]{1,128}$/.test(id)) || new Set(ids).size !== ids.length) {
        throw grammar(`admission.${field}`);
      }
      return [...(ids as string[])];
    };
    admission = { allowedInviterIds: list("allowedInviterIds"), allowedChatIds: list("allowedChatIds") };
  }

  return {
    schema: STANDALONE_SCHEMA,
    stateRoot,
    feishu: { region: feishu.region, tenantKey, appId, appSecretFile },
    agentIdentity: { aliases },
    dataPaths,
    runtime: { launcherPath, gatewayConfigPath, protocolVersion: 4 },
    bridgeSlots,
    ...(admission === undefined ? {} : { admission }),
  };
}

function readBounded(fd: number): Uint8Array {
  const bytes = Buffer.alloc(MAX_STANDALONE_CONFIG_BYTES + 1);
  let offset = 0;
  for (let calls = 0; calls < MAX_READ_CALLS; calls += 1) {
    let count: number;
    try { count = readSync(fd, bytes, offset, bytes.length - offset, null); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EINTR") continue;
      throw reference("config");
    }
    offset += count;
    if (offset > MAX_STANDALONE_CONFIG_BYTES) throw grammar("config");
    if (count === 0) return bytes.subarray(0, offset);
  }
  throw reference("config");
}

/**
 * Reads the operator-selected config through a no-follow descriptor. The
 * open descriptor must be a regular file owned by the current UID and not
 * writable by group or other; a symlink, directory, FIFO, foreign owner or
 * loose mode is a reference error. Size and content are then grammar.
 */
export function readStandaloneConfig(filename: string): StandaloneConfigV1 {
  if (!isCanonicalPathShape(filename)) throw grammar("config");
  let fd: number;
  try { fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw reference("config"); }
  try {
    let stat;
    try { stat = fstatSync(fd, { bigint: true }); }
    catch { throw reference("config"); }
    if (process.getuid === undefined || !stat.isFile() || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o022n) !== 0n) {
      throw reference("config");
    }
    if (stat.size > BigInt(MAX_STANDALONE_CONFIG_BYTES)) throw grammar("config");
    return parseStandaloneConfig(readBounded(fd));
  } finally {
    closeSync(fd);
  }
}

/** True when `child` resolves to a path inside `parent` (not equal to it). */
function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Reference checks that need the real filesystem or cross-field path math:
 * stateRoot must already be its own canonical realpath (nothing is remapped;
 * the owner-lock adapter later requires the same spelling), and the four data
 * paths may neither overlap each other nor equal, contain or sit inside the
 * state root. Read-only: no mkdir, chmod, unlink or repair.
 */
export function inspectStateRoot(config: StandaloneConfigV1): void {
  let canonical: string;
  try { canonical = realpathSync.native(config.stateRoot); }
  catch { throw reference("stateRoot"); }
  if (canonical !== config.stateRoot) throw reference("stateRoot");

  const entries = DATA_PATH_FIELDS.map((field) => ({ field, dir: config.dataPaths[field] }));
  for (const a of entries) {
    for (const b of entries) {
      if (a !== b && (a.dir === b.dir || isWithin(a.dir, b.dir))) throw reference(`dataPaths.${a.field}`);
    }
    if (a.dir === config.stateRoot || isWithin(a.dir, config.stateRoot) || isWithin(config.stateRoot, a.dir)) {
      throw reference(`dataPaths.${a.field}`);
    }
  }
}
