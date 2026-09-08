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
