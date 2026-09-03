// Meeting Agent configuration: loaded from explicit environment variables, or
// (for the Feishu app secret specifically) an explicit file reference. There is
// no config file format, no defaults beyond the v1-pinned runtime profile, and
// no secret ever lives directly in an environment variable value.
//
// Two rules this module exists to enforce:
//   1. A config dump must be safe to paste into an issue: log field names and
//      redacted status, never credential values (see describeConfig/RedactedSecret).
//   2. "Overlapping data paths" means containment, not string equality --
//      paths are resolved before comparison (see assertNoOverlappingPaths).

import { readFileSync } from "node:fs";
import path from "node:path";

/** A config-loading failure, always naming the offending field. Never carries
 * a credential value in its message. */
export class ConfigError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`config error [${field}]: ${message}`);
    this.name = "ConfigError";
    this.field = field;
  }
}

/**
 * Holds a credential value without ever exposing it through the ordinary
 * surfaces that leak into logs: string coercion, template literals, and
 * JSON.stringify (directly, or nested inside a larger object such as the
 * whole config). Call `.reveal()` explicitly to obtain the real value.
 */
export class RedactedSecret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return "[REDACTED]";
  }

  toJSON(): string {
    return "[REDACTED]";
  }
}

/** Meeting Agent v1 pins the Conversation Runtime profile to "online"
 * explicitly per session; there is no silent profile switching. */
export type RuntimeProfile = "online";

export type MeetingAgentConfig = {
  readonly feishu: {
    readonly appId: string;
    readonly appSecret: RedactedSecret;
  };
  readonly conversationRuntime: {
    readonly endpoint: string;
    readonly profile: RuntimeProfile;
  };
  readonly agentIdentity: {
    readonly aliases: readonly string[];
  };
  readonly dataPaths: {
    readonly recordingsDir: string;
    readonly outboxDir: string;
    readonly receiptsDir: string;
    readonly teamVaultDir: string;
  };
};

/** A safe-to-log summary of a loaded config: field names and redacted status
 * for credentials, plain values for everything else. Never contains a
 * credential value. */
export type ConfigSummary = {
  readonly feishu: { readonly appId: string; readonly appSecret: "redacted" };
  readonly conversationRuntime: MeetingAgentConfig["conversationRuntime"];
  readonly agentIdentity: { readonly aliasCount: number };
  readonly dataPaths: MeetingAgentConfig["dataPaths"];
};

export type ConfigEnv = Readonly<Record<string, string | undefined>>;

export type LoadConfigOptions = {
  /** Defaults to `process.env`. Tests inject a plain object instead. */
  readonly env?: ConfigEnv;
};

const ENV_KEYS = {
  feishuAppId: "MEETING_AGENT_FEISHU_APP_ID",
  feishuAppSecretFile: "MEETING_AGENT_FEISHU_APP_SECRET_FILE",
  runtimeEndpoint: "MEETING_AGENT_RUNTIME_ENDPOINT",
  runtimeProfile: "MEETING_AGENT_RUNTIME_PROFILE",
  aliases: "MEETING_AGENT_ALIASES",
  recordingsDir: "MEETING_AGENT_RECORDINGS_DIR",
  outboxDir: "MEETING_AGENT_OUTBOX_DIR",
  receiptsDir: "MEETING_AGENT_RECEIPTS_DIR",
  teamVaultDir: "MEETING_AGENT_TEAM_VAULT_DIR",
} as const;

const PINNED_RUNTIME_PROFILE: RuntimeProfile = "online";

export function loadConfig(options: LoadConfigOptions = {}): MeetingAgentConfig {
  const env = options.env ?? process.env;

  const appId = requireNonBlank(env, ENV_KEYS.feishuAppId, "feishu.appId");
  const appSecret = loadSecretFromFileRef(env, ENV_KEYS.feishuAppSecretFile, "feishu.appSecret");

  const endpoint = requireUrl(env, ENV_KEYS.runtimeEndpoint, "conversationRuntime.endpoint");
  const profile = requirePinnedRuntimeProfile(env);

  const aliases = requireAliases(env);
  const dataPaths = resolveAndCheckDataPaths(env);

  return {
    feishu: { appId, appSecret },
    conversationRuntime: { endpoint, profile },
    agentIdentity: { aliases },
    dataPaths,
  };
}

/** A summary safe to log or paste into an issue: field names and redacted
 * status for the credential, plain values for everything else. */
export function describeConfig(config: MeetingAgentConfig): ConfigSummary {
  return {
    feishu: { appId: config.feishu.appId, appSecret: "redacted" },
    conversationRuntime: { ...config.conversationRuntime },
    agentIdentity: { aliasCount: config.agentIdentity.aliases.length },
    dataPaths: { ...config.dataPaths },
  };
}

