// Actual attendance: only an observed participant_joined event ever creates
// an actual participant/interval. Invitees, no-shows, host changes, and
// display-name-changed events on their own never do -- matching the schema
// document's "Participants" rule (actual, observed joiners only, enforced
// by requiring at least one observed attendance interval per person).

/** One attendance interval, as produced by the reducer. Carries its own
 * display-name snapshot (the name observed at the time this interval was
 * relevant), because a person's display name can change between a leave and
 * a reconnect. */
export type AttendanceInterval = {
  readonly feishuUserId: string;
  readonly displayName: string;
  readonly joinedAt: string;
  readonly leftAt: string | null;
};

export type ParticipantJoinedEvent = {
  readonly type: "participant_joined";
  readonly feishuUserId: string;
  readonly displayName: string;
  readonly occurredAt: string;
  readonly occurredAtMs?: number;
  readonly sequence?: number;
  readonly bridgeSessionId?: string;
};

export type ParticipantLeftEvent = {
  readonly type: "participant_left";
  readonly feishuUserId: string;
  readonly occurredAt: string;
  readonly occurredAtMs?: number;
  readonly sequence?: number;
  readonly bridgeSessionId?: string;
};

/** An invitation, never itself observed attendance. */
export type ParticipantInvitedEvent = {
  readonly type: "participant_invited";
  readonly feishuUserId: string;
  readonly displayName: string;
};

/** A host/co-host change. Never creates or alters a participant on its own;
 * the reducer only tracks it to prove it has no effect on attendance. */
export type HostChangedEvent = {
  readonly type: "host_changed";
  readonly feishuUserId: string;
  readonly occurredAt: string;
};

export type ParticipantDisplayNameChangedEvent = {
  readonly type: "participant_display_name_changed";
  readonly feishuUserId: string;
  readonly displayName: string;
  readonly occurredAt: string;
};

export type MeetingLifecycleEvent =
  | ParticipantJoinedEvent
  | ParticipantLeftEvent
  | ParticipantInvitedEvent
  | HostChangedEvent
  | ParticipantDisplayNameChangedEvent;

type OpenInterval = {
  displayName: string;
  joinedAt: string;
};

/**
 * Reduces a meeting's raw lifecycle events into actual attendance intervals.
 * Only `participant_joined` opens an interval; every other event type can at
 * most update or close an interval that a join already opened, and can never
 * create one on its own.
 *
 * Events are sorted into chronological order per person before processing,
 * so callers may hand in events in any order (including genuinely
 * out-of-order delivery). A `participant_joined` that arrives while an
 * interval is already open for that person is treated as a duplicate/replay
 * of the same join (its display name still updates the open interval) rather
 * than starting a second interval; only a `participant_left` closes an
 * interval, after which a later join starts a new one -- so a reconnect
 * (leave, then rejoin) always produces two separate intervals, never one
 * merged span, because nobody observed the person as present in the gap
 * between them.
 */
export function reduceAttendance(events: readonly MeetingLifecycleEvent[]): AttendanceInterval[] {
  const byUser = new Map<string, MeetingLifecycleEvent[]>();
  for (const event of events) {
    const list = byUser.get(event.feishuUserId);
    if (list) {
      list.push(event);
    } else {
      byUser.set(event.feishuUserId, [event]);
    }
  }

  const intervals: AttendanceInterval[] = [];

  for (const [feishuUserId, userEvents] of byUser) {
    const ordered = [...userEvents].sort((a, b) => timeKey(a) - timeKey(b)
      || sequenceKey(a) - sequenceKey(b)
      || bridgeKey(a).localeCompare(bridgeKey(b)));

    let open: OpenInterval | null = null;

    for (const event of ordered) {
      switch (event.type) {
        case "participant_joined": {
          if (open === null) {
            open = { displayName: event.displayName, joinedAt: event.occurredAt };
          } else {
            // Duplicate or replayed join while already present: keep the
            // original joinedAt, but the display name may have refreshed.
            open.displayName = event.displayName;
          }
          break;
        }
        case "participant_display_name_changed": {
          if (open !== null) {
            open.displayName = event.displayName;
          }
          break;
        }
        case "participant_left": {
          if (open !== null) {
            intervals.push({
              feishuUserId,
              displayName: open.displayName,
              joinedAt: open.joinedAt,
              leftAt: event.occurredAt,
            });
            open = null;
          }
          break;
        }
        case "participant_invited":
        case "host_changed":
          // Never creates, closes, or otherwise alters an interval.
          break;
      }
    }

    if (open !== null) {
      intervals.push({
        feishuUserId,
        displayName: open.displayName,
        joinedAt: open.joinedAt,
        leftAt: null,
      });
    }
  }

  intervals.sort((a, b) => {
    const byTime = Date.parse(a.joinedAt) - Date.parse(b.joinedAt);
    return byTime !== 0 ? byTime : a.feishuUserId.localeCompare(b.feishuUserId);
  });

  return intervals;
}

/** The instant used to order a person's events chronologically. Events with
 * no occurredAt (participant_invited) never open or close an interval, so
 * their relative order among themselves never matters; they sort by an
 * empty key, which is stable and harmless. */
function timeKey(event: MeetingLifecycleEvent): number {
  return "occurredAt" in event
    ? (("occurredAtMs" in event ? event.occurredAtMs : undefined) ?? Date.parse(event.occurredAt))
    : Number.NEGATIVE_INFINITY;
}

function sequenceKey(event: MeetingLifecycleEvent): number {
  return "sequence" in event ? (event.sequence ?? 0) : 0;
}

function bridgeKey(event: MeetingLifecycleEvent): string {
  return "bridgeSessionId" in event ? (event.bridgeSessionId ?? "") : "";
}
