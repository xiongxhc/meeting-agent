// Copied to an independently installed temp consumer and checked with tsc.
import { createConversationRuntimeClient, RecordingAlignmentOwner, openSessionStore, connectPostmeetingRuntime,
  reconcilePersistedTimedSpeakers, buildTimedTeamMemMeetingArtifact, buildTimedTeamMemMeetingArtifactV2,
  parseTeamMemMeetingArtifactV2, parseSupportedTeamMemMeetingArtifact,
  type TeamMemMeetingArtifactV2, type SupportedTeamMemMeetingArtifact,
  type TimedArtifactBuildInput, type TimedReconciledTranscript } from "meeting-agent";
import type { RuntimeClient, RuntimeTransport, FinalizedRecordingCapability, RecordingAlignmentPage, FinalizedRecordingReconciliation } from "@conversation/runtime";

declare const sdk: RuntimeClient<4>;
const runtime = createConversationRuntimeClient(sdk);
const finalized = await runtime.finalizeRecording({ sessionId: 41n });
const capability: FinalizedRecordingCapability | undefined = finalized.recoveryCapability;
if (capability) {
  const final: FinalizedRecordingReconciliation = await runtime.reconcileFinalizedRecording({ capability }); void final;
  for await (const item of runtime.readRecordingAlignment({ capability })) {
    if (item.type === "recording_alignment_page") { const page: RecordingAlignmentPage = item; void page; }
  }
}
const owner = new RecordingAlignmentOwner({ store: openSessionStore({ filename: "/private/operator-selected-state.db" }), runtime: sdk });
void owner;
declare const transport: RuntimeTransport;
declare const buildInput: TimedArtifactBuildInput;
const connected = await connectPostmeetingRuntime(transport);
if (capability) {
  const final: FinalizedRecordingReconciliation = await connected.reconcileFinalizedRecording({ capability }); void final;
  const transcript: TimedReconciledTranscript = await reconcilePersistedTimedSpeakers({ occurrenceId: "operator-selected-occurrence",
    bridgeSessionId: "operator-selected-bridge", recordingHandle: capability.recordingHandle,
    store: openSessionStore({ filename: "/private/operator-selected-state.db" }), runtime: connected, nowMs: () => Date.now() });
  await buildTimedTeamMemMeetingArtifact({ ...buildInput, transcript });
  const v2: TeamMemMeetingArtifactV2 = (await buildTimedTeamMemMeetingArtifactV2({ ...buildInput, transcript })).artifact;
  const supported: SupportedTeamMemMeetingArtifact = parseSupportedTeamMemMeetingArtifact(v2);
  const parsed: TeamMemMeetingArtifactV2 = parseTeamMemMeetingArtifactV2(supported); void parsed;
}