function requireNonBlank(env: ConfigEnv, key: string, field: string): string {
  const raw = env[key];
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") {
    throw new ConfigError(field, `missing required environment variable ${key}`);
  }
  return trimmed;
}

function loadSecretFromFileRef(env: ConfigEnv, key: string, field: string): RedactedSecret {
  const fileRef = requireNonBlank(env, key, field);

  // A relative path (or a bare token with no path structure at all, such as a
  // pasted secret value) is rejected here, before any filesystem access, so
  // the error never depends on -- or echoes -- what the value actually was.
  if (!path.isAbsolute(fileRef)) {
    throw new ConfigError(
      field,
      `${key} must be an absolute path to a file containing the secret, ` +
        `not a relative path or an inline secret value`,
    );
  }

  let contents: string;
  try {
    contents = readFileSync(fileRef, "utf8");
  } catch {
    throw new ConfigError(field, `could not read the secret file referenced by ${key}`);
  }

  const value = contents.trim();
  if (value === "") {
    throw new ConfigError(field, `the secret file referenced by ${key} is empty`);
  }

  return new RedactedSecret(value);
}

function requireUrl(env: ConfigEnv, key: string, field: string): string {
  const raw = requireNonBlank(env, key, field);
  try {
    return new URL(raw).toString();
  } catch {
    throw new ConfigError(field, `${key} is not a valid URL`);
  }
}

function requirePinnedRuntimeProfile(env: ConfigEnv): RuntimeProfile {
  const raw = env[ENV_KEYS.runtimeProfile]?.trim();
  if (raw === undefined || raw === "") {
    return PINNED_RUNTIME_PROFILE;
  }
  if (raw !== PINNED_RUNTIME_PROFILE) {
    throw new ConfigError(
      "conversationRuntime.profile",
      `Meeting Agent v1 pins the Conversation Runtime profile to "online"; ` +
        `${ENV_KEYS.runtimeProfile} was "${raw}"`,
    );
  }
  return PINNED_RUNTIME_PROFILE;
}

function requireAliases(env: ConfigEnv): readonly string[] {
  const raw = requireNonBlank(env, ENV_KEYS.aliases, "agentIdentity.aliases");
  const aliases = raw
    .split(",")
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0);
  if (aliases.length === 0) {
    throw new ConfigError(
      "agentIdentity.aliases",
      `${ENV_KEYS.aliases} must contain at least one non-empty alias`,
    );
  }
  return aliases;
}

type DataPathField = keyof MeetingAgentConfig["dataPaths"];

function resolveAndCheckDataPaths(env: ConfigEnv): MeetingAgentConfig["dataPaths"] {
  const entries: ReadonlyArray<{ field: DataPathField; envKey: string }> = [
    { field: "recordingsDir", envKey: ENV_KEYS.recordingsDir },
    { field: "outboxDir", envKey: ENV_KEYS.outboxDir },
    { field: "receiptsDir", envKey: ENV_KEYS.receiptsDir },
    { field: "teamVaultDir", envKey: ENV_KEYS.teamVaultDir },
  ];

  const resolved = entries.map(({ field, envKey }) => ({
    field,
    dir: path.resolve(requireNonBlank(env, envKey, `dataPaths.${field}`)),
  }));

  assertNoOverlappingPaths(resolved);

  const dataPaths: Record<DataPathField, string> = {
    recordingsDir: "",
    outboxDir: "",
    receiptsDir: "",
    teamVaultDir: "",
  };
  for (const { field, dir } of resolved) {
    dataPaths[field] = dir;
  }
  return dataPaths;
}

/**
 * "Overlapping" means one configured directory contains another, or two
 * fields resolve to the identical directory -- never a string prefix match.
 * Paths are resolved (path.resolve) before this runs, so relative segments
 * and sibling directories that merely share a text prefix (e.g.
 * "recordings" vs "recordings-archive") are compared correctly.
 */
function assertNoOverlappingPaths(
  paths: ReadonlyArray<{ field: DataPathField; dir: string }>,
): void {
  for (let i = 0; i < paths.length; i += 1) {
    for (let j = 0; j < paths.length; j += 1) {
      if (i === j) continue;
      const a = paths[i]!;
      const b = paths[j]!;
      if (a.dir === b.dir) {
        throw new ConfigError(
          `dataPaths.${a.field}`,
          `dataPaths.${a.field} (${a.dir}) must not resolve to the same directory as dataPaths.${b.field}`,
        );
      }
      if (isWithin(a.dir, b.dir)) {
        throw new ConfigError(
          `dataPaths.${a.field}`,
          `dataPaths.${a.field} (${a.dir}) overlaps with dataPaths.${b.field} (${b.dir}): ` +
            `it resolves to a path inside it`,
        );
      }
    }
  }
}

/** True when `child` resolves to a path inside `parent` (not equal to it). */
function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
