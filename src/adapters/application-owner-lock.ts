import childProcess, { type ChildProcess, type SpawnOptions } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import path from "node:path";

const DISKUTIL = "/usr/sbin/diskutil";
const PLUTIL = "/usr/bin/plutil";
const LOCKF = "/usr/bin/lockf";
const HELPER_TIMEOUT_MS = 2_000;
const REAP_TIMEOUT_MS = 1_000;
const MAX_OUTPUT_BYTES = 65_536;

const failureCodes = new Set([
  "application_owner_lock_unsupported",
  "application_owner_lock_root_unsafe",
  "application_owner_lock_helper_unavailable",
  "application_owner_lock_held",
  "application_owner_lock_cleanup_unconfirmed",
]);

let acquisitionPoisoned = false;

type DescriptorState = {
  rootFd: number | null;
  lockFd: number | null;
  transferred: boolean;
};

type HelperResult = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
};

export type ApplicationOwnerLock = {
  assertCurrentOwnership(): void;
  close(): void;
};

function refusal(code: string): Error {
  return new Error(code);
}

function isRefusal(error: unknown): error is Error {
  return error instanceof Error && failureCodes.has(error.message);
}

function currentUid(): bigint {
  if (process.getuid === undefined) throw refusal("application_owner_lock_unsupported");
  return BigInt(process.getuid());
}

function validateSystemHelper(filename: string): void {
  try {
    const stat = lstatSync(filename, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== 0n || stat.nlink < 1n ||
        (stat.mode & 0o111n) === 0n || (stat.mode & 0o022n) !== 0n) {
      throw refusal("application_owner_lock_helper_unavailable");
    }
  } catch (error) {
    if (isRefusal(error)) throw error;
    throw refusal("application_owner_lock_helper_unavailable");
  }
}

function validateRootPath(stateRoot: string): string {
  try {
    if (typeof stateRoot !== "string" || !path.isAbsolute(stateRoot) || path.normalize(stateRoot) !== stateRoot) {
      throw refusal("application_owner_lock_root_unsafe");
    }
    const canonical = realpathSync.native(stateRoot);
    if (canonical !== stateRoot) throw refusal("application_owner_lock_root_unsafe");
    return canonical;
  } catch (error) {
    if (isRefusal(error)) throw error;
    throw refusal("application_owner_lock_root_unsafe");
  }
}

function verifyRoot(stateRoot: string, rootFd: number): void {
  try {
    const named = lstatSync(stateRoot, { bigint: true });
    const opened = fstatSync(rootFd, { bigint: true });
    if (named.isSymbolicLink() || !opened.isDirectory() || named.dev !== opened.dev || named.ino !== opened.ino ||
        opened.uid !== currentUid() || (opened.mode & 0o077n) !== 0n) {
      throw refusal("application_owner_lock_root_unsafe");
    }
  } catch (error) {
    if (isRefusal(error)) throw error;
    throw refusal("application_owner_lock_root_unsafe");
  }
}

function verifyLock(lockPath: string, lockFd: number, rootFd: number): void {
  try {
    const named = lstatSync(lockPath, { bigint: true });
    const opened = fstatSync(lockFd, { bigint: true });
    const root = fstatSync(rootFd, { bigint: true });
    if (named.isSymbolicLink() || !opened.isFile() || named.dev !== opened.dev || named.ino !== opened.ino ||
        opened.dev !== root.dev || opened.uid !== currentUid() || opened.nlink !== 1n ||
        (opened.mode & 0o777n) !== 0o600n) {
      throw refusal("application_owner_lock_root_unsafe");
    }
  } catch (error) {
    if (isRefusal(error)) throw error;
    throw refusal("application_owner_lock_root_unsafe");
  }
}

function containingMountPoint(stateRoot: string, rootFd: number): string {
  verifyRoot(stateRoot, rootFd);
  try {
    const rootDevice = fstatSync(rootFd, { bigint: true }).dev;
    let candidate = stateRoot;
    for (let inspected = 0; inspected < 128; inspected += 1) {
      const current = lstatSync(candidate, { bigint: true });
      if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== rootDevice) {
        throw refusal("application_owner_lock_root_unsafe");
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) return candidate;
      const parentStat = lstatSync(parent, { bigint: true });
      if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
        throw refusal("application_owner_lock_root_unsafe");
      }
      if (parentStat.dev !== rootDevice) return candidate;
      candidate = parent;
    }
    throw refusal("application_owner_lock_root_unsafe");
  } catch (error) {
    if (isRefusal(error)) throw error;
    throw refusal("application_owner_lock_root_unsafe");
  }
}

