// The ONE place the built end-to-end harness names packaged Runtime artefacts.
// Each reviewed profile pins the production gateway and SDK, with separate
// feature-only scripted binaries where available.
//
// The digests are refused-on-mismatch, not advisory: `verifyPins` throws
// before anything is staged, so a rebuilt or substituted gateway can never be
// exercised under a pin the evidence bundle then claims.

import { createHash } from "node:crypto";
import { closeSync, constants, createReadStream, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { Buffer } from "node:buffer";
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
  runtime14c: {
    name: "runtime14c",
    root: path.join(ARTIFACTS, "runtime14c"),
    revision: "de8581a58a181ce7693177cae102ca617965c24d",
    gateway: {
      path: path.join(ARTIFACTS, "runtime14c/target/debug/conversation-runtime-gateway"),
      sha256: "29a6f5dcb3ea464fefd5f0744185da5428606d60a17295f2c1543a12dbbde7f9",
    },
    scriptedGateway: {
      path: path.join(ARTIFACTS, "runtime14c/target/debug/conversation-runtime-gateway-scripted"),
      sha256: "ecc4c484414e63ec14888dd50ec5384fce548a3b0e462d1f54c9c38a32606858",
    },
    scriptedPeers: {
      path: path.join(ARTIFACTS, "runtime14c/target/debug/conversation-runtime-scripted-peers"),
      sha256: "869f2cdd283483a8ed70137c1d2dd75d9104bdc1c99f3d9cfded2825b961e2b2",
    },
    sdkTarball: {
      path: path.join(ARTIFACTS, "runtime14c/stage/conversation-runtime-0.1.0.tgz"),
      sha256: "0501d127fb90ef5a3ac41001a6b26e535f5d71e9400a53ecf31fd200442e0e06",
    },
  },
  runtime14d: {
    name: "runtime14d",
    root: path.join(ARTIFACTS, "runtime14d"),
    revision: "316a3f6017aa483bc13af845d1049924fac62d01",
    gateway: {
      path: path.join(ARTIFACTS, "runtime14d/target/debug/conversation-runtime-gateway"),
      sha256: "cfc7517cdfb5fdf599b5fa70bbfa2befeefea0ee267a9f7ba2a7d12935bd4c08",
    },
    scriptedGateway: {
      path: path.join(ARTIFACTS, "runtime14d/target/debug/conversation-runtime-gateway-scripted"),
      sha256: "979598b3b45403eddfa8bea7b3adfc23e0136de37a08c39fc42f3cbcef81af6e",
    },
    scriptedPeers: {
      path: path.join(ARTIFACTS, "runtime14d/target/debug/conversation-runtime-scripted-peers"),
      sha256: "4fef2514e7023b339e5b61702a89cb1af79d7b8f4f8d6cb4b00100079c2da189",
    },
    sdkTarball: {
      path: path.join(ARTIFACTS, "runtime14d/stage/conversation-runtime-0.1.0.tgz"),
      sha256: "0501d127fb90ef5a3ac41001a6b26e535f5d71e9400a53ecf31fd200442e0e06",
    },
  },
};

