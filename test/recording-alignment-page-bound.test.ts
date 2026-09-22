// D032 §1: the page size Meeting enforces is the gateway's WIRE page bound,
// and the private bigint-tagged re-encoding gets its own bound derived from
// it. A maximal wire page must survive that re-encoding, or a long capture
// loses its alignment and every artifact build after it fails.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { MAX_ALIGNMENT_PAGE_BYTES } from "@conversation/runtime";
import type { RecordingAlignmentEntry, RecordingAlignmentPage } from "@conversation/runtime";

import { ALIGNMENT_LIMITS, decodeAlignmentPage, encodeAlignmentPage } from "../src/sessions/recording-alignment.ts";

/** Every reason the page grammar admits, which is the most one frame carries. */
const REASONS = ["source_drop", "sequence_hole", "reconnect", "pause", "epoch_reset", "missing_timing",
  "inconsistent_coordinates", "source_discontinuity", "alignment_limit_exceeded", "audio_missing",
  "capture_alignment_missing", "wall_alignment_missing", "wall_clock_discontinuity", "clock_pair_gap",
  "clock_bracket_exceeded", "missing_clock_pair", "clock_domain_mismatch", "arithmetic_overflow",
  "local_wall_timestamp_estimate", "unavailable_legacy"] as const;

const IDENTIFIER = "b".repeat(64);
const RATE = 24_000, SAMPLES = 480;

function frame(index: number): RecordingAlignmentEntry {
  const start = BigInt(index * SAMPLES), end = start + BigInt(SAMPLES);
  const host = BigInt(index + 1) * 20_000_000n;
  return {
    kind: "frame",
    mediaStartSample: start,
    mediaEndSample: end,
    sampleRateHz: RATE,
    gapOffsetMs: BigInt(index) * 20n,
    epoch: { bridgeSessionId: IDENTIFIER, clockDomainId: IDENTIFIER, captureEpoch: 9_007_199_254_740_993n },
    provenance: {
      captureEpoch: 9_007_199_254_740_993n,
      sequence: BigInt(index + 1),
      outputStartSample: start,
      sampleCount: SAMPLES,
      sourceStartNumerator: start * BigInt(RATE),
      sourceEndNumerator: end * BigInt(RATE),
      sourceDenominator: RATE,
      sourceRateHz: RATE,
      quality: "nominal_frame_endpoint_interpolation",
      span: { hostStartNs: host, hostEndNs: host + 20_000_000n, roundingEnvelopeNs: 1_000n, captureUncertaintyNs: 2_000n },
    },
    captureStatus: "available",
    wall: {
      quality: "local_wall_estimate", policyId: "local-wall-estimate/v1",
      localStartNs: 1_790_000_000_000_000_000n + BigInt(index) * 20_000_000n,
      localEndNs: 1_790_000_000_000_000_000n + BigInt(index + 1) * 20_000_000n,
      wallEpoch: 7n, wallRun: 11n, maximumBracketNs: 5_000_000n, maximumResolutionNs: 1_000n,
      modelAllowanceNs: 10_000_000n, interpolationRoundingNs: 500n, captureRoundingNs: 500n,
      captureUncertaintyNs: 2_000n, externalUtcAccuracyNs: 3_000n, overallPhysicalAccuracyNs: null,
    },
    reasons: [...REASONS],
  };
}

/** 64 frames, each carrying every reason and 64-byte identifiers: the largest
 * page the GRAMMAR admits. It is not a page the gateway can send. Measured at
 * 102 092 wire bytes against its own 32 768-byte wire cap, so the traversal
 * would never produce one; the proof below therefore takes the largest page
 * the gateway CAN send out of these richest frames (20 entries, 32 089 wire
 * bytes) and shows its private re-encoding fits. */
function maximalPage(): RecordingAlignmentPage {
  return {
    type: "recording_alignment_page",
    source: { sourceSessionId: 9_007_199_254_740_993n, recordingHandle: "a".repeat(32), sha256: "c".repeat(64) },
    pageIndex: 4_000n,
    policy: { id: "local-wall-estimate/v1", cadenceTargetNs: 1_000_000_000n, maximumBracketNs: 5_000_000n,
      maximumPairGapNs: 2_000_000_000n, maximumResidualNs: 10_000_000n },
    entries: Array.from({ length: ALIGNMENT_LIMITS.pageEntries }, (_value, index) => frame(index)),
  };
}

test("the page bound is the SDK's wire page bound, not a restated number", () => {
  assert.equal(ALIGNMENT_LIMITS.pageBytes, MAX_ALIGNMENT_PAGE_BYTES);
  assert.equal(ALIGNMENT_LIMITS.privatePageBytes, 2 * MAX_ALIGNMENT_PAGE_BYTES);
});

test("the stored-page CHECK admits exactly what the codec produces", () => {
  const migration = readFileSync(path.resolve(import.meta.dirname, "../migrations/029_alignment_page_private_bound.sql"), "utf8");
  assert.match(migration, new RegExp(`BETWEEN 1 AND ${ALIGNMENT_LIMITS.privatePageBytes}`),
    "the schema bound and the codec bound are one number; a page the codec accepts must be storable");
});

/** The gateway's own spelling of a page: integers that may exceed 2^53
 * travel as decimal strings, everything else as plain JSON. */
function wireBytes(page: RecordingAlignmentPage): number {
  return Buffer.byteLength(JSON.stringify(page, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value));
}

test("the largest page the gateway can send survives the private re-encoding", () => {
  const full = maximalPage();
  let count = full.entries.length;
  while (count > 1 && wireBytes({ ...full, entries: full.entries.slice(0, count) }) > MAX_ALIGNMENT_PAGE_BYTES) count -= 1;
  const page: RecordingAlignmentPage = { ...full, entries: full.entries.slice(0, count) };
  assert.ok(count > 1, "a page of richest frames still carries more than one of them");
  // Measured 2026-09-22: 20 entries, 32 089 wire bytes, 45 231 private bytes,
  // a ratio of 1.41 against the 2x the private bound is derived from.

  const encoded = encodeAlignmentPage(page);
  const bytes = Buffer.byteLength(encoded);
  assert.ok(bytes > MAX_ALIGNMENT_PAGE_BYTES,
    "the private encoding is larger than the wire page, which is why it needs its own bound");
  assert.ok(bytes <= 2 * wireBytes(page),
    `the private encoding is ${bytes} bytes for ${wireBytes(page)} wire bytes, past the 2x the bound is derived from`);
  assert.ok(bytes <= ALIGNMENT_LIMITS.privatePageBytes,
    `private re-encoding of the largest wire page is ${bytes} bytes against the ${ALIGNMENT_LIMITS.privatePageBytes}-byte bound`);
  assert.deepEqual(decodeAlignmentPage(encoded), page);
});

test("the private bound refuses rather than truncates", () => {
  const full = maximalPage();
  assert.ok(wireBytes(full) > MAX_ALIGNMENT_PAGE_BYTES,
    "the grammar's largest page is larger than any page the gateway can send");
  assert.throws(() => encodeAlignmentPage(full), /invalid private alignment page/,
    "a page past the private bound is refused, never cut short");
});
