import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import process from "node:process";
import { URL } from "node:url";

// Reviewed Runtime dbcd440 build, not a copied codec or a source-path alias.
// Repin only together with a reviewed SDK package/consumer handoff.
const expected = {
  "browser.d.ts": "8c184a30fc0876283f4af2158f2cb37d19549d4cbefe65eeef67e815303fd2c0",
  "browser.js": "7348df3eed1f89412d45f9138141a86a6c86e35e6ff52d2a0ab786b3ae239cca",
  "client.d.ts": "c7106a6c6a3b5c7d0c8a617d384852f408bb2e10de5713352b70a45d7dac8805",
  "client.js": "4541d5198fae608c65325b94fd70478b12e52a675231280e9676153731f965ad",
  "framing.d.ts": "5fcd94408934a9539074553d3b06746645f0141d59caf35c1327e00ae8bf5eab",
  "framing.js": "4597247a27a2d00432a59ae57aa3a95d125e738a349bfebfc648c11b0aefbf51",
  "index.d.ts": "909d9734173392911a4cb226d998c8351ec52faccc4676991ec07ee996d4fe5c",
  "index.js": "50b784d54fa6a4d6711bd69c2585e8c06030096cdcbe8a396384037ed7daf506",
  "protocol.d.ts": "a407000938b441b2ebbb6b084a6f0189fbcac0ccfb5642875b3fd4d70bd80110",
  "protocol.js": "43ee9404360a8557140739ca12bd434688b9aee78b8d51e8d70290e546849767",
  "stdio.d.ts": "280e2bf503c1d6cc36b8da7a9cd8629cf7c48bb2395b172aabbb06fdaa9b2569",
  "stdio.js": "92126b01369a96fcdd769f4e2dea56f1db6fa440cc6f8263c7ff486872904217",
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
  process.stderr.write("Runtime SDK prerequisite missing or incompatible: after npm ci, build/pack reviewed Runtime dbcd440924bd0bf7ed7f6ffe8c3d3c6b2dbf80ac and npm install --save-dev --no-save /path/to/conversation-runtime-0.1.0.tgz. See README local SDK bootstrap. No fallback is enabled.\n");
  process.exitCode = 1;
}
