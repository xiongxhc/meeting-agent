import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pinnedRuntimeGateway } from "./lib/runtime-gateway.ts";
// @ts-expect-error Test-only harness module has no public declaration.
import { RUNTIME_PIN } from "../e2e/pins.mjs";

test("a gateway proof runs only the pinned gateway binary", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "runtime-gateway-pin-"));
  try {
    const binary = path.join(dir, "conversation-runtime-gateway");
    writeFileSync(binary, "synthetic gateway bytes");
    const digest = createHash("sha256").update("synthetic gateway bytes").digest("hex");
    assert.throws(() => pinnedRuntimeGateway({}), /set MEETING_TEST_RUNTIME_GATEWAY/);
    assert.throws(() => pinnedRuntimeGateway({ MEETING_TEST_RUNTIME_GATEWAY: "relative/gateway" }), /set MEETING_TEST_RUNTIME_GATEWAY/);
    assert.throws(() => pinnedRuntimeGateway({ MEETING_TEST_RUNTIME_GATEWAY: binary }), new RegExp(`not the pinned ${RUNTIME_PIN.name} gateway`));
    assert.equal(pinnedRuntimeGateway({ MEETING_TEST_RUNTIME_GATEWAY: binary }, digest), binary);
    assert.match(RUNTIME_PIN.gateway.sha256, /^[0-9a-f]{64}$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
