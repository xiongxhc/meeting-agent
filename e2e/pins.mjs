// The ONE place the built end-to-end harness names the Runtime artefacts.
// Swapping Runtime13 for Runtime14 is a two-line change here: point `root` at
// `artifacts/runtime14/` and replace the two digests with the ones that
// repin's `scripts/check-runtime-sdk.mjs` verifies. Nothing else in e2e/
// mentions an artefact path.
//
// The digests are refused-on-mismatch, not advisory: `verifyPins` throws
// before anything is staged, so a rebuilt or substituted gateway can never be
// exercised under a pin the evidence bundle then claims.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";

const ARTIFACTS = "<artifacts>";

/** Every Runtime build this harness knows how to run against. Switching is the
 * one-line change at `RUNTIME_PIN` below; nothing else in e2e/ names a build. */
export const RUNTIME_PROFILES = {
  /** What `scripts/check-runtime-sdk.mjs` verifies at 181c511. */
  "runtime13-pin": {
    name: "runtime13-pin",
    root: path.join(ARTIFACTS, "runtime13-pin"),
    /** Reviewed Runtime 4c9dc85ddbb513c61abc738d06ea10e61ab8c885. */
    revision: "4c9dc85ddbb513c61abc738d06ea10e61ab8c885",
    gateway: {
      path: path.join(ARTIFACTS, "runtime13-pin/target/debug/conversation-runtime-gateway"),
      sha256: "3ba5145bd6cb418e001600bcd2157c931030eab4af80258294ed02c9153d904b",
    },
    sdkTarball: {
      path: path.join(ARTIFACTS, "runtime13-pin/stage/conversation-runtime-0.1.0.tgz"),
      sha256: "a453edbc60e20d01bceff569df09cad74ada1c2e030b4df1d40e98b433e35d02",
    },
  },
  /** The Runtime14 repin that lands with feat/meeting-agent-core c7f309d
   * (drainable v3 admission, MED3 test producers, migration 028). Selecting it
   * needs the repinned `scripts/check-runtime-sdk.mjs` in the same tree, so
   * root flips RUNTIME_PIN after the rebase. Digests measured 2026-09-22. */
  runtime14b: {
    name: "runtime14b",
    root: path.join(ARTIFACTS, "runtime14b"),
    /** Reviewed Runtime b03b3d6314f03855adc8f2d060283483737fc444 on
     * feat/meeting-online-profile, the commit `scripts/check-runtime-sdk.mjs`
     * verifies in this tree. */
    revision: "b03b3d6314f03855adc8f2d060283483737fc444",
    gateway: {
      path: path.join(ARTIFACTS, "runtime14b/target/debug/conversation-runtime-gateway"),
      sha256: "30dcde79d9cc1dd8a7ea47d1d3ad068b104f76d08f93af801922d9f5c3fb4a08",
    },
    sdkTarball: {
      path: path.join(ARTIFACTS, "runtime14b/stage/conversation-runtime-0.1.0.tgz"),
      sha256: "0501d127fb90ef5a3ac41001a6b26e535f5d71e9400a53ecf31fd200442e0e06",
    },
  },
};

/** The selected build. Swap this one line to move the whole harness. */
export const RUNTIME_PIN = RUNTIME_PROFILES.runtime14b;

/** The accepted TeamMem staged tree the wheel is built from (D003 scope). */
export const TEAMMEM_SOURCE = {
  repository: "<teammem-checkout>",
  /** Tree of 1ebf774, the accepted head of the TeamMem meeting-storage lane. */
  tree: "6ad2443462a283a4a66e33389068f70b5984df5a",
};

export async function sha256File(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

/** Refuses to run on any mismatch with the recorded pin. */
export async function verifyPins() {
  const measured = {};
  for (const key of ["gateway", "sdkTarball"]) {
    const pin = RUNTIME_PIN[key];
    const sha256 = await sha256File(pin.path);
    if (sha256 !== pin.sha256) {
      throw new Error(`runtime pin mismatch for ${key}: expected ${pin.sha256}, measured ${sha256}`);
    }
    measured[key] = { path: pin.path, sha256 };
  }
  return measured;
}
