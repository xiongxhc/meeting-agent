// One stop owner shared by scripted end observation and stdin EOF. The media
// core owns the absolute finish deadline, byte decoder and transport cleanup.
export function createCaptureLifecycle({ getMedia, fenceCapture, getCaptureWork, emit, participants = [],
  onOutcome = () => {}, getConnectionWork = () => Promise.resolve(), abortConnection = () => {}, timeoutMs = 20000 }) {
  let stopPromise = null, observation = null, terminal = false;
  const owner = {
    get stopping() { return stopPromise !== null; },
    get observation() { return observation; },
    observeEnd(value) {
      if (!terminal && observation === null) observation = globalThis.structuredClone(value);
      return owner.stop();
    },
    stop() {
      if (stopPromise) return stopPromise;
      fenceCapture();
      abortConnection();
      stopPromise = (async () => {
        await getConnectionWork().catch(() => {});
        const media = getMedia();
        const captureDrain = media === null
          ? { drain: "unconfirmed", reason: "media_unavailable", boundary: null }
          : await media.finishCapture({ timeoutMs, captureWork: getCaptureWork() });
        onOutcome({ captureDrain, captureFinish: media?.finishEvidence ?? null });
        emit({ type: "media_disconnected", reason: "media_stopped", captureDrain });
        if (observation !== null) {
          for (const participant of participants) emit({ type: "participant_left", feishuUserId: participant.feishuUserId,
            observedAt: observation.observedAt, observationTiming: observation.observationTiming,
            observationTimingReason: observation.observationTimingReason });
          emit({ type: "left", ...observation });
        }
        terminal = true;
        return captureDrain;
      })();
      return stopPromise;
    },
  };
  return owner;
}
