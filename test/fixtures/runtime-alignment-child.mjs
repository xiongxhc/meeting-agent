// Test-only Runtime-owned key generator, awaited/reaped by the private exec
// shell. The Meeting parent receives neither this key nor decrypted audio.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const [config] = process.argv.slice(2);
if (!config) process.exit(2);
const root = path.dirname(config), secretPath = path.join(root, "runtime-synthetic.key");
if (!existsSync(secretPath)) writeFileSync(secretPath, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
const secret = readFileSync(secretPath, "utf8");
if (!/^[0-9a-f]{64}$/.test(secret)) process.exit(2);