function verifyReportedMountPoint(value: string, rootFd: number): void {
  try {
    if (!path.isAbsolute(value) || path.normalize(value) !== value) {
      throw refusal("application_owner_lock_root_unsafe");
    }
    const canonical = realpathSync.native(value);
    const mount = lstatSync(canonical, { bigint: true });
    const root = fstatSync(rootFd, { bigint: true });
    if (mount.isSymbolicLink() || !mount.isDirectory() || mount.dev !== root.dev) {
      throw refusal("application_owner_lock_root_unsafe");
    }
  } catch (error) {
    if (isRefusal(error)) throw error;
    throw refusal("application_owner_lock_root_unsafe");
  }
}

function closeDescriptorsOnce(state: DescriptorState): boolean {
  let clean = true;
  for (const key of ["lockFd", "rootFd"] as const) {
    const fd = state[key];
    if (fd === null) continue;
    // Consume the integer before close: a failed close is ambiguous and must
    // never be retried after the OS may have reused that descriptor number.
    state[key] = null;
    try { closeSync(fd); }
    catch { clean = false; }
  }
  return clean;
}

function transferCleanupToChild(state: DescriptorState): () => void {
  state.transferred = true;
  return () => { closeDescriptorsOnce(state); };
}

function runHelper(options: {
  readonly executable: string;
  readonly args: readonly string[];
  readonly stdio: SpawnOptions["stdio"];
  readonly input?: Buffer;
  readonly collectStdout?: boolean;
  readonly descriptors: DescriptorState;
}): Promise<HelperResult> {
  let child: ChildProcess;
  try {
    child = childProcess.spawn(options.executable, options.args, {
      stdio: options.stdio,
      env: {},
      shell: false,
      detached: false,
    });
  } catch {
    return Promise.reject(refusal("application_owner_lock_helper_unavailable"));
  }

  return new Promise<HelperResult>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let finished = false;
    let failed = false;
    let eventualCleanup: (() => void) | null = null;
    let reapTimer: NodeJS.Timeout | null = null;

    const operationTimer = setTimeout(() => terminate(), HELPER_TIMEOUT_MS);

    function clearTimers(): void {
      clearTimeout(operationTimer);
      if (reapTimer !== null) clearTimeout(reapTimer);
    }

    function terminate(): void {
      if (finished || reapTimer !== null) return;
      failed = true;
      clearTimeout(operationTimer);
      try { child.kill("SIGKILL"); } catch { /* reap deadline handles uncertainty */ }
      reapTimer = setTimeout(() => {
        if (finished) return;
        finished = true;
        acquisitionPoisoned = true;
        eventualCleanup = transferCleanupToChild(options.descriptors);
        reject(refusal("application_owner_lock_cleanup_unconfirmed"));
      }, REAP_TIMEOUT_MS);
    }

    child.once("error", () => terminate());
    child.once("close", (code, signal) => {
      if (eventualCleanup !== null) {
        const cleanup = eventualCleanup;
        eventualCleanup = null;
        cleanup();
        return;
      }
      if (finished) return;
      finished = true;
      clearTimers();
      if (failed) {
        reject(refusal("application_owner_lock_helper_unavailable"));
        return;
      }
      resolve({ code, signal, stdout: Buffer.concat(chunks, outputBytes) });
    });

    if (options.collectStdout) {
      if (child.stdout === null) {
        terminate();
      } else {
        child.stdout.on("data", (value: Buffer | string) => {
          if (finished || failed) return;
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          outputBytes += chunk.length;
          if (outputBytes > MAX_OUTPUT_BYTES) {
            terminate();
            return;
          }
          chunks.push(chunk);
        });
        child.stdout.once("error", () => terminate());
      }
    }

    if (options.input !== undefined) {
      if (child.stdin === null) {
        terminate();
      } else {
        child.stdin.once("error", () => terminate());
        child.stdin.end(options.input);
      }
    }
  });
}

