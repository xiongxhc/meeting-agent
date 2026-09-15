import process from "node:process";
import { openSessionStore } from "../../src/adapters/sqlite-session-store.ts";

const [filename, generationId, phase] = process.argv.slice(2);
if (!filename || !generationId || !["before-page", "after-page", "after-terminal"].includes(phase ?? "")) process.exit(2);
const store = openSessionStore({ filename });
const selected = store.getSelectedAlignment(generationId);
if (!selected) process.exit(2);
const page = store.readSelectedAlignmentPage(selected, -1);
if (!page) process.exit(2);
const result = store.beginRecordingAlignment(generationId, `owned-child-${process.pid}`, true);
if (result.kind !== "claimed") process.exit(2);
if (phase !== "before-page") store.appendRecordingAlignment(result.attempt, page);
if (phase === "after-terminal") store.completeRecordingAlignment(result.attempt, {
  type: "recording_alignment_complete", source: page.source, pageCount: 1n,
  coverageStatus: "available", warnings: [], traversalSucceeded: true,
});
process.send?.({ phase, attempt: result.attempt });
// Deliberately interrupted only by the owning parent. No lease/clock is proof.
setInterval(() => {}, 1000);
