// The actual-gateway proofs run whatever MEETING_TEST_RUNTIME_GATEWAY names.
// They must run the reviewed gateway the installed SDK is pinned to, or fail.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
// @ts-expect-error Test-only harness module has no public declaration.
import { RUNTIME_PIN } from "../../e2e/pins.mjs";

export function pinnedRuntimeGateway(env: NodeJS.ProcessEnv = process.env, expectedSha256: string = RUNTIME_PIN.gateway.sha256): string {
  const binary = env["MEETING_TEST_RUNTIME_GATEWAY"];
  if (!binary || !path.isAbsolute(binary)) {
    throw new Error(`Prebuild the pinned ${RUNTIME_PIN.name} Runtime gateway and set MEETING_TEST_RUNTIME_GATEWAY; do not skip this proof`);
  }
  const digest = createHash("sha256").update(readFileSync(binary)).digest("hex");
  if (digest !== expectedSha256) throw new Error(`MEETING_TEST_RUNTIME_GATEWAY sha256 ${digest} is not the pinned ${RUNTIME_PIN.name} gateway ${expectedSha256}`);
  return binary;
}
