import { z } from "zod";

import { meetingArtifactBase, parseTeamMemMeetingArtifact, transcriptSegment, validateRelationships, type TeamMemMeetingArtifact } from "./teammem-meeting-v1.ts";

export type TeamMemMeetingArtifactV2 = Omit<TeamMemMeetingArtifact, "schema"> & { schema: "teammem-meeting/v2" };
export type SupportedTeamMemMeetingArtifact = TeamMemMeetingArtifact | TeamMemMeetingArtifactV2;

const artifactV2 = meetingArtifactBase.extend({
  schema: z.literal("teammem-meeting/v2"),
  transcript: z.array(transcriptSegment.extend({ segment_id: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/) })).max(50_000),
});

export function parseTeamMemMeetingArtifactV2(value: unknown): TeamMemMeetingArtifactV2 {
  const artifact = artifactV2.parse(value);
  validateRelationships(artifact);
  return artifact;
}

export function parseSupportedTeamMemMeetingArtifact(value: unknown): SupportedTeamMemMeetingArtifact {
  if (typeof value !== "object" || value === null || !("schema" in value)) throw new Error("meeting artifact schema is unavailable");
  switch (value.schema) {
    case "teammem-meeting/v1": return parseTeamMemMeetingArtifact(value);
    case "teammem-meeting/v2": return parseTeamMemMeetingArtifactV2(value);
    default: throw new Error("unsupported meeting artifact schema version");
  }
}