function requireSuccessfulInspection(result: HelperResult): Buffer {
  if (result.code !== 0 || result.signal !== null) throw refusal("application_owner_lock_root_unsafe");
  return result.stdout;
}

function verifyCurrentOwnership(stateRoot: string, lockPath: string, state: DescriptorState): void {
  if (state.rootFd === null || state.lockFd === null || state.transferred) {
    throw refusal("application_owner_lock_root_unsafe");
  }
  verifyRoot(stateRoot, state.rootFd);
  verifyLock(lockPath, state.lockFd, state.rootFd);
}

export async function acquireApplicationOwnerLock(stateRoot: string): Promise<ApplicationOwnerLock> {
  if (acquisitionPoisoned) throw refusal("application_owner_lock_cleanup_unconfirmed");
  if (process.platform !== "darwin") throw refusal("application_owner_lock_unsupported");
  currentUid();
  validateSystemHelper(DISKUTIL);
  validateSystemHelper(PLUTIL);
  validateSystemHelper(LOCKF);
  const canonicalRoot = validateRootPath(stateRoot);
  const state: DescriptorState = { rootFd: null, lockFd: null, transferred: false };
  const lockPath = path.join(canonicalRoot, "application.lock");

  try {
    try {
      state.rootFd = openSync(canonicalRoot,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY | constants.O_NONBLOCK);
      verifyRoot(canonicalRoot, state.rootFd);
    } catch (error) {
      if (isRefusal(error)) throw error;
      throw refusal("application_owner_lock_root_unsafe");
    }

    const mountPoint = containingMountPoint(canonicalRoot, state.rootFd);
    const diskInfo = requireSuccessfulInspection(await runHelper({
      executable: DISKUTIL,
      args: ["info", "-plist", mountPoint],
      stdio: ["ignore", "pipe", "ignore"],
      collectStdout: true,
      descriptors: state,
    }));
    const filesystem = requireSuccessfulInspection(await runHelper({
      executable: PLUTIL,
      args: ["-extract", "FilesystemType", "raw", "-o", "-", "-"],
      stdio: ["pipe", "pipe", "ignore"],
      input: diskInfo,
      collectStdout: true,
      descriptors: state,
    })).toString("utf8").trim();
    if (filesystem !== "apfs") throw refusal("application_owner_lock_root_unsafe");
    const reportedMountPoint = requireSuccessfulInspection(await runHelper({
      executable: PLUTIL,
      args: ["-extract", "MountPoint", "raw", "-o", "-", "-"],
      stdio: ["pipe", "pipe", "ignore"],
      input: diskInfo,
      collectStdout: true,
      descriptors: state,
    })).toString("utf8").trim();
    verifyReportedMountPoint(reportedMountPoint, state.rootFd);
    verifyRoot(canonicalRoot, state.rootFd);

    try {
      state.lockFd = openSync(lockPath,
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o600);
      verifyLock(lockPath, state.lockFd, state.rootFd);
      verifyRoot(canonicalRoot, state.rootFd);
    } catch (error) {
      if (isRefusal(error)) throw error;
      throw refusal("application_owner_lock_root_unsafe");
    }

    const result = await runHelper({
      executable: LOCKF,
      args: ["-s", "-t", "0", "3"],
      stdio: ["ignore", "ignore", "ignore", state.lockFd],
      descriptors: state,
    });
    if (result.code === 75 && result.signal === null) throw refusal("application_owner_lock_held");
    if (result.code !== 0 || result.signal !== null) throw refusal("application_owner_lock_helper_unavailable");
    verifyCurrentOwnership(canonicalRoot, lockPath, state);
  } catch (error) {
    if (!state.transferred && !closeDescriptorsOnce(state)) {
      acquisitionPoisoned = true;
      throw refusal("application_owner_lock_cleanup_unconfirmed");
    }
    if (isRefusal(error)) throw error;
    throw refusal("application_owner_lock_root_unsafe");
  }

  let closed = false;
  return {
    assertCurrentOwnership(): void {
      if (closed) throw refusal("application_owner_lock_root_unsafe");
      verifyCurrentOwnership(canonicalRoot, lockPath, state);
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (!closeDescriptorsOnce(state)) {
        acquisitionPoisoned = true;
        throw refusal("application_owner_lock_cleanup_unconfirmed");
      }
    },
  };
}
