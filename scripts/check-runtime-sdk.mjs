import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import process from "node:process";
import { URL } from "node:url";

// Reviewed Runtime 4c9dc85 build, not a copied codec or a source-path alias.
// Repin only together with a reviewed SDK package/consumer handoff.
const expected = {
  "browser.d.ts": "8c184a30fc0876283f4af2158f2cb37d19549d4cbefe65eeef67e815303fd2c0",
  "browser.js": "7348df3eed1f89412d45f9138141a86a6c86e35e6ff52d2a0ab786b3ae239cca",
  "client.d.ts": "c7106a6c6a3b5c7d0c8a617d384852f408bb2e10de5713352b70a45d7dac8805",
  "client.js": "77e2dba96f216b1b7117043a6e47d66f8e1381ddafa6e116ebed8285a7cca5b7",
  "framing.d.ts": "5fcd94408934a9539074553d3b06746645f0141d59caf35c1327e00ae8bf5eab",
  "framing.js": "4597247a27a2d00432a59ae57aa3a95d125e738a349bfebfc648c11b0aefbf51",
  "index.d.ts": "34ff173150441532fed2c1bdccd6f0b5f003975fa6224cf6d2966723e046e304",
  "index.js": "f2b981ed672fa1e7385d55067e19cf3d74a1a1fd5c3e7eda226f8d18b19b78bc",
  "protocol.d.ts": "a407000938b441b2ebbb6b084a6f0189fbcac0ccfb5642875b3fd4d70bd80110",
  "protocol.js": "43ee9404360a8557140739ca12bd434688b9aee78b8d51e8d70290e546849767",
  "stdio.d.ts": "48225a81896fcb24caa2a640a855688a36e6591d701fdae252bc48a72497d257",
  "stdio.js": "44b3c0654cf0b631f248c024fe90be2702c120134b9213a654f0cc0119df3901",
};
try {
  const entry = new URL(import.meta.resolve("@conversation/runtime"));
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", entry), "utf8"));
  if (manifest.name !== "@conversation/runtime" || manifest.version !== "0.1.0") throw new Error();
  for (const [name, digest] of Object.entries(expected)) {
    if (createHash("sha256").update(readFileSync(new URL(name, entry))).digest("hex") !== digest) throw new Error();
  }
  const sdk = await import("@conversation/runtime");
  if (sdk.FINALIZED_RECORDING_PROTOCOL_VERSION !== 4 || typeof sdk.RuntimeClient?.connect !== "function" ||
      typeof sdk.RuntimeClient?.prototype.readRecordingAlignment !== "function") throw new Error();
} catch {
  process.stderr.write("Runtime SDK prerequisite missing or incompatible: after npm ci, build/pack reviewed Runtime 4c9dc85ddbb513c61abc738d06ea10e61ab8c885 and npm install --save-dev --ignore-scripts --no-save --package-lock=false /path/to/conversation-runtime-0.1.0.tgz. See README local SDK bootstrap. No fallback is enabled.\n");
  process.exitCode = 1;
}
