import { deepStrictEqual, strictEqual } from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import {
  ALL_CAPABILITIES,
  attemptCapabilityByControlPresence,
  classifyAllCapabilities,
  classifyCapability,
  createPagePortFromFixture,
  discoverMeeting,
  loadDomFixture,
  probeAllCapabilities,
} from "../src/probe.ts";
import type { CapabilityAttempt } from "../src/probe.ts";

const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures/dom");

function fixturePath(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

// ---------------------------------------------------------------------------
// Failure classification: the four-way result and, above all, the rule that
// "not tested" (never looked) and "unavailable" (looked, genuinely absent)
// must never collapse into one value.
// ---------------------------------------------------------------------------

test("classifyCapability: zero attempts is not tested, never guessed as anything else", () => {
  strictEqual(classifyCapability([]), "not tested");
});

test("classifyCapability: a control the probe looked for and never found is unavailable", () => {
  const attempts: CapabilityAttempt[] = [{ capability: "chat", outcome: "control_absent" }];
  strictEqual(classifyCapability(attempts), "unavailable");
});

test("classifyCapability: absent (never looked) and unavailable (looked, absent) are different results for the same capability", () => {
  // The failure mode this task exists to prevent: collapsing "never looked"
  // and "looked, genuinely absent" into the same value. Same capability
  // (chat), two different attempt logs, and the two results below must read
  // differently even though both describe a capability with no working
  // evidence -- asserted against each vocabulary word by name, not just
  // against each other, so a future typo in either literal still fails loud.
  const neverLooked = classifyCapability([]);
  const lookedAndAbsent = classifyCapability([{ capability: "chat", outcome: "control_absent" }]);
  strictEqual(neverLooked, "not tested");
  strictEqual(lookedAndAbsent, "unavailable");
});

test("classifyCapability: every attempt succeeding is proven", () => {
  const attempts: CapabilityAttempt[] = [
    { capability: "reconnect", outcome: "succeeded" },
    { capability: "reconnect", outcome: "succeeded" },
  ];
  strictEqual(classifyCapability(attempts), "proven");
});

test("classifyCapability: a mix of succeeded and failed attempts is unreliable", () => {
  const attempts: CapabilityAttempt[] = [
    { capability: "active_speaker", outcome: "succeeded" },
    { capability: "active_speaker", outcome: "failed" },
  ];
  strictEqual(classifyCapability(attempts), "unreliable");
});

test("classifyCapability: a mix of succeeded and control_absent attempts is unreliable, not proven and not unavailable", () => {
  const attempts: CapabilityAttempt[] = [
    { capability: "actual_participants", outcome: "succeeded" },
    { capability: "actual_participants", outcome: "control_absent" },
  ];
  strictEqual(classifyCapability(attempts), "unreliable");
});

test("classifyCapability: every attempt failing, with the control always reachable, is unreliable rather than unavailable", () => {
  // "unavailable" is reserved for a control that could not be reached at
  // all. A control that was reachable every time but never once produced a
  // correct result did not prove out, but it was never simply missing
  // either -- that distinction matters to whoever reads this table next.
  const attempts: CapabilityAttempt[] = [
    { capability: "microphone_input", outcome: "failed" },
    { capability: "microphone_input", outcome: "failed" },
  ];
  strictEqual(classifyCapability(attempts), "unreliable");
});

test("classifyAllCapabilities: a capability absent from the attempt log defaults to not tested", () => {
  const result = classifyAllCapabilities([{ capability: "chat", outcome: "succeeded" }]);
  strictEqual(result.chat, "proven");
  strictEqual(result.meeting_join, "not tested");
  strictEqual(result.reconnect, "not tested");
});

test("classifyAllCapabilities: covers every capability the brief lists, none silently dropped", () => {
  const result = classifyAllCapabilities([]);
  deepStrictEqual(Object.keys(result).sort(), [...ALL_CAPABILITIES].sort());
  for (const capability of ALL_CAPABILITIES) {
    strictEqual(result[capability], "not tested");
  }
});

// ---------------------------------------------------------------------------
// Browser meeting discovery, over recorded DOM fixtures. No browser, no
// network -- every fixture is a hand-authored, synthetic snapshot of the
// controls the probe would look for.
// ---------------------------------------------------------------------------

test("discoverMeeting: a visible meeting container is an in-meeting discovery", () => {
  const fixture = loadDomFixture(fixturePath("joined-meeting.json"));
  const port = createPagePortFromFixture(fixture);
  deepStrictEqual(discoverMeeting(port), {
    status: "in_meeting",
    meetingTitle: "Test Meeting Room",
  });
});

test("discoverMeeting: no meeting container in the DOM at all is not in a meeting", () => {
  const fixture = loadDomFixture(fixturePath("not-in-meeting.json"));
  const port = createPagePortFromFixture(fixture);
  deepStrictEqual(discoverMeeting(port), { status: "not_in_meeting" });
});

test("discoverMeeting: a meeting container present but not visible is not in a meeting, never guessed from stale DOM", () => {
  const fixture = loadDomFixture(fixturePath("meeting-container-hidden.json"));
  const port = createPagePortFromFixture(fixture);
  deepStrictEqual(discoverMeeting(port), { status: "not_in_meeting" });
});

// ---------------------------------------------------------------------------
// Tying discovery to classification: one full probe pass over a fixture,
// classified per capability.
// ---------------------------------------------------------------------------

test("attemptCapabilityByControlPresence: a control missing from the fixture is control_absent, not a thrown error", () => {
  const fixture = loadDomFixture(fixturePath("not-in-meeting.json"));
  const port = createPagePortFromFixture(fixture);
  deepStrictEqual(attemptCapabilityByControlPresence(port, "chat"), {
    capability: "chat",
    outcome: "control_absent",
  });
});

test("probeAllCapabilities: a fully populated fixture yields a succeeded attempt for every capability, classifying proven throughout", () => {
  const fixture = loadDomFixture(fixturePath("joined-meeting.json"));
  const port = createPagePortFromFixture(fixture);
  const attempts = probeAllCapabilities(port);
  const results = classifyAllCapabilities(attempts);
  for (const capability of ALL_CAPABILITIES) {
    strictEqual(results[capability], "proven", `expected ${capability} to be proven`);
  }
});

test("probeAllCapabilities: a fixture mixing absent, error, and ok controls classifies each capability independently", () => {
  const fixture = loadDomFixture(fixturePath("control-error-state.json"));
  const port = createPagePortFromFixture(fixture);
  const results = classifyAllCapabilities(probeAllCapabilities(port));

  // microphone_meter is absent from this fixture on purpose.
  strictEqual(results.microphone_input, "unavailable");
  // chat_panel is present but reports state "error" on purpose.
  strictEqual(results.chat, "unreliable");
  // everything else in this fixture is present and ok.
  strictEqual(results.authentication_persistence, "proven");
  strictEqual(results.meeting_join, "proven");
  strictEqual(results.actual_participants, "proven");
  strictEqual(results.active_speaker, "proven");
  strictEqual(results.speaker_output, "proven");
  strictEqual(results.reconnect, "proven");
});
