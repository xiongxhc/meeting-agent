// Service entry point. This is what a deployment runs (see package.json's
// "start" script); it is intentionally not part of the package's public
// "exports" -- consumers import the library-contract surface (currently
// src/config.ts) instead of this file.
//
// Nothing is wired here yet: no port has an adapter, no session coordinator
// exists. Task 1 only proves config loads and reports itself safely.

import { ConfigError, describeConfig, loadConfig } from "./config.ts";

export function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`meeting-agent: configuration error in ${error.field}`);
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  console.log("meeting-agent: configuration loaded", describeConfig(config));
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main();
}
