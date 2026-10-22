import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import process from "node:process";
import { URL } from "node:url";

// Reviewed Runtime commit c936474 on feat/runtime-media-lease-evidence (tree 374bfd33),
// packaged as runtime-lease-c936474-20261022.
// Repin only together with a reviewed SDK package/consumer handoff.
const expected = {
  "browser.d.ts": "8c184a30fc0876283f4af2158f2cb37d19549d4cbefe65eeef67e815303fd2c0",
  "browser.js": "7348df3eed1f89412d45f9138141a86a6c86e35e6ff52d2a0ab786b3ae239cca",
  "client.d.ts": "2cc53bf67142c9546187045c86e358e28190c95ee9925a61e83ad110a173918d",
  "client.js": "b5228db6e633b64580a57a9a1f612b368299793a7f7319454672b83fe4043b07",
  "framing.d.ts": "5fcd94408934a9539074553d3b06746645f0141d59caf35c1327e00ae8bf5eab",
  "framing.js": "4597247a27a2d00432a59ae57aa3a95d125e738a349bfebfc648c11b0aefbf51",
  "index.d.ts": "04c93991e06301718d5f8730d28f8954004448ee6c80c81b5aac885e00400f32",
  "index.js": "55268849b500a84c93d00e1e9a2e93245a856bee5e93de2265569b69dc730751",
  "protocol.d.ts": "63e4efc77159c2d2137373bf48264e0a0ea38c5dc04e4ae2456a228c4cad3a2b",
  "protocol.js": "8aea7648855e42949450cb37ce8fea5a5fbf73c0b4174190905a7373a3f9216a",
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
  process.stderr.write("Runtime SDK prerequisite missing or incompatible: after npm ci, build/pack reviewed Runtime c9364746d9cd0866df4d68cd6bd3e06d0abc5b77 on feat/runtime-media-lease-evidence and npm install --save-dev --ignore-scripts --no-save --package-lock=false /path/to/conversation-runtime-0.1.0.tgz. See README local SDK bootstrap. No fallback is enabled.\n");
  process.exitCode = 1;
}
