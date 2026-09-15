import assert from "node:assert/strict";
import { test } from "node:test";
import type { RecordingAlignmentPage } from "@conversation/runtime";
import { decodeAlignmentPage, encodeAlignmentPage } from "../src/sessions/recording-alignment.ts";
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
  assert.throws(() => decodeAlignmentPage(" ".repeat(32 * 1024 + 1)), /invalid private alignment page/);
});

test("private alignment codec independently caps entry count and UTF8 stored bytes", () => {
  const value = page();
  assert.throws(() => encodeAlignmentPage({ ...value, entries: Array.from({ length: 65 }, () => ({ kind: "alignment_limit" as const })) }), /invalid private alignment page/);
  const frame = { kind: "frame" as const, mediaStartSample: 0n, mediaEndSample: 480n, sampleRateHz: 24000, gapOffsetMs: 0n,
    epoch: null, provenance: null, captureStatus: "capture_alignment_missing" as const, wall: null,
    reasons: ["capture_alignment_missing", "wall_alignment_missing", "clock_domain_mismatch", "inconsistent_coordinates", "source_discontinuity",
      "missing_clock_pair", "clock_bracket_exceeded", "clock_pair_gap", "wall_clock_discontinuity", "arithmetic_overflow"] };
  assert.throws(() => encodeAlignmentPage({ ...value, entries: Array.from({ length: 64 }, () => frame) }), /invalid private alignment page/);
});
