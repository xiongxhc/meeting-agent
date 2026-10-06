// Bounded R7/K3 preparation. Every executed case names its real loader;
// prerequisite/component proof never becomes built-main acceptance.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import path from "node:path";
import process from "node:process";

import { NODE24, run as runProcess } from "./stage.mjs";

const SDK_REFUSAL = "Runtime SDK prerequisite missing or incompatible:";
const inside = (filename, root) => {
  const relative = path.relative(root, filename);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

function requirePrivateStage(staged) {
  try {
    const root = lstatSync(staged.root);
    if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid() || (root.mode & 0o077) !== 0 ||
        realpathSync(staged.root) !== staged.root || !inside(realpathSync(staged.directories.app), staged.root) ||
        staged.mainPath !== path.join(staged.directories.app, "dist/src/main.js")) throw new Error();
  } catch { throw new Error("private staged package required"); }
}

/** Owns only new copies below a private staged root. `run`/`check` are evidence
 * sinks compatible with run.mjs, not admission seams. No entry/main patch,
 * runtime launch, socket, credential/key read or artifact seed occurs. On an
 * admitted host the composition may read the staged synthetic app-secret.
 * Raw process output is retained; config/launcher bytes are never reported. */
export function runPackageRefusalCuts({ staged, run = runProcess, check = () => {} }) {
  requirePrivateStage(staged);
  const cuts = [];
  const config = JSON.parse(readFileSync(staged.standaloneConfigPath, "utf8"));
  const checkerSource = staged.sdkCheckPath ?? path.resolve(import.meta.dirname, "../scripts/check-runtime-sdk.mjs");
  const sdkSource = path.join(staged.directories.app, "node_modules/@conversation/runtime");
  const negativeProofs = () => ({
    keyCreated: existsSync(staged.keyPath), gatewayStarted: existsSync(staged.gatewayPidsPath),
    databaseCreated: existsSync(path.join(staged.directories.stateRoot, "orchestration.db")),
    bridgeEvidenceCreated: existsSync(path.join(staged.directories.control, "state.json")) ||
      existsSync(path.join(staged.directories.control, "bridge-events.ndjson")),
  });
  if (Object.values(negativeProofs()).some(Boolean)) throw new Error("fresh private staged root required");
  const directory = mkdtempSync(path.join(staged.root, "package-refusal-cuts-"));

  function record(name, source, expected, observed, matches, extra = {}) {
    const masked = name === "bridge_static_unsupported" && !matches && observed?.exit === 65 && observed.stdout === "" &&
      /^meeting-agent: application_owner_lock_(root_unsafe|unsupported)\n$/.test(observed.stderr);
    const cut = { name, source, expected, status: matches ? "pass" : masked ? "masked" : "fail", observed, ...extra };
    cuts.push(cut);
    check(`package_refusal_${name}`, matches, `${cut.status}: ${source}; exit ${observed?.exit}; stderr ${JSON.stringify(observed?.stderr ?? "")}`);
  }

  function prerequisite(name, mutate) {
    const app = path.join(directory, name);
    const sdk = path.join(app, "node_modules/@conversation/runtime");
    mkdirSync(path.join(app, "scripts"), { recursive: true, mode: 0o700 });
    cpSync(checkerSource, path.join(app, "scripts/check-runtime-sdk.mjs"));
    // Dereference on READ so an installed SDK symlink can never turn a cut
    // into a write to the source installation.
    cpSync(sdkSource, sdk, { recursive: true, dereference: true });
    mutate(sdk);
    const observed = run(NODE24, [path.join(app, "scripts/check-runtime-sdk.mjs")], { cwd: app, timeout: 15_000 });
    record(name, "scripts/check-runtime-sdk.mjs (prerequisite, not main)", "exit 1; static SDK prerequisite refusal", observed,
      observed.exit === 1 && observed.stdout === "" && observed.stderr.startsWith(SDK_REFUSAL));
  }
  prerequisite("sdk_hash", (sdk) => {
    const filename = path.join(sdk, "dist/src/client.d.ts");
    writeFileSync(filename, Buffer.concat([readFileSync(filename), Buffer.from("\n// private refusal cut\n")]));
  });
  prerequisite("sdk_pin", (sdk) => {
    const filename = path.join(sdk, "package.json");
    const manifest = JSON.parse(readFileSync(filename, "utf8"));
    manifest.version = "0.0.0-private-refusal";
    writeFileSync(filename, JSON.stringify(manifest));
  });
  prerequisite("sdk_package_missing", (sdk) => rmSync(sdk, { recursive: true }));

  // A package import failure occurs before main's invocation/config handling.
  // Retain every other dependency and the exact built main bytes.
  const loaderApp = path.join(directory, "package_loader_missing");
  for (const entry of ["dist", "node_modules", "package.json"]) {
    cpSync(path.join(staged.directories.app, entry), path.join(loaderApp, entry), { recursive: true, dereference: true });
  }
  rmSync(path.join(loaderApp, "node_modules/@conversation/runtime"), { recursive: true });
  const loader = run(NODE24, [path.join(loaderApp, "dist/src/main.js"), "--standalone-config", staged.standaloneConfigPath], { cwd: loaderApp, timeout: 15_000 });
  record("package_loader_missing", "Node ESM loader importing dist/src/application-composition.js before main", "exit 1; ERR_MODULE_NOT_FOUND for @conversation/runtime", loader,
    loader.exit === 1 && loader.stdout === "" && loader.stderr.includes("ERR_MODULE_NOT_FOUND") && loader.stderr.includes("Cannot find package '@conversation/runtime'"));

  function writeConfig(name, value) {
    const filename = path.join(directory, `${name}.json`);
    writeFileSync(filename, JSON.stringify(value), { mode: 0o600 });
    return filename;
  }
  function mainCut(name, value, source, exit, stderr) {
    const filename = writeConfig(name, value);
    const observed = run(NODE24, [staged.mainPath, "--standalone-config", filename], { cwd: staged.root, timeout: 15_000 });
    record(name, source, `exit ${exit}; ${stderr.trim()}`, observed,
      observed.exit === exit && observed.stdout === "" && observed.stderr === stderr);
  }
  mainCut("runtime_wire_version", { ...config, runtime: { ...config.runtime, protocolVersion: 3 } },
    "unmodified built main → src/standalone-config.ts parseStandaloneConfig", 64,
    "meeting-agent: standalone config grammar error in runtime.protocolVersion\n");

  const bridgePath = path.join(directory, "unsupported-bridge.json");
  writeFileSync(bridgePath, JSON.stringify({ schema: "feishu-bridge-config/v999", audio: { captureDisplayId: 1, outputDeviceUid: "synthetic-refusal" } }), { mode: 0o600 });
  mainCut("bridge_static_unsupported", { ...config, bridgeSlots: config.bridgeSlots.map((slot) => ({ ...slot, staticConfigPath: bridgePath })) },
    "unmodified built main → owner lock → src/application-composition.ts preflightBridgeStaticConfig", 70,
    "meeting-agent: composition_unavailable bridge_slot_invalid\n");

  const missingLauncher = path.join(directory, "launcher-not-installed");
  const preparedConfigPath = writeConfig("missing_launcher", { ...config, runtime: { ...config.runtime, launcherPath: missingLauncher } });
  cuts.push({ name: "missing_launcher", source: "src/application-composition.ts startTransport/startRuntimeOwner (lazy occurrence startup)",
    status: "not_executed", expected: "requires admitted occurrence and ingress/discovery; no pre-spawn loader check exists", observed: null, preparedConfigPath });
  check("package_refusal_missing_launcher", false, "not_executed: the unmodified main does not inspect launcher existence before ingress/discovery");

  const proof = negativeProofs();
  check("package_refusals_no_runtime_or_artifacts", !Object.values(proof).some(Boolean), JSON.stringify(proof));
  return { directory, cuts, negativeProofs: proof, acceptance: cuts.every((cut) => cut.status === "pass") ? "executed_cuts_only" : "incomplete" };
}
