import assert from "node:assert/strict";
import { test } from "node:test";
import type { RecordingAlignmentPage } from "@conversation/runtime";
import { ALIGNMENT_LIMITS, decodeAlignmentPage, encodeAlignmentPage } from "../src/sessions/recording-alignment.ts";
import { testCapability } from "./lib/runtime-sdk.ts";

const policy = { id: "local-wall-estimate/v1", cadenceTargetNs: 1_000_000_000n, maximumBracketNs: 5_000_000n,
  maximumPairGapNs: 2_000_000_000n, maximumResidualNs: 10_000_000n } as const;
function page(): RecordingAlignmentPage {
  return { type: "recording_alignment_page", source: { sourceSessionId: testCapability.sourceSessionId,
    recordingHandle: testCapability.recordingHandle, sha256: testCapability.sha256 }, pageIndex: 0n, policy,
    entries: [{ kind: "clock_pair", pair: { clockDomainId: "synthetic-domain", wallEpoch: 1n, sequence: 1n,
      hostBeforeNs: 1n, hostAfterNs: (1n << 64n) - 1n, localUnixNs: -(1n << 63n), wallResolutionNs: 0n, externalUtcAccuracyNs: null } }] };
}

test("private alignment codec roundtrips bigint extrema and retains unknown uncertainty", () => {
  const value = page(), encoded = encodeAlignmentPage(value);
  assert.deepEqual(decodeAlignmentPage(encoded), value);
  assert.ok(encoded.includes('"u64"')); assert.ok(encoded.includes('"i64"'));
});

test("private alignment codec rejects corrupt tags, unknown shapes and noncanonical integers", () => {
  const encoded = encodeAlignmentPage(page());
  for (const corrupt of [encoded.replace('"u64"', '"u128"'), encoded.replace('"i64"', '"mystery"'),
    encoded.replace('"41"', '"041"'), encoded.replace('"41"', '"18446744073709551616"'),
    encoded.replace('"schema":1', '"schema":2'), encoded.replace('"pageIndex":', '"unexpected":'), '{']) {
    assert.throws(() => decodeAlignmentPage(corrupt), /invalid private alignment page/);
  }
  assert.throws(() => decodeAlignmentPage(" ".repeat(ALIGNMENT_LIMITS.privatePageBytes + 1)), /invalid private alignment page/);
});

test("private alignment codec independently caps entry count and UTF8 stored bytes", () => {
  const value = page();
  assert.throws(() => encodeAlignmentPage({ ...value, entries: Array.from({ length: 65 }, () => ({ kind: "alignment_limit" as const })) }), /invalid private alignment page/);
  // The stored-byte cap is proved against a genuinely maximal page in
  // test/recording-alignment-page-bound.test.ts; 64 lean frames fit inside
  // the private bound D032 §1 derives from the SDK's wire page size.
});
