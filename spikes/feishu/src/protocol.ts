// Re-export shim. The frozen bridge-session/v1 contract now lives in the
// product tree at src/contracts/bridge-session-v1.ts (controller ruling R12:
// product code must not import from a spike directory, and re-authoring the
// validator would create the second implementation the contract freeze exists
// to prevent). This file keeps the spike's own modules and tests importing
// "./protocol.ts" unchanged.
export * from "../../../src/contracts/bridge-session-v1.ts";