// Independent identities from the closed package review, including its mandatory
// external correction. This profile is a build-only TEST candidate, never a repin.
const EVIDENCE_ROOT = path.join(ARTIFACTS, "runtime-media-evidence-20261005");
export const EXPIRY_EVIDENCE_PROVENANCE = Object.freeze({
  profile: "runtime-media-evidence-test-20261005",
  artifactManifestSha256: "8a87dc170ac61269b90ebc04de5ca64328a61dc34ba3cb160a5cda1aa0573d60",
  sourceManifestSha256: "c507b00eed740c5626722a7911d77c6dcf00e1f8d9f371655a7543eeca78e421",
  patchSha256: "1f6f24fddd4e9b7e51f73ecd580cde99a96f7800998cef3af0b4c68217b70e08",
  buildMetadataSha256: "c69377ee52965677ccecfc68814022da46c8ec72e227b0226e8632bf21e6660f",
  erratumSha256: "36f1e405683b7650c68d197a8b513f2f5b1a2f1d52859ceee372d21127260977",
  reconciledAuditSha256: "3b810491e2329658e3e7324f8a2087dd4789af09aaf5ef3d41bc8e3245d1030a",
  base: "316a3f6017aa483bc13af845d1049924fac62d01",
  candidateTree: "0d345bd712c0a166dce93777b471456a978e4f64",
  gatewaySha256: "799518c26501d752887590bebafa8b5d3be9089aad9ecbbe79e0d7a1c6824f86",
  sdkSha256: "0501d127fb90ef5a3ac41001a6b26e535f5d71e9400a53ecf31fd200442e0e06",
});
export const EXPIRY_EVIDENCE_PROFILE = Object.freeze({
  name: EXPIRY_EVIDENCE_PROVENANCE.profile,
  root: EVIDENCE_ROOT,
  revision: EXPIRY_EVIDENCE_PROVENANCE.base,
  gateway: Object.freeze({ path: path.join(EVIDENCE_ROOT, "bin/conversation-runtime-gateway-media-admission-evidence"), sha256: EXPIRY_EVIDENCE_PROVENANCE.gatewaySha256 }),
  sdkTarball: Object.freeze({ path: path.join(EVIDENCE_ROOT, "sdk/conversation-runtime-0.1.0.tgz"), sha256: EXPIRY_EVIDENCE_PROVENANCE.sdkSha256 }),
  packagePaths: Object.freeze({
    artifactManifest: path.join(EVIDENCE_ROOT, "artifact-manifest.json"),
    sourceManifest: path.join(EVIDENCE_ROOT, "source-manifest.json"),
    patch: path.join(EVIDENCE_ROOT, "runtime-media-evidence.patch"),
    buildMetadata: path.join(EVIDENCE_ROOT, "build-metadata.json"),
    erratum: path.join(ARTIFACTS, "../handoff/meeting-runtime-media-evidence-package-erratum-20261006.md"),
    reconciledAudit: path.join(ARTIFACTS, "runtime-media-evidence-workspace-reconciled-audit-20261006.json"),
  }),
});
RUNTIME_PROFILES[EXPIRY_EVIDENCE_PROFILE.name] = EXPIRY_EVIDENCE_PROFILE;
Object.freeze(RUNTIME_PROFILES);

/** The selected build. Swap this one line to move the whole harness. */
export const RUNTIME_PIN = RUNTIME_PROFILES.runtime14d;

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
export async function verifyPins(profile = RUNTIME_PIN) {
  profile = resolveRuntimeProfile(profile);
  const provenance = profile === EXPIRY_EVIDENCE_PROFILE ? validateExpiryEvidencePackage() : undefined;
  const measured = {};
  for (const key of ["gateway", "sdkTarball", "scriptedGateway", "scriptedPeers"]) {
    const pin = profile[key];
    if (pin === undefined) continue;
    const sha256 = profile === EXPIRY_EVIDENCE_PROFILE ? sha256FileSync(pin.path) : await sha256File(pin.path);
    if (sha256 !== pin.sha256) {
      throw new Error(`runtime pin mismatch for ${key}: expected ${pin.sha256}, measured ${sha256}`);
    }
    measured[key] = { path: pin.path, sha256 };
  }
  if (provenance) measured.provenance = provenance;
  return measured;
}

/** Only a registered name or the actual registered object is selectable. */
export function resolveRuntimeProfile(profile = RUNTIME_PIN) {
  const selected = typeof profile === "string" && Object.hasOwn(RUNTIME_PROFILES, profile) ? RUNTIME_PROFILES[profile] : profile;
  if (!Object.values(RUNTIME_PROFILES).includes(selected)) throw new Error("unknown runtime profile");
  return selected;
}

