# Linux browser probe (spike)

The agent-box half of the Feishu feasibility spike: it reads a Feishu web
client's DOM through an injected port, decides whether a meeting is discoverable,
and classifies each of the eight capabilities the Task 6 brief lists into one of
`proven`, `unreliable`, `unavailable`, `unobservable`, `not tested`.

**Nothing here has been run against a real Feishu web client.** No browser is
opened, no network call is made, and agent-box has never been touched from this
repository. Every test drives synthetic DOM fixtures from
`test/fixtures/dom/`. Running the real probe is a human-gated step: see
`docs/HUMAN-CHECKLIST.md`, section Plan 1 Task 6.

## Layout

```
src/probe.ts              capability classification + meeting discovery
test/probe.test.ts        the rules, against recorded synthetic DOM
test/fixtures/dom/*.json  the synthetic DOM snapshots those tests read
```

## The rules this package exists to hold

- **`not tested`, `unobservable`, and `unavailable` are different findings.**
  `not tested` comes only from an empty attempt log. A missing DOM control is
  `ui_unobserved` and therefore `unobservable`; `unavailable` requires a
  capability-specific `verified_unavailable` outcome from the human-gated
  driver.
- **A control that was always reachable but never worked is `unreliable`, not
  `unavailable`.** It was never missing, and whoever reads the matrix next needs
  that distinction.
- **DOM reachability is not end-to-end proof.** A visible control produces
  `ui_observed`, which classifies as `unobservable`; a capability reaches
  `proven` only after a human-gated driver supplies a capability-specific
  `verified_succeeded` outcome. A missing or hidden meeting container is
  `unknown`, never a positive `not_in_meeting` claim.
- **`proven` here has no run-count floor.** One successful attempt satisfies it,
  because the Task 6 brief states no run count. The join-path rows in
  `docs/feasibility/feishu-client-matrix.md` use the same word against a
  four-consecutive-clean-runs bar; that file's agent-box section says so in
  full.

## No browser automation

This package adds no dependency, and deliberately no browser-automation one.
Nothing here opens a browser: every DOM read goes through the `PagePort`
interface, and the only implementation in the repository reads a recorded
fixture. A driver that talks to a live page is part of the human-gated agent-box
work, written against that same interface, so the classification logic it feeds
is already unit-tested by the time a real page reaches it. Adding an automation
dependency now would ship a dependency with no caller.

## Tests

```
npm test        # from the repo root; runs this package's tests with the rest
```
