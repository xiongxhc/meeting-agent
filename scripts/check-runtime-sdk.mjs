import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import process from "node:process";
import { URL } from "node:url";

// Reviewed Runtime4c97c47 build, not a copied codec or a source-path alias.
// Repin only together with a reviewed SDK package/consumer handoff.
const expected = {
  "browser.d.ts": "042af9855886f73c09dffd9961490aefbdb11b4cde9c54159da7cf6ff2e468d9",
  "browser.js": "7348df3eed1f89412d45f9138141a86a6c86e35e6ff52d2a0ab786b3ae239cca",
  "client.d.ts": "1fa3cc840049ee63f16ac9d8de7a23075276e1a915edb42e9b279188e80deda9",
  "client.js": "0ce8f5224f9558a5d557593d9683d9107092eeed05962f6626ab35b98f8541ca",
  "framing.d.ts": "5fcd94408934a9539074553d3b06746645f0141d59caf35c1327e00ae8bf5eab",
  "framing.js": "4597247a27a2d00432a59ae57aa3a95d125e738a349bfebfc648c11b0aefbf51",
  "index.d.ts": "a492699199a9960c77e49179f9a5068ec0337dab66c0f734dfd369f519bdaaff",
  "index.js": "50b784d54fa6a4d6711bd69c2585e8c06030096cdcbe8a396384037ed7daf506",
  "protocol.d.ts": "f45771ed862c0f5c33113b004d8fae1cd7bd66f38ba84b3cf459ab77c78736f3",
  "protocol.js": "e454d497722d3c6a1c67f940265bee05bad1e72758d65ca3eeaf5481e87a4ecd",
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
  process.stderr.write("Runtime SDK prerequisite missing or incompatible: after npm ci, build/pack reviewed Runtime 4c97c47c9cb044728413516c48aa86534e58523b and npm install --save-dev --no-save /path/to/conversation-runtime-0.1.0.tgz. See README local SDK bootstrap. No fallback is enabled.\n");
  process.exitCode = 1;
}
