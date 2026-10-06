import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error Test-only JS.
import { postmeetingGatewayToml } from "./gateway-config.mjs";
const options = { recordingsDir: "/private/recordings", keyEnv: "PRIVATE_KEY", modelsDir: "/private/models", fixtureEndpoint: "http://127.0.0.1:1234" };
test("expiry calibration bounds lifetime and reconnect without changing ordinary defaults", () => {
  assert.match(postmeetingGatewayToml(options), /credential_lifetime_ms = 60000/);
  const config = postmeetingGatewayToml({ ...options, mediaTiming: { credentialLifetimeMs: 3000, reconnectWindowMs: 3000, maxOutboundQueueMs: 3000 } });
  assert.match(config, /credential_lifetime_ms = 3000/); assert.match(config, /reconnect_window_ms = 3000/);
  for (const mediaTiming of [{ credentialLifetimeMs: 0 }, { credentialLifetimeMs: 3000, reconnectWindowMs: 3001 }, { maxOutboundQueueMs: 10001 }, { credentialLifetimeMs: 1.5 }])
    assert.throws(() => postmeetingGatewayToml({ ...options, mediaTiming }), /invalid synthetic media timing/);
});
