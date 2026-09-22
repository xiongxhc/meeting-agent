// Service entry point. This is what a deployment runs (see package.json's
// "start" script); it is intentionally not part of the package's public
// "exports" -- consumers import the library-contract surface (currently
// src/config.ts) instead of this file.
//
// Two invocations exist:
//   - no arguments: the legacy environment config path, unchanged. It loads
//     config and then fails closed because no adapter composition exists.
//   - `--standalone-config ABSOLUTE_PATH`: the macOS standalone admission
//     boundary (Cut A). It parses the versioned config, checks the state root
//     reference, takes the exclusive owner lock, and then hands off to the
//     private composeAfterAdmission seam. Cut B routes that seam to the live
//     graph in ./application-composition.ts (compose, start, one durable
//     discovery tick, wait for a shutdown signal, close); a graph that cannot
//     be built still reports composition_unavailable. The owner is closed
//     last, exactly once, on every path after acquisition. No SQLite, Feishu,
//     Runtime, bridge or child is touched before the composition seam.
//
// runStandalone(argv, dependencies) is a test seam, not package API: main
// passes the real dependencies; tests inject counting ones.

import { pathToFileURL } from "node:url";

import { acquireApplicationOwnerLock, type ApplicationOwnerLock } from "./adapters/application-owner-lock.ts";
import { runStandaloneComposition, type StandaloneCompositionResult } from "./application-composition.ts";
import { ConfigError, describeConfig, loadConfig } from "./config.ts";
import {
  StandaloneConfigError,
  inspectStateRoot,
  isCanonicalPathShape,
  readStandaloneConfig,
  type StandaloneConfigV1,
} from "./standalone-config.ts";

const EXIT_HELP = 0;
const EXIT_OK = 0;
const EXIT_USAGE = 64;
const EXIT_REFERENCE = 65;
const EXIT_FAILURE = 70;
const EXIT_LOCK_HELD = 75;

const HELP = [
  "usage: meeting-agent --standalone-config ABSOLUTE_PATH",
  "       meeting-agent --help",
  "",
  "ABSOLUTE_PATH names a strict JSON file with schema meeting-agent-standalone/v1.",
  "Running with no arguments uses the legacy environment configuration.",
  "",
  "exit codes: 0 help; 64 invocation or grammar; 65 unsafe root or reference;",
  "            70 helper or composition failure; 75 state root owned elsewhere",
].join("\n");

/** Cut A reported only composition_unavailable; Cut B adds the closed graph.
 * `reason` is a static refusal code from the composition, never a path. */
export type CompositionResult = { readonly status: "composition_unavailable"; readonly reason?: string } | StandaloneCompositionResult;

export type StandaloneDependencies = {
  readonly readConfig: (filename: string) => StandaloneConfigV1;
  readonly inspectStateRoot: (config: StandaloneConfigV1) => void;
  readonly acquireOwnerLock: (stateRoot: string) => Promise<ApplicationOwnerLock>;
  readonly composeAfterAdmission: (config: StandaloneConfigV1, owner: ApplicationOwnerLock) => Promise<CompositionResult>;
  readonly report: (channel: "stdout" | "stderr", line: string) => void;
};

type Invocation = { readonly kind: "help" } | { readonly kind: "standalone"; readonly configPath: string } | { readonly kind: "invalid" };

function parseInvocation(argv: readonly string[]): Invocation {
  if (argv.length === 1 && argv[0] === "--help") return { kind: "help" };
  if (argv.length === 2 && argv[0] === "--standalone-config" && argv[1] !== undefined && isCanonicalPathShape(argv[1])) {
    return { kind: "standalone", configPath: argv[1] };
  }
  return { kind: "invalid" };
}

function lockExitCode(error: unknown): number {
  const code = error instanceof Error ? error.message : "";
  switch (code) {
    case "application_owner_lock_held": return EXIT_LOCK_HELD;
    case "application_owner_lock_root_unsafe":
    case "application_owner_lock_unsupported": return EXIT_REFERENCE;
    default: return EXIT_FAILURE;
  }
}

function lockMessage(error: unknown): string {
  const code = error instanceof Error && /^application_owner_lock_[a-z_]+$/.test(error.message) ? error.message : "application_owner_lock_failed";
  return `meeting-agent: ${code}`;
}

function composeAfterAdmission(config: StandaloneConfigV1, owner: ApplicationOwnerLock): Promise<CompositionResult> {
  return runStandaloneComposition(config, owner);
}

const realDependencies: StandaloneDependencies = {
  readConfig: readStandaloneConfig,
  inspectStateRoot,
  acquireOwnerLock: acquireApplicationOwnerLock,
  composeAfterAdmission,
  report(channel, line) {
    if (channel === "stdout") console.log(line);
    else console.error(line);
  },
};

/** Admission order: invocation → config grammar → root/overlap reference →
 * owner lock → composition; owner closed last. Returns the process exit code
 * and reports only static category/field text. */
export async function runStandalone(argv: readonly string[], dependencies: StandaloneDependencies): Promise<number> {
  const invocation = parseInvocation(argv);
  if (invocation.kind === "help") {
    dependencies.report("stdout", HELP);
    return EXIT_HELP;
  }
  if (invocation.kind === "invalid") {
    dependencies.report("stderr", "meeting-agent: invocation error in argv");
    return EXIT_USAGE;
  }

  let config: StandaloneConfigV1;
  try {
    config = dependencies.readConfig(invocation.configPath);
    dependencies.inspectStateRoot(config);
  } catch (error) {
    if (error instanceof StandaloneConfigError) {
      dependencies.report("stderr", `meeting-agent: standalone config ${error.category} error in ${error.field}`);
      return error.category === "grammar" ? EXIT_USAGE : EXIT_REFERENCE;
    }
    dependencies.report("stderr", "meeting-agent: standalone config admission failed");
    return EXIT_FAILURE;
  }

  let owner: ApplicationOwnerLock;
  try {
    owner = await dependencies.acquireOwnerLock(config.stateRoot);
  } catch (error) {
    dependencies.report("stderr", lockMessage(error));
    return lockExitCode(error);
  }

  let exit = EXIT_FAILURE;
  try {
    const composition = await dependencies.composeAfterAdmission(config, owner);
    const detail = composition.status === "composition_unavailable" && composition.reason !== undefined ? ` ${composition.reason}` : "";
    dependencies.report("stderr", `meeting-agent: ${composition.status}${detail}`);
    if (composition.status === "composition_closed" && composition.clean) exit = EXIT_OK;
  } catch {
    dependencies.report("stderr", "meeting-agent: composition failed");
  } finally {
    try { owner.close(); }
    catch (error) { dependencies.report("stderr", lockMessage(error)); exit = EXIT_FAILURE; }
  }
  return exit;
}

function legacyMain(): void {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`meeting-agent: configuration error in ${error.field}`);
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  // The public composition needs deployment-injected bridge/runtime adapters.
  // This executable deliberately has none: reporting ready here would claim
  // a service can join/capture when it cannot, so it fails closed instead.
  console.error("meeting-agent: adapter composition is required before service start", describeConfig(config));
  process.exitCode = 1;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (argv.length === 0) {
    legacyMain();
    return;
  }
  process.exitCode = await runStandalone(argv, realDependencies);
}

// pathToFileURL (not a hand-built `file://${...}` template) so a path
// containing spaces or non-ASCII characters still compares correctly.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  void main();
}
