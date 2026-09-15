// Copied to an independently installed temp consumer and checked with tsc.
import { createConversationRuntimeClient, RecordingAlignmentOwner, openSessionStore } from "meeting-agent";
import type { RuntimeClient, FinalizedRecordingCapability, RecordingAlignmentPage } from "@conversation/runtime";

declare const sdk: RuntimeClient<4>;
const runtime = createConversationRuntimeClient(sdk);
const finalized = await runtime.finalizeRecording({ sessionId: 41n });
const capability: FinalizedRecordingCapability | undefined = finalized.recoveryCapability;
if (capability) {
  for await (const item of runtime.readRecordingAlignment({ capability })) {
    if (item.type === "recording_alignment_page") { const page: RecordingAlignmentPage = item; void page; }
  }
}
const owner = new RecordingAlignmentOwner({ store: openSessionStore({ filename: "/private/operator-selected-state.db" }), runtime: sdk });
void owner;