function packageRequire(value) {
  if (!value) throw new Error("expiry evidence package mismatch");
}
function noSymlinkAncestry(filename) {
  packageRequire(path.isAbsolute(filename) && path.normalize(filename) === filename);
  let cursor = path.parse(filename).root;
  for (const piece of filename.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, piece);
    packageRequire(!lstatSync(cursor).isSymbolicLink());
  }
}
function readRegularPackageFile(filename, maxBytes, read) {
  noSymlinkAncestry(filename);
  const namedBefore = lstatSync(filename);
  packageRequire(namedBefore.isFile() && namedBefore.nlink === 1 && namedBefore.size <= maxBytes);
  // The named regular-file precheck alone leaves a replacement interval: a FIFO
  // swapped in before open must also refuse without waiting for a writer.
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    const same = stat => stat.isFile() && stat.dev === namedBefore.dev && stat.ino === namedBefore.ino && stat.size === namedBefore.size && stat.mode === namedBefore.mode && stat.uid === namedBefore.uid && stat.nlink === 1;
    packageRequire(same(before));
    const result = read(fd, before.size);
    noSymlinkAncestry(filename);
    packageRequire(same(fstatSync(fd)) && same(lstatSync(filename)));
    return result;
  } finally { closeSync(fd); }
}
/** Synchronous bounded hashing keeps existing stage() callers synchronous. */
export function sha256FileSync(filename) {
  return readRegularPackageFile(filename, 128 * 1024 * 1024, (fd, size) => {
    const hash = createHash("sha256"), buffer = Buffer.alloc(65536);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      packageRequire(count > 0); hash.update(buffer.subarray(0, count)); offset += count;
    }
    return hash.digest("hex");
  });
}
function relativeEntry(root, relative) {
  packageRequire(typeof relative === "string" && relative.length > 0 && !relative.includes("\0") && !relative.includes("\\") && !path.isAbsolute(relative) && path.posix.normalize(relative) === relative && !relative.split("/").some(piece => piece === ".." || piece === "."));
  return path.join(root, relative);
}
function inventory(root, excluded = []) {
  const files = [];
  function visit(directory, prefix) {
    const before = files.length;
    noSymlinkAncestry(directory);
    packageRequire((lstatSync(directory).mode & 0o7777) === 0o555);
    for (const name of readdirSync(directory)) {
      const relative = prefix ? `${prefix}/${name}` : name, filename = relativeEntry(root, relative), stat = lstatSync(filename);
      packageRequire(!stat.isSymbolicLink());
      if (excluded.includes(relative)) { packageRequire(stat.isDirectory()); continue; }
      if (stat.isDirectory()) visit(filename, relative);
      else { packageRequire(stat.isFile()); files.push(relative); }
    }
    packageRequire(prefix === "" || files.length > before);
  }
  visit(root, ""); return files.sort();
}
function verifyEntries(root, entries, modeKey) {
  const names = new Set();
  for (const entry of entries) {
    const filename = relativeEntry(root, entry.path); packageRequire(!names.has(entry.path)); names.add(entry.path);
    const stat = lstatSync(filename);
    const mode = modeKey === "mode" ? ({ "100644": 0o444, "100755": 0o555 })[entry.mode] : ({ "0o444": 0o444, "0o555": 0o555 })[entry.finalMode];
    packageRequire(mode !== undefined && stat.isFile() && stat.nlink === 1 && stat.size === entry.bytes && (stat.mode & 0o7777) === mode && sha256FileSync(filename) === entry.sha256);
  }
  return [...names].sort();
}
function jsonFile(filename) {
  const bytes = readRegularPackageFile(filename, 1024 * 1024, (fd, size) => {
    const bytes = Buffer.alloc(size); let offset = 0;
    while (offset < size) {
      const count = readSync(fd, bytes, offset, size - offset, offset);
      packageRequire(count > 0); offset += count;
    }
    return bytes;
  });
  return JSON.parse(bytes.toString("utf8"));
}

