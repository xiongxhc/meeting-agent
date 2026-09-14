// Explicit local audit action only. Never loads service/provider configuration,
// inspects the desktop or launches a bridge.
import path from "node:path";
import { lstatSync } from "node:fs";
import { openSessionStore } from "./adapters/sqlite-session-store.ts";

export function runOperator(args: readonly string[]): string {
  const [command, ...rest] = args;
  if (command !== "physical-client-status" && command !== "physical-client-clear") throw new Error("invalid_operator_arguments");
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index]!;
    if (options.has(key)) throw new Error("invalid_operator_arguments");
    if (key === "--assert-inspected-idle") options.set(key, "true");
    else {
      if (!["--db", "--slot", "--generation", "--operator"].includes(key) || rest[index + 1] === undefined) throw new Error("invalid_operator_arguments");
      options.set(key, rest[++index]!);
    }
  }
  const filename = options.get("--db");
  if (!filename || !path.isAbsolute(filename) || filename.includes("\0") || options.size !== (command === "physical-client-status" ? 1 : 5)) throw new Error("invalid_operator_arguments");
  if (command === "physical-client-clear" && (options.get("--assert-inspected-idle") !== "true" ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(options.get("--slot") ?? "") ||
      !/^[a-f0-9]{32}$/.test(options.get("--generation") ?? "") ||
      !/^[A-Za-z0-9._@-]{1,128}$/.test(options.get("--operator") ?? ""))) throw new Error("invalid_operator_arguments");
  if (!lstatSync(filename).isFile()) throw new Error("invalid_operator_database");
  const store = openSessionStore({ filename });
  try {
    if (command === "physical-client-status") return JSON.stringify(store.listPhysicalCustody());
    const row = store.listPhysicalCustody().find((row) => row.physicalClientId === options.get("--slot") && row.physicalGenerationId === options.get("--generation") && row.state === "quarantined");
    if (!row) throw new Error("physical_client_clear_fenced");
    store.clearPhysicalClient({ physicalClientId: row.physicalClientId, physicalGenerationId: row.physicalGenerationId,
      occurrenceId: row.occurrenceId, bridgeSessionId: row.bridgeSessionId, assertInspectedIdle: true, operator: options.get("--operator")!, nowMs: Date.now() });
    return "physical_client_cleared";
  } finally { store.close(); }
}
if (import.meta.main) {
  try { console.log(runOperator(process.argv.slice(2))); }
  catch { console.error("physical_client_operator_failed"); process.exitCode = 2; }
}
