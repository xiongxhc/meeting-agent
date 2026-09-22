import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import process from "node:process";
import { URL } from "node:url";

// Reviewed Runtime commit b03b3d6 on feat/meeting-online-profile (tree bac9e388;
// a commit will replace this id), not a copied codec or a source-path alias.
// Repin only together with a reviewed SDK package/consumer handoff.
const expected = {
  "browser.d.ts": "8c184a30fc0876283f4af2158f2cb37d19549d4cbefe65eeef67e815303fd2c0",
  "browser.js": "7348df3eed1f89412d45f9138141a86a6c86e35e6ff52d2a0ab786b3ae239cca",
  "client.d.ts": "fe6dd1738f652814ddd6567ed1d60602220ae6c31a8876afceb64c4f6075c76d",
  "client.js": "77a267a897c1f964fa16fd90793edb59e37db691bf9c56c803bf4b158d17e76a",
  "framing.d.ts": "5fcd94408934a9539074553d3b06746645f0141d59caf35c1327e00ae8bf5eab",
  "framing.js": "4597247a27a2d00432a59ae57aa3a95d125e738a349bfebfc648c11b0aefbf51",
  "index.d.ts": "04c93991e06301718d5f8730d28f8954004448ee6c80c81b5aac885e00400f32",
  "index.js": "55268849b500a84c93d00e1e9a2e93245a856bee5e93de2265569b69dc730751",
  "protocol.d.ts": "2fd4f644b3da9038bbf0cab49deb1b4298548f72c8c3bf3a6d8ba4ced1e38bc2",
  "protocol.js": "0b7cdbca69ff5f6ad5db3f6d2725a2b9d2f2df061665a671d51df4b8c0725a5f",
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
  process.stderr.write("Runtime SDK prerequisite missing or incompatible: after npm ci, build/pack reviewed Runtime b03b3d6314f03855adc8f2d060283483737fc444 on feat/meeting-online-profile and npm install --save-dev --ignore-scripts --no-save --package-lock=false /path/to/conversation-runtime-0.1.0.tgz. See README local SDK bootstrap. No fallback is enabled.\n");
  process.exitCode = 1;
}
