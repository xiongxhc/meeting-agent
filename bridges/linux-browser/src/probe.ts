/**
 * agent-box standalone Feishu web-client probe: browser meeting discovery
 * and capability failure classification (Task 6, brief bullet 1 only).
 *
 * The Task 6 brief's bullets 2-4 need an isolated agent-box session driving
 * a real Feishu web client -- attempting real authentication, a real join,
 * real audio, and a real reconnect. That is human-gated work; see
 * docs/HUMAN-CHECKLIST.md under "Plan 1 Task 6" for the exact commands.
 * Nothing in this file opens a browser, touches the network, or requires
 * agent-box: every DOM read goes through the injected `PagePort` below, so
 * this module is exercised entirely from recorded, synthetic DOM fixtures
 * in tests. `createPagePortFromFixture` is the reference `PagePort`
 * implementation used by those tests; a real implementation would query the
 * live page's DOM through whatever automation the agent-box session uses --
 * nothing here assumes which one, and this package adds none (see
 * bridges/linux-browser/README.md, "No browser automation").
 *
 * The rule this file exists to hold: a capability the probe never attempted
 * to exercise must classify as `not tested`, and that must never be
 * confused with `unavailable` (attempted, and the control genuinely was not
 * there). Collapsing those two into one value is exactly the failure mode
 * this task exists to prevent -- see `classifyCapability` below, and the
 * "absent (never looked) vs unavailable (looked, absent)" test in
 * probe.test.ts that asserts they read differently for the same capability.
 *
 * What this probe can prove without a real client, and what it cannot: a
 * control being present, visible, and free of an explicit error state in
 * the DOM proves the control is *reachable*. It does not prove the
 * capability behind it actually works end to end -- a microphone meter
 * element existing in the DOM says nothing about whether real audio ever
 * reaches it. That stronger proof needs a human on agent-box with a real
 * meeting; this module only ever produces the DOM-reachability half of the
 * evidence.
 */

import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/** The eight capabilities the Task 6 brief lists, verbatim. */
export type CapabilityId =
  | "authentication_persistence"
  | "meeting_join"
  | "actual_participants"
  | "active_speaker"
  | "microphone_input"
  | "speaker_output"
  | "chat"
  | "reconnect";

export const ALL_CAPABILITIES: readonly CapabilityId[] = [
  "authentication_persistence",
  "meeting_join",
  "actual_participants",
  "active_speaker",
  "microphone_input",
  "speaker_output",
  "chat",
  "reconnect",
];

/**
 * The four legal results, matching the vocabulary already used by
 * `docs/feasibility/feishu-client-matrix.md`. `not tested` is the default
 * for a capability the probe never attempted -- it is never inferred from a
 * failure or an absence, only from an empty attempt log.
 *
 * The words match; the bar behind two of them does not. `proven` here means
 * "every attempt actually made succeeded", which one attempt satisfies. The
 * join-path rows of that matrix use `proven` (and `unreliable`) against a
 * four-consecutive-clean-runs bar. The matrix states the difference in full
 * in its agent-box section, above the capability table; a `proven` produced
 * here is not a claim that the four-run bar was met.
 */
export type CapabilityResult =
  | "proven"
  | "unreliable"
  | "unavailable"
  | "unobservable"
  | "not tested";

/**
 * One observed attempt to exercise a capability's control.
 *   - "control_absent": the probe looked, and the control genuinely was not
 *     present -- a legal, expected finding, never a cue to guess and never
 *     represented any other way.
 *   - "ui_observed" / "ui_error": the probe saw the control state. Neither
 *     proves the underlying capability worked or failed end to end.
 *   - "verified_succeeded" / "verified_failed": capability-specific outcome
 *     evidence from a real exercise, supplied by the human-gated driver.
 */
