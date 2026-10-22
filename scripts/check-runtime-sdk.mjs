import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import process from "node:process";
import { URL } from "node:url";

// Reviewed Runtime commit 67433a1 on feat/runtime-media-lease-evidence (tree eec6810a),
// packaged as runtime-lease-67433a1-20261022. SDK bytes are unchanged from runtime-lease-873153c-20261022.
// Repin only together with a reviewed SDK package/consumer handoff.
const expected = {
  "browser.d.ts": "8c184a30fc0876283f4af2158f2cb37d19549d4cbefe65eeef67e815303fd2c0",
  "browser.js": "7348df3eed1f89412d45f9138141a86a6c86e35e6ff52d2a0ab786b3ae239cca",
  "client.d.ts": "79b6e7de2374fd37412cfc3f9da048a2d29cfb054d351a1f48addff1197b15da",
  "client.js": "e3eee4456b5b92b93d7a89f1fbff19fdbde47c3f47d23ec13c12742e665dd904",
  "framing.d.ts": "5fcd94408934a9539074553d3b06746645f0141d59caf35c1327e00ae8bf5eab",
  "framing.js": "4597247a27a2d00432a59ae57aa3a95d125e738a349bfebfc648c11b0aefbf51",
  "index.d.ts": "04c93991e06301718d5f8730d28f8954004448ee6c80c81b5aac885e00400f32",
  "index.js": "55268849b500a84c93d00e1e9a2e93245a856bee5e93de2265569b69dc730751",
  "protocol.d.ts": "7a6c37de7a69db60580ff38f481d2bb039e927f761c151b7039980f2d325468f",
  "protocol.js": "32fc3d343593809259a708d5e867cdce78fd75aafd49d99a44e207c9df0dda08",
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
      typeof sdk.RuntimeClient?.prototype.readRecordingAlignment !== "function" ||
      typeof sdk.RuntimeClient?.prototype.startTimedVoiceSession !== "function" ||
      typeof sdk.RuntimeClient?.prototype.startDrainableTimedVoiceSession !== "function") throw new Error();
  if (sdk.DRAINABLE_TIMED_MEDIA_PROTOCOL_VERSION !== 3 || sdk.TIMED_MEDIA_PROTOCOL_VERSION !== 2) throw new Error();
} catch {
  process.stderr.write("Runtime SDK prerequisite missing or incompatible: after npm ci, build/pack reviewed Runtime 67433a150bb3c345fabb4f502fab3f349fdb7d9c on feat/runtime-media-lease-evidence and npm install --save-dev --ignore-scripts --no-save --package-lock=false /path/to/conversation-runtime-0.1.0.tgz. See README local SDK bootstrap. No fallback is enabled.\n");
  process.exitCode = 1;
}
