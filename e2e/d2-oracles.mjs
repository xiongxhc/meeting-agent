// Pure test evidence checks; synthetic helper tests are not integration proof.
export function d2OrderingOracles(live) {
  const { cut, events, runtimeEvents, childState } = live, checks = [];
  const requireFact = (value, reason) => { if (!value) throw new Error(reason); };
  const check = (name, work) => {
    try { checks.push({ name, status: "pass", detail: work() }); }
    catch (error) { checks.push({ name, status: "fail", detail: String(error?.message ?? error) }); }
  };
  const boundTurn = (ordered) => {
    const stories = events.filter(row => row.name === "transcript_tested" && row.testName === "story");
    requireFact(ordered && stories.length === 1 && stories[0].authorized && stories[0].turn === ordered.turn &&
      ordered.generation === ordered.turn, "missing or mismatched held story identity");
    const story = stories[0];
    requireFact(ordered.segment === undefined || ordered.segment === story.segment, "ordering segment differs from held story");
    const transcripts = runtimeEvents.filter(row => row.type === "voice_transcript_final" && row.segment_id === story.segment);
    const decisions = runtimeEvents.filter(row => ["response_authorized", "response_skipped"].includes(row.type) && row.segment_id === story.segment);
    requireFact(transcripts.length === 1 && typeof transcripts[0].session_id === "string" &&
      decisions.length === 1 && decisions[0].type === "response_authorized" && decisions[0].session_id === transcripts[0].session_id &&
      decisions[0].turn_id === story.turn, "held story transcript/authorization Runtime session mismatch");
    const session = transcripts[0].session_id;
    const barriers = events.filter(row => row.name === "held_playback_accepted");
    requireFact(barriers.length === 1 && barriers[0].sessionId === session && barriers[0].turn === story.turn &&
      barriers[0].segment === story.segment && barriers[0].generation === ordered.generation &&
      childState.playback.some(row => row.held && row.sequence === barriers[0].sequence && row.generation === ordered.generation && row.turn === story.turn),
    "missing or mismatched held playback acceptance barrier");
    const barrier = barriers[0];
    const accepted = runtimeEvents.filter(row => row.type === "voice_playback" && row.state === "accepted" &&
      row.session_id === session && row.generation_id === ordered.generation && row.monotonicNs === barrier.acceptedMonotonicNs);
    requireFact(accepted.length === 1 && runtimeEvents.indexOf(accepted[0]) > runtimeEvents.indexOf(decisions[0]) &&
      BigInt(accepted[0].monotonicNs) >= BigInt(decisions[0].monotonicNs),
      "held generation lacks actual Runtime acceptance after authorization");
    const actionNs = cut === "repeated-close" ? BigInt(ordered.monotonicNs) : cut === "complete-wins"
      ? ordered.rendered.map(row => BigInt(row.monotonicNs)).reduce((a, b) => a < b ? a : b)
      : BigInt(ordered.activityMonotonicNs);
    requireFact(BigInt(accepted[0].monotonicNs) <= BigInt(barrier.monotonicNs) && BigInt(barrier.monotonicNs) < actionNs,
      "ordering action preceded held Runtime acceptance barrier");
    const terminals = runtimeEvents.filter(row => ["turn_completed", "turn_cancelled", "turn_failed"].includes(row.event?.type) && row.event.turn_id === story.turn);
    requireFact(terminals.length === 1 && terminals[0].session_id === session && terminals[0].generation_id === ordered.generation,
      "held story terminal missing, duplicated or bound to another session/generation");
    const terminal = terminals[0];
    requireFact(runtimeEvents.indexOf(terminal) > runtimeEvents.indexOf(accepted[0]) && actionNs <= BigInt(terminal.monotonicNs),
      "held terminal preceded acceptance or ordering action");
    requireFact((cut === "complete-wins" || !runtimeEvents.some(row => row.type === "voice_playback" && row.session_id === session &&
      row.generation_id === ordered.generation && ["accepted", "rendered"].includes(row.state) && BigInt(row.monotonicNs) > BigInt(terminal.monotonicNs)) &&
      !childState.playback.some(row => row.generation === ordered.generation && row.afterFlush)), "held generation output continued after termination");
    return { session, terminal };
  };
  if (cut === "repeated-close") {
    check("repeated_close_turn_terminal", () => {
      const started = events.find(row => row.name === "repeated_close_started");
      const { session, terminal } = boundTurn(started);
      const closed = events.find(row => row.name === "repeated_close");
      requireFact(started.startedWhileHeld && closed?.outcomes.some(row => row.controlSessionId === session),
        "held turn differs from actual closed Runtime owner");
      return `${terminal.event.type} is the sole held-turn terminal through final teardown; same Runtime session/generation`;
    });
    check("repeated_owner_close", () => {
      const closed = events.find(row => row.name === "repeated_close"), released = events.find(row => row.name === "owner_lock_released");
      requireFact(closed?.concurrentPromiseSame && closed.settledPromiseSame && closed.startedWhileHeld &&
        closed.results.length === 3 && closed.outcomes.length > 0 && closed.outcomes.every(row => row.phase === "settled" && row.runtimeClose === "closed"),
      "repeated close did not settle the same actual owner Promise/runtime");
      const codes = live.summary.trace.filter(code => code.startsWith("shutdown_"));
      requireFact(JSON.stringify(codes) === JSON.stringify(["shutdown_fenced", "shutdown_owned_work_settled", "shutdown_application_closed",
        "shutdown_runtime_owners_closed", "shutdown_transports_closed", "shutdown_store_closed"]) && released?.released && released.afterStoreClosed,
      "shutdown close order, single store close or lock release missing");
      const fulfilled = closed.results.every(row => row.status === "fulfilled");
      const refused = closed.results.every(row => row.status === "rejected" && /^composition_close_failed:/.test(row.reason) && row.reason === closed.results[0].reason);
      requireFact(live.summary.driveFailure === null && ((fulfilled && live.outcome.code === 0) || (refused && live.outcome.code === 70)),
        "entry exit does not match actual close disposition");
      if (refused) requireFact(closed.outcomes.every(outcome => live.reopen.rows.custody.some(row =>
        row.occurrence_id === outcome.occurrenceId && row.state === "quarantined")), "unclean physical close lacks durable quarantine");
      return `same Promise for concurrent/settled close; ${fulfilled ? "clean" : "explicit unconfirmed-close refusal/quarantine"}; ordered store closure and lock reacquired`;
    });
    return checks;
  }
  const name = cut === "complete-wins" ? "completion_ordered" : "interruption_acknowledged";
  const ordered = events.find(row => row.name === name);
  check(cut === "complete-wins" ? "completion_wins_terminal" : "cancellation_wins_terminal", () => {
    const { session, terminal } = boundTurn(ordered);
    const expected = cut === "complete-wins" ? "turn_completed" : "turn_cancelled";
    requireFact(terminal.event.type === expected, "wrong actual terminal winner");
    if (cut === "complete-wins") {
      const activities = runtimeEvents.filter(row => row.type === "voice_activity" && row.session_id === session &&
        row.activity?.type === "speech_started" && row.monotonicNs === ordered.runtimeLateActivityMonotonicNs);
      requireFact(activities.length === 1 && runtimeEvents.indexOf(activities[0]) > runtimeEvents.indexOf(terminal) &&
        BigInt(activities[0].monotonicNs) >= BigInt(ordered.lateActivityMonotonicNs),
      "late provider onset was not observed by the bound Runtime session after completion");
      requireFact(BigInt(terminal.monotonicNs) <= BigInt(ordered.lateActivityMonotonicNs) &&
        ordered.rendered.length > 0 && ordered.rendered.every(row => row.status === "rendered" && row.generation === ordered.generation &&
          BigInt(row.monotonicNs) <= BigInt(terminal.monotonicNs)), "late onset or observed Rendered release preceded completion incorrectly");
      requireFact(!runtimeEvents.some(row => row.type === "voice_barge_in" && row.session_id === session && row.generation_id === ordered.generation) &&
        !childState.flushes.some(row => row.generation === ordered.generation), "completed generation retroactively interrupted");
    } else {
      const barge = runtimeEvents.findIndex(row => row.type === "voice_barge_in" && row.session_id === session && row.turn_id === ordered.turn && row.generation_id === ordered.generation);
      const ack = runtimeEvents.findIndex(row => row.type === "voice_timing" && row.session_id === session && row.turn_id === ordered.turn && row.milestone === "playback_flush_acknowledged");
      requireFact(barge >= 0 && ack > barge && runtimeEvents.indexOf(terminal) > ack &&
        childState.flushes.filter(row => row.generation === ordered.generation).length === 1 &&
        !childState.playback.some(row => row.generation === ordered.generation && row.afterFlush), "actual barge/flush/terminal chain missing or reordered");
    }
    return `${expected} is the sole terminal for actual turn ${ordered.turn}, generation ${ordered.generation}`;
  });
  if (cut === "cancel-wins" || cut === "complete-wins") check("late_renderer_callback_fenced", () => {
    requireFact(ordered?.renderCallbacks.length > 0 && ordered.renderCallbacks.every(row => row.generation === ordered.generation &&
      row.status === (cut === "cancel-wins" ? "suppressed_flushed" : "suppressed_duplicate") &&
      childState.playback.some(frame => frame.sequence === row.sequence && frame.generation === row.generation && frame.held)),
    "late or duplicate observed renderer callback wrote invalid ACK");
    return "observed peer callback suppressed; this does not claim Swift renderer behavior";
  });
  if (cut !== "complete-wins") check("scripted_monotonic_flush_interval", () => {
    requireFact(ordered?.activityMonotonicNs && ordered?.flushMonotonicNs, "missing scripted monotonic endpoints");
    const elapsed = BigInt(ordered.flushMonotonicNs) - BigInt(ordered.activityMonotonicNs);
    requireFact(elapsed >= 0n, "invalid monotonic scripted interval");
    return `${Number(elapsed) / 1_000_000} ms, provider onset send to peer ACK write callback on this host; no physical latency claim`;
  });
  return checks;
}
