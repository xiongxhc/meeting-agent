// Owner-side record of the application owner lock's admission helpers
// (src/adapters/application-owner-lock.ts runHelper). Test harness only:
// production source and API are unchanged. The record keeps fixed role tags,
// PIDs from the genuinely returned ChildProcess objects and their direct
// exit/close facts; no argv, paths, descriptors, output or error text.
export const ADMISSION_HELPER_SCHEMA = "meeting-ingress-admission-helpers/v1";
export const ADMISSION_HELPER_ROLES = ["volume_inspection", "filesystem_extract", "mount_extract", "owner_lock"];
// Exact call shapes of application-owner-lock.ts runHelper calls, in order. null marks the
// variable mount-point argument and "fd" the transferred lock descriptor; a source pin test
// (e2e/ingress-reopen-provenance.test.ts) binds these to the real lock source.
export const ADMISSION_HELPER_SHAPES = [
  { executable: "/usr/sbin/diskutil", args: ["info", "-plist", null], stdio: ["ignore", "pipe", "ignore"] },
  { executable: "/usr/bin/plutil", args: ["-extract", "FilesystemType", "raw", "-o", "-", "-"], stdio: ["pipe", "pipe", "ignore"] },
  { executable: "/usr/bin/plutil", args: ["-extract", "MountPoint", "raw", "-o", "-", "-"], stdio: ["pipe", "pipe", "ignore"] },
  { executable: "/usr/bin/lockf", args: ["-s", "-t", "0", "3"], stdio: ["ignore", "ignore", "ignore", "fd"] },
];
/** Fixed executable basename per role; a sampled comm is a further AND condition, never authority. */
export const ADMISSION_HELPER_BASENAMES = ADMISSION_HELPER_SHAPES.map(shape => shape.executable.slice(shape.executable.lastIndexOf("/") + 1));
const SHAPES = ADMISSION_HELPER_SHAPES;
const validPid = pid => Number.isSafeInteger(pid) && pid > 0;
let activeScope = false;

function expectedShape(shape, executable, args, options) {
  try {
    if (executable !== shape.executable || !Array.isArray(args) || args.length !== shape.args.length ||
      !shape.args.every((slot, index) => slot === null ? typeof args[index] === "string" : args[index] === slot)) return false;
    if (!options || typeof options !== "object" || options.shell !== false || options.detached !== false) return false;
    if (!options.env || typeof options.env !== "object" || Object.keys(options.env).length !== 0) return false;
    const stdio = options.stdio;
    return Array.isArray(stdio) && stdio.length === shape.stdio.length &&
      shape.stdio.every((slot, index) => slot === "fd" ? Number.isSafeInteger(stdio[index]) && stdio[index] >= 0 : stdio[index] === slot);
  } catch { return false; }
}

export function createAdmissionHelperObserver(childProcessModule, { ownerPid }) {
  const helpers = []; let invalid = !validPid(ownerPid), calls = 0;
  function register(child, executable, args, options) {
    const sequence = ++calls;
    if (sequence > SHAPES.length || !expectedShape(SHAPES[sequence - 1], executable, args, options)) { invalid = true; return; }
    const entry = { sequence, role: ADMISSION_HELPER_ROLES[sequence - 1], pid: null, exitObserved: false, closeObserved: false, code: null, signal: null };
    helpers.push(entry);
    try {
      if (!validPid(child?.pid) || helpers.some(row => row !== entry && row.pid === child.pid) || child.pid === ownerPid) { invalid = true; return; }
      entry.pid = child.pid;
      child.once("exit", (code, signal) => {
        entry.exitObserved = true;
        entry.code = Number.isInteger(code) && code >= 0 && code <= 255 ? code : null;
        entry.signal = typeof signal === "string" && /^SIG[A-Z0-9]{1,12}$/.test(signal) ? signal : null;
      });
      child.once("close", () => { entry.closeObserved = true; });
    } catch { invalid = true; }
  }
  return {
    async observe(acquire) {
      if (activeScope) throw new Error("ingress_admission_helper_scope");
      activeScope = true;
      const descriptor = Object.getOwnPropertyDescriptor(childProcessModule, "spawn"), original = descriptor?.value;
      try {
        if (!descriptor || typeof original !== "function" || !descriptor.writable || !descriptor.configurable) { invalid = true; return await acquire(); }
        Object.defineProperty(childProcessModule, "spawn", { ...descriptor, value: function observedSpawn(...args) {
          let child;
          try { child = Reflect.apply(original, this, args); }
          catch (error) { invalid = true; throw error; }
          register(child, args[0], args[1], args[2]);
          return child;
        } });
        return await acquire();
      } finally {
        if (descriptor) Object.defineProperty(childProcessModule, "spawn", descriptor);
        activeScope = false;
      }
    },
    record() {
      return { schema: ADMISSION_HELPER_SCHEMA, ownerPid, invalid: invalid || helpers.some(row => row.pid === null), helpers: helpers.map(row => ({ ...row })) };
    },
  };
}

/** Entry seam: observe the lock's helpers only for the closed-generation reopen owner (phase 3). */
export function createReopenAdmission(plan, { childProcessModule, ownerPid }) {
  const observer = plan.closedGenerationReopen === true && plan.phase === 3 ? createAdmissionHelperObserver(childProcessModule, { ownerPid }) : null;
  return {
    acquire(lockApi, root) { const acquire = () => lockApi.acquireApplicationOwnerLock(root); return observer ? observer.observe(acquire) : acquire(); },
    attach(result) { return observer ? { ...result, admissionHelpers: observer.record() } : result; },
  };
}
