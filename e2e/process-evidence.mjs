import process from "node:process";

const FAILURE = "process_inventory_unavailable";
const validPid = pid => Number.isSafeInteger(pid) && pid > 0;

export function createProcessEvidence() {
  return { inventory: { samples: 0, failures: [] }, observed: [], children: [] };
}

function inventoryRows(result) {
  if (!result || result.exit !== 0 || result.error || typeof result.stdout !== "string" || !result.stdout.trim()) throw new Error(FAILURE);
  const rows = [], byPid = new Map();
  for (const line of result.stdout.split("\n").filter(line => line.trim())) {
    const match = /^\s*([0-9]+)\s+([0-9]+)\s+(\S.*)$/.exec(line);
    if (!match) throw new Error(FAILURE);
    const row = { pid: Number(match[1]), ppid: Number(match[2]), comm: match[3] };
    if (!validPid(row.pid) || !Number.isSafeInteger(row.ppid) || row.ppid < 0 || byPid.has(row.pid)) throw new Error(FAILURE);
    rows.push(row); byPid.set(row.pid, row);
  }
  // Validate the whole listing before traversal, including cycles away from the owner.
  const checked = new Set();
  for (const row of rows) {
    const ancestors = new Set();
    let current = row;
    while (current && !checked.has(current.pid)) {
      if (ancestors.has(current.pid)) throw new Error(FAILURE);
      ancestors.add(current.pid); current = byPid.get(current.ppid);
    }
    for (const pid of ancestors) checked.add(pid);
  }
  return rows;
}

export function observeProcessSnapshot(evidence, { result, rootPid, owner, baseline = false, excludePids = [] }) {
  let rows;
  try {
    if (!validPid(rootPid)) throw new Error(FAILURE);
    rows = inventoryRows(result);
  } catch {
    evidence.inventory.failures.push(FAILURE);
    throw new Error(FAILURE);
  }
  evidence.inventory.samples += 1;
  const byParent = new Map();
  for (const row of rows) byParent.set(row.ppid, [...(byParent.get(row.ppid) ?? []), row]);
  const self = rows.find(row => row.pid === rootPid);
  const tree = self ? [{ ...self, depth: 0 }] : [];
  const pending = [{ pid: rootPid, depth: 1 }];
  while (pending.length) {
    const parent = pending.pop();
    for (const row of byParent.get(parent.pid) ?? []) {
      tree.push({ ...row, depth: parent.depth });
      pending.push({ pid: row.pid, depth: parent.depth + 1 });
    }
  }
  if (!baseline) {
    const ignored = new Set(excludePids);
    for (const row of tree) {
      if (ignored.has(row.pid)) continue;
      const known = evidence.observed.find(entry => entry.pid === row.pid);
      if (!known) evidence.observed.push({ pid: row.pid, origins: [owner] });
      else if (!known.origins.includes(owner)) known.origins.push(owner);
    }
  }
  return tree;
}

export function processCleanupProof({ evidence, knownPids = [], probe = pid => process.kill(pid, 0) }) {
  const pids = [], invalidPids = [];
  const add = (pid, origins) => {
    if (!validPid(pid)) { invalidPids.push(...origins); return; }
    const previous = pids.find(entry => entry.pid === pid);
    if (previous) previous.origins = [...new Set([...previous.origins, ...origins])];
    else pids.push({ pid, origins: [...new Set(origins)] });
  };
  for (const entry of evidence?.observed ?? []) add(entry.pid, entry.origins);
  for (const child of evidence?.children ?? []) add(child.pid, [child.role]);
  for (const entry of knownPids) add(entry.pid, [entry.role]);
  const probes = pids.map(entry => {
    try { probe(entry.pid); return { ...entry, status: "present" }; }
    catch (error) { return { ...entry, status: error?.code === "ESRCH" ? "absent" : "unverified" }; }
  });
  const inventory = evidence?.inventory ?? { samples: 0, failures: [FAILURE] };
  const processInventoryVerified = Number.isSafeInteger(inventory.samples) && inventory.samples > 0 && inventory.failures.length === 0;
  const children = evidence?.children ?? [];
  const knownOwnedChildrenReaped = children.length > 0 && children.every(child => validPid(child.pid) && child.outcome?.exitObserved === true
    && ((Number.isInteger(child.outcome.code) && child.outcome.code >= 0) || typeof child.outcome.signal === "string"));
  const orphans = probes.filter(entry => entry.status === "present");
  return { pids, probes, orphans, invalidPids, inventory, children, knownOwnedChildrenReaped, processInventoryVerified,
    inventoryCoverage: processInventoryVerified ? "observed_run" : "incomplete",
    cleanupConfirmed: processInventoryVerified && knownOwnedChildrenReaped && invalidPids.length === 0 && probes.every(entry => entry.status === "absent") };
}
