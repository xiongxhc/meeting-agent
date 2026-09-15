import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import process from "node:process";
import { URL } from "node:url";

// Reviewed Runtime6f8e88f build, not a copied codec or a source-path alias.
// Repin only together with a reviewed SDK package/consumer handoff.
const expected = {
  "browser.d.ts": "48b0c79181a0b5ce076d892f8cc4274dea8191ba61cd8fcfd705a5d204abb219",
  "browser.js": "7348df3eed1f89412d45f9138141a86a6c86e35e6ff52d2a0ab786b3ae239cca",
  "client.d.ts": "1fa3cc840049ee63f16ac9d8de7a23075276e1a915edb42e9b279188e80deda9",
  "client.js": "0ce8f5224f9558a5d557593d9683d9107092eeed05962f6626ab35b98f8541ca",
  "framing.d.ts": "5fcd94408934a9539074553d3b06746645f0141d59caf35c1327e00ae8bf5eab",
  "framing.js": "4597247a27a2d00432a59ae57aa3a95d125e738a349bfebfc648c11b0aefbf51",
  "index.d.ts": "a8c031d1e9ef4968fff8f6b9e4e472c77da3ed919b2f4e17f41596eabfe53d75",
  "index.js": "50b784d54fa6a4d6711bd69c2585e8c06030096cdcbe8a396384037ed7daf506",
  "protocol.d.ts": "013c969496ba9ed9be12ac5eca89309bdae29e3e50e90d916e09994167cffe5f",
  "protocol.js": "aa1c8eefa2773a2c2f8fb0c648b0f917cdde3519a798350ff9420ccd4c75a462",
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
  process.stderr.write("Runtime SDK prerequisite missing or incompatible: after npm ci, build/pack reviewed Runtime 6f8e88ff1376d0dd541a3616725280cde42dfde7 and npm install --save-dev --no-save /path/to/conversation-runtime-0.1.0.tgz. See README local SDK bootstrap. No fallback is enabled.\n");
  process.exitCode = 1;
}