export type CapabilityAttempt =
  | { readonly capability: CapabilityId; readonly outcome: "control_absent" }
  | { readonly capability: CapabilityId; readonly outcome: "ui_observed" }
  | { readonly capability: CapabilityId; readonly outcome: "ui_error" }
  | { readonly capability: CapabilityId; readonly outcome: "verified_succeeded" }
  | { readonly capability: CapabilityId; readonly outcome: "verified_failed" };

/**
 * Folds every attempt recorded for one capability into exactly one of the
 * four result values.
 *
 *   - No attempts at all -> `not tested`. This is the only path to
 *     `not tested`; nothing below ever produces it from data.
 *   - Every attempt found the control genuinely absent, with no success and
 *     no failure recorded -> `unavailable`.
 *   - DOM-only observations -> `unobservable`: they establish UI reachability,
 *     not capability success. A visible microphone meter or Connected banner
 *     cannot stand in for audio flow or reconnect.
 *   - Every capability-specific outcome succeeded, with no absence or failure
 *     -> `proven`. A verified failure or mixed positive/negative evidence ->
 *     `unreliable`.
 */
export function classifyCapability(attempts: readonly CapabilityAttempt[]): CapabilityResult {
  if (attempts.length === 0) return "not tested";

  const everAbsent = attempts.some((a) => a.outcome === "control_absent");
  const everUiObserved = attempts.some(
    (a) => a.outcome === "ui_observed" || a.outcome === "ui_error",
  );
  const everSucceeded = attempts.some((a) => a.outcome === "verified_succeeded");
  const everFailed = attempts.some((a) => a.outcome === "verified_failed");

  if (everAbsent && !everUiObserved && !everSucceeded && !everFailed) return "unavailable";
  if (!everSucceeded && !everFailed) return "unobservable";
  if (everSucceeded && !everFailed && !everAbsent) return "proven";
  return "unreliable";
}

/**
 * Classifies every capability in `ALL_CAPABILITIES` from a flat attempt
 * log, grouping by `capability` first. A capability with no attempts in the
 * log reads `not tested` in the result -- callers get a complete row for
 * all eight capabilities without having to remember to default the ones
 * they did not exercise themselves.
 */
