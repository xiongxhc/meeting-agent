import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { canonicalArtifactHash, parseTeamMemMeetingArtifact } from "../src/contracts/teammem-meeting-v1.ts";
import { parseSupportedTeamMemMeetingArtifact, parseTeamMemMeetingArtifactV2 } from "../src/contracts/teammem-meeting-v2.ts";

const fixture = (name: "minimal" | "overlap") => JSON.parse(readFileSync(new URL(`fixtures/meetings/teammem-meeting-v2.${name}.json`, import.meta.url), "utf8"));

test("shared v2 bytes validate with literal canonical hashes while frozen v1 refuses overlap", () => {
  const minimal = parseTeamMemMeetingArtifactV2(fixture("minimal"));
  const overlap = parseSupportedTeamMemMeetingArtifact(fixture("overlap"));
  assert.equal(minimal.schema, "teammem-meeting/v2");
  assert.equal(overlap.schema, "teammem-meeting/v2");
  assert.equal(canonicalArtifactHash(minimal), "sha256:e243b84f155324483fabb4d88bf07af2beab6639c0c2555fecfe082a6126a7cc");
  assert.equal(canonicalArtifactHash(overlap), "sha256:4efa7b78605d8c0a60a5515adda74181071079ab2bdebbfec69662a334cda9fa");
  assert.equal(overlap.transcript.length, 7);
  assert.deepEqual(overlap.decisions[0]?.evidence_segment_ids, ["obs-live", "obs-final", "obs-partial"]);
  assert.throws(() => parseTeamMemMeetingArtifact({ ...overlap, schema: "teammem-meeting/v1" }), /non-overlapping/);
});

test("v2 sorts equal microsecond instants by ordinal ASCII id and refuses reversed tuples", () => {
  const artifact = fixture("minimal");
  const entry = artifact.transcript[0];
  artifact.transcript = [
    { ...entry, segment_id: "A", started_at: "2026-09-02T09:15:10.1Z", ended_at: "2026-09-02T09:15:10.20Z" },
    { ...entry, segment_id: "a", started_at: "2026-09-02T09:15:10.100000Z", ended_at: "2026-09-02T09:15:10.200000Z" },
  ];
  assert.deepEqual(parseTeamMemMeetingArtifactV2(artifact).transcript.map(({ segment_id }) => segment_id), ["A", "a"]);
  assert.throws(() => parseTeamMemMeetingArtifactV2({ ...artifact, transcript: [...artifact.transcript].reverse() }), /ordered/);
  assert.throws(() => parseTeamMemMeetingArtifactV2({ ...artifact, transcript: [
    { ...entry, segment_id: "A", started_at: "2026-09-02T09:15:10.1Z", ended_at: "2026-09-02T09:15:10.3Z" },
    { ...entry, segment_id: "a", started_at: "2026-09-02T09:15:10.100000Z", ended_at: "2026-09-02T09:15:10.2Z" },
  ] }), /ordered/);
  assert.throws(() => parseTeamMemMeetingArtifactV2({ ...artifact, transcript: [{ ...entry, segment_id: "é" }] }), /segment_id/);
  assert.throws(() => parseTeamMemMeetingArtifactV2({ ...artifact, transcript: [{ ...entry, segment_id: "A" }, { ...entry, segment_id: "A" }] }), /unique/);
});

test("v2 retains nested, partial, touching and zero-duration intervals but refuses malformed boundaries", () => {
  const artifact = fixture("overlap");
  assert.doesNotThrow(() => parseTeamMemMeetingArtifactV2(artifact));
  const entry = artifact.transcript[0];
  const invalid = [
    { ...entry, ended_at: "2026-09-02T09:15:09Z" },
    { ...entry, started_at: "2026-09-02T09:14:59Z" },
    { ...entry, speaker: { kind: "person", person_id: "missing", display_name: "Missing", reconciled: true } },
    { ...entry, provenance: { stage: "unknown", model: "x" } },
    { ...entry, extra: true },
  ];
  for (const changed of invalid) assert.throws(() => parseTeamMemMeetingArtifactV2({ ...artifact, transcript: [changed] }));
  assert.throws(() => parseTeamMemMeetingArtifactV2({ ...artifact, decisions: [{ text: "Unsupported", evidence_segment_ids: ["missing"] }] }), /evidence_segment_ids/);
  assert.throws(() => parseSupportedTeamMemMeetingArtifact({ ...artifact, schema: "teammem-meeting/v3" }), /schema|version/);
});