/** Finite validator for the independently reviewed 446-source/462-artifact
 * package. Alternate root is for byte-for-byte private-copy refusal tests;
 * it never changes the registered stage profile or independent authority. */
export function validateExpiryEvidencePackage(packageRoot = EVIDENCE_ROOT, externalPaths = EXPIRY_EVIDENCE_PROFILE.packagePaths) {
  const p = EXPIRY_EVIDENCE_PROVENANCE;
  const local = { artifactManifest: "artifact-manifest.json", sourceManifest: "source-manifest.json", patch: "runtime-media-evidence.patch", buildMetadata: "build-metadata.json" };
  for (const [key, relative] of Object.entries(local)) packageRequire(sha256FileSync(relativeEntry(packageRoot, relative)) === p[`${key}Sha256`]);
  for (const key of ["erratum", "reconciledAudit"]) packageRequire(sha256FileSync(externalPaths[key]) === p[`${key}Sha256`]);
  const manifest = jsonFile(path.join(packageRoot, local.artifactManifest));
  const source = jsonFile(path.join(packageRoot, local.sourceManifest));
  const build = jsonFile(path.join(packageRoot, local.buildMetadata));
  for (const value of [manifest, source, build]) packageRequire(value.base === p.base && value.baseTree === "dd73d3537184a5e4aae15db7d014861bed5b40eb" && value.candidateTree === p.candidateTree);
  packageRequire(manifest.schema === "runtime-media-evidence-package/v1" && source.schema === "runtime-media-evidence-source/v1" && build.schema === "runtime-media-evidence-build/v1");
  packageRequire(source.sourceEntries.length === 446 && source.sourceBlobCount === 446 && source.baselineBlobCount === 445 && source.unchangedBaseBlobCount === 441);
  const changed = ["apps/runtime-gateway/Cargo.toml", "apps/runtime-gateway/src/lib.rs", "apps/runtime-gateway/src/main.rs", "apps/runtime-gateway/src/media_admission_evidence.rs", "apps/runtime-gateway/src/media_server.rs"];
  packageRequire(JSON.stringify(source.sources.map(entry => entry.path).sort()) === JSON.stringify(changed));
  // The externally pinned complete source manifest is the independently reviewed
  // base comparison (including unchanged Cargo.lock, public protocol and SDK).
  const sourceRoot = path.join(packageRoot, "source");
  packageRequire(JSON.stringify(verifyEntries(sourceRoot, source.sourceEntries, "mode")) === JSON.stringify(inventory(sourceRoot)));
  packageRequire(manifest.files.length === 462 && JSON.stringify(manifest.excluded) === '[".build-target/"]');
  const portable = [...verifyEntries(packageRoot, manifest.files, "finalMode"), "artifact-manifest.json"].sort();
  packageRequire(JSON.stringify(portable) === JSON.stringify(inventory(packageRoot, [".build-target"])));
  packageRequire((lstatSync(path.join(packageRoot, local.artifactManifest)).mode & 0o7777) === 0o444);
  const feature = build.builds.find(item => item.variant === "media-admission-evidence");
  packageRequire(feature?.exit === 0 && feature.binary.ordinaryGateway === true && feature.scriptedProvidersEnabled === false && JSON.stringify(feature.featuresRequested) === '["media-admission-evidence"]' && feature.binary.sha256 === p.gatewaySha256);
  packageRequire(build.acceptedSdkRepackedOrInstalled === false && source.sdk.unchangedAcceptedTar === true && source.sdk.sha256 === p.sdkSha256);
  const audit = jsonFile(externalPaths.reconciledAudit);
  packageRequire(audit.schema === "runtime-workspace-reconciled-audit/v1" && audit.summaryTotals.failed === 302 && audit.fullGatePass === false && audit.capturedProcessExit === null && audit.processCleanupCoverage === "unknown");
  return { ...p };
}
