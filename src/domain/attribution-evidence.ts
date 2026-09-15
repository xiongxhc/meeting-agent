declare const ownedUiExactMsBrand: unique symbol;

export type OwnedUiExactMs = Readonly<Record<string, number>> & {
  readonly [ownedUiExactMsBrand]: true;
};

type UiExactMsEntry = readonly [string, number];
type UiExactMsSnapshot = readonly UiExactMsEntry[];

const snapshots = new WeakMap<object, UiExactMsSnapshot>();

export function createOwnedUiExactMs(
  entries: readonly UiExactMsEntry[],
): OwnedUiExactMs {
  const keys = new Set<string>();
  const record: Record<string, number> = {};
  const snapshot: UiExactMsEntry[] = [];
  for (const [key, value] of entries) {
    if (keys.has(key)) throw new Error("duplicate attribution evidence key");
    keys.add(key);
    Object.defineProperty(record, key, {
      value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    snapshot.push(Object.freeze([key, value] as const));
  }
  const owned = Object.freeze(record) as OwnedUiExactMs;
  snapshots.set(owned, Object.freeze(snapshot));
  return owned;
}

export function getOwnedUiExactMsSnapshot(value: unknown): UiExactMsSnapshot | null {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return null;
  return snapshots.get(value) ?? null;
}

declare const ownedTimedSampleBrand: unique symbol;
export type TimedSampleSnapshot = {
  readonly sampleRateHz: number;
  readonly possibleSamples: bigint;
  readonly candidateLower: readonly (readonly [string, bigint])[];
  readonly observedUpper: readonly (readonly [string, bigint])[];
  readonly ambiguousUpper: bigint;
  readonly unobservedUpper: bigint;
  readonly freshCandidates: readonly string[];
};
export type OwnedTimedSampleEvidence = TimedSampleSnapshot & { readonly [ownedTimedSampleBrand]: true };
const timedSnapshots = new WeakMap<object, TimedSampleSnapshot>();

/** Immutable arithmetic evidence, not authentication or person-identity authority. */
export function createOwnedTimedSampleEvidence(input: TimedSampleSnapshot): OwnedTimedSampleEvidence {
  const invalid = () => { throw new Error("invalid timed sample evidence"); };
  const count = (value: bigint) => typeof value === "bigint" && value >= 0n && value <= (1n << 64n) - 1n;
  if (!Number.isSafeInteger(input.sampleRateHz) || input.sampleRateHz <= 0 || !count(input.possibleSamples) ||
    !count(input.ambiguousUpper) || !count(input.unobservedUpper)) return invalid();
  const copy = (entries: TimedSampleSnapshot["candidateLower"]) => {
    // Same maximum as the frozen artifact's participant set, not a capture limit.
    if (entries.length > 500) return invalid();
    const keys = new Set<string>();
    return Object.freeze(entries.map(([key, value]) => {
      if (typeof key !== "string" || !key || keys.has(key) || !count(value)) return invalid();
      keys.add(key); return Object.freeze([key, value] as const);
    }));
  };
  const lower = copy(input.candidateLower), upper = copy(input.observedUpper), upperMap = new Map(upper);
  // Distinct conservative maxima may overlap. They are not an exact partition.
  if (lower.some(([key, value]) => value > (upperMap.get(key) ?? 0n)) ||
    lower.reduce((sum, [, value]) => sum + value, 0n) > input.possibleSamples ||
    [...upper.map(([, value]) => value), input.ambiguousUpper, input.unobservedUpper].some((value) => value > input.possibleSamples) ||
    input.freshCandidates.length > 500 || new Set(input.freshCandidates).size !== input.freshCandidates.length ||
    input.freshCandidates.some((key) => !lower.some(([id]) => id === key))) return invalid();
  const snapshot: TimedSampleSnapshot = Object.freeze({ sampleRateHz: input.sampleRateHz, possibleSamples: input.possibleSamples,
    candidateLower: lower, observedUpper: upper, ambiguousUpper: input.ambiguousUpper, unobservedUpper: input.unobservedUpper,
    freshCandidates: Object.freeze([...input.freshCandidates]) });
  const value = snapshot as OwnedTimedSampleEvidence;
  timedSnapshots.set(value, snapshot);
  return value;
}

export function getOwnedTimedSampleSnapshot(value: unknown): TimedSampleSnapshot | null {
  return typeof value === "object" && value !== null ? timedSnapshots.get(value) ?? null : null;
}

/** Candidate lower bound and conflict upper bound are never rounded through ms. */
export function namedTimedCandidate(value: OwnedTimedSampleEvidence): string | null {
  const snapshot = getOwnedTimedSampleSnapshot(value);
  if (!snapshot) throw new Error("unowned timed sample evidence");
  if (snapshot.possibleSamples === 0n) return null;
  let candidate: string | null = null;
  for (const [id, credit] of snapshot.candidateLower) {
    if (!snapshot.freshCandidates.includes(id) || 5n * credit < 4n * snapshot.possibleSamples) continue;
    const conflict = snapshot.observedUpper.reduce((sum, [other, upper]) => sum + (other === id ? 0n : upper), snapshot.ambiguousUpper);
    if (1000n * conflict > 500n * BigInt(snapshot.sampleRateHz)) continue;
    if (candidate !== null) return null;
    candidate = id;
  }
  return candidate;
}