export function classifyAllCapabilities(
  attempts: readonly CapabilityAttempt[],
): Readonly<Record<CapabilityId, CapabilityResult>> {
  const byCapability = new Map<CapabilityId, CapabilityAttempt[]>();
  for (const id of ALL_CAPABILITIES) byCapability.set(id, []);
  for (const attempt of attempts) {
    byCapability.get(attempt.capability)?.push(attempt);
  }

  const result = {} as Record<CapabilityId, CapabilityResult>;
  for (const id of ALL_CAPABILITIES) {
    result[id] = classifyCapability(byCapability.get(id) ?? []);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Browser meeting discovery
// ---------------------------------------------------------------------------

/** One named DOM control the probe looks for on the Feishu web client page. */
export type ControlName =
  | "meeting_container"
  | "auth_session_badge"
  | "participants_list"
  | "active_speaker_tile"
  | "microphone_meter"
  | "speaker_output_meter"
  | "chat_panel"
  | "reconnect_banner";

/** What one control looked like the instant the page was read. */
export interface DomControlSnapshot {
  readonly visible: boolean;
  /** "error" means the control itself reported a problem (e.g. "message failed to send"), not that the probe failed to read it. */
  readonly state: "ok" | "error";
  readonly text: string | null;
}

/**
 * What the probe can ask of a live (or fake) browser page. A real
 * implementation queries the DOM through whatever automation the isolated
 * agent-box session uses; nothing in this file assumes which one, and
 * nothing here opens a browser or a network connection. Tests inject
 * `createPagePortFromFixture`, built from a recorded DOM fixture.
 */
export interface PagePort {
  /**
   * Looks up one named control. Returns null when the control is not
   * present in the DOM at all -- a legal, expected answer, never an
   * exception, and never a cue to guess.
   */
  findControl(name: ControlName): DomControlSnapshot | null;
}

export type MeetingDiscoveryResult =
  | { readonly status: "in_meeting"; readonly meetingTitle: string | null }
  | { readonly status: "unknown" };

/**
 * Discovers whether the page is currently showing a joined meeting by
 * looking at `meeting_container` alone. A container that is present in the
 * DOM but not visible (some clients keep a collapsed shell mounted between
 * meetings) reads `unknown`. This probe has no positive no-meeting signal, so
 * absence is never promoted to a claim about the meeting state.
 */
export function discoverMeeting(port: PagePort): MeetingDiscoveryResult {
  const container = port.findControl("meeting_container");
  if (container === null || !container.visible) {
    return { status: "unknown" };
  }
  return { status: "in_meeting", meetingTitle: container.text };
}

// ---------------------------------------------------------------------------
// Tying discovery to classification
// ---------------------------------------------------------------------------

/**
 * The one DOM control this probe checks on behalf of each capability. This
 * is deliberately the *only* signal available without a real client and a
 * real meeting: presence, visibility, and the absence of an explicit error
 * state. It proves reachability, not that the capability behind the control
 * actually works -- see the module doc comment.
 */
const CONTROL_FOR_CAPABILITY: Readonly<Record<CapabilityId, ControlName>> = {
  authentication_persistence: "auth_session_badge",
  meeting_join: "meeting_container",
  actual_participants: "participants_list",
  active_speaker: "active_speaker_tile",
  microphone_input: "microphone_meter",
  speaker_output: "speaker_output_meter",
  chat: "chat_panel",
  // Weaker than the other mappings: a visible, ok-state reconnect_banner
  // proves the banner control is reachable and shows current connection
  // status ("Connected"), not that the client actually recovered from a
  // real network drop -- which is what "reconnect" means everywhere else
  // in this plan (see the join-path row of the same name in
  // docs/feasibility/feishu-client-matrix.md). Do not over-read a `proven`
  // result for this capability as evidence of real drop-and-recover
  // behaviour; that needs an actual provoked disconnect on agent-box.
  reconnect: "reconnect_banner",
};

/** Records a DOM observation; only a human-gated driver may add a verified outcome. */
export function attemptCapabilityByControlPresence(
  port: PagePort,
  capability: CapabilityId,
): CapabilityAttempt {
  const control = CONTROL_FOR_CAPABILITY[capability];
  const snapshot = port.findControl(control);
  if (snapshot === null || !snapshot.visible) {
    return { capability, outcome: "control_absent" };
  }
  if (snapshot.state === "error") {
    return { capability, outcome: "ui_error" };
  }
  return { capability, outcome: "ui_observed" };
}

/** One full probe pass: an attempt for every capability in `ALL_CAPABILITIES`, in order. */
export function probeAllCapabilities(port: PagePort): readonly CapabilityAttempt[] {
  return ALL_CAPABILITIES.map((capability) => attemptCapabilityByControlPresence(port, capability));
}

// ---------------------------------------------------------------------------
// Recorded DOM fixtures (test support)
// ---------------------------------------------------------------------------

/**
 * A recorded snapshot of the controls the probe would find on a page at one
 * instant. `controls` lists only the controls that fixture chooses to
 * populate; any `ControlName` missing from it means `findControl` returns
 * null for that name -- the same "not present" answer a real page would
 * give for a control genuinely not in the DOM.
 */
export interface DomFixture {
  readonly capturedAt: string;
  readonly controls: Readonly<Partial<Record<ControlName, DomControlSnapshot>>>;
}

/** Reads and parses a recorded DOM fixture from disk. */
export function loadDomFixture(filePath: string): DomFixture {
  return JSON.parse(readFileSync(filePath, "utf8")) as DomFixture;
}

/** Builds a `PagePort` backed by a fixture's static control table -- no browser, no network. */
export function createPagePortFromFixture(fixture: DomFixture): PagePort {
  return {
    findControl(name) {
      return fixture.controls[name] ?? null;
    },
  };
}
