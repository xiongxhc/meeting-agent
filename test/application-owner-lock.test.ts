import assert from "node:assert/strict";
import childProcess, { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

import { acquireApplicationOwnerLock } from "../src/adapters/application-owner-lock.ts";

const NODE24 = "/opt/homebrew/opt/node@24/bin/node";
const MODULE_URL = pathToFileURL(path.resolve("src/adapters/application-owner-lock.ts")).href;
const FAULT_CHILD = fileURLToPath(new URL("fixtures/application-owner-lock-fault-child.ts", import.meta.url));

type Fixture = {
  readonly root: string;
  close(): void;
};

function fixture(): Fixture {
  const parent = realpathSync(tmpdir());
  const root = realpathSync(mkdtempSync(path.join(parent, "meeting-application-owner-lock-")));
  chmodSync(root, 0o700);
  return {
    root,
    close() {
      assert.equal(path.dirname(root), parent);
      assert.match(path.basename(root), /^meeting-application-owner-lock-/);
      rmSync(root, { recursive: true, force: true });
      rmSync(`${root}.moved`, { recursive: true, force: true });
    },
  };
}

function onceScript(hold: boolean): string {
  return `
    import { acquireApplicationOwnerLock } from ${JSON.stringify(MODULE_URL)};
    try {
      const owner = await acquireApplicationOwnerLock(process.argv[1]);
      process.stdout.write("acquired\\n");
      if (${JSON.stringify(hold)}) {
        process.stdin.resume();
        process.stdin.once("data", () => {
          owner.close();
          process.stdout.write("closed\\n");
          process.exit(0);
        });
      } else {
        owner.close();
        process.exit(0);
      }
    } catch (error) {
      process.stdout.write(String(error instanceof Error ? error.message : error) + "\\n");
      process.exit(23);
    }
  `;
}

function spawnNode(script: string, args: readonly string[]): ChildProcess {
  return spawn(NODE24, ["--input-type=module", "--eval", script, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {},
    shell: false,
    detached: false,
  });
}

function completedChild(stdout: string, code = 0): ChildProcess {
  class SyntheticChild extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = null;
    readonly stdin = new PassThrough();
    readonly pid = 424243;
    kill(): boolean { return true; }
  }
  const child = new SyntheticChild();
  setImmediate(() => {
    child.stdout.end(stdout);
    setImmediate(() => child.emit("close", code, null));
  });
  return child as unknown as ChildProcess;
}

async function lineFrom(child: ChildProcess, timeoutMs = 7_000): Promise<string> {
  const stdout = child.stdout;
  assert.ok(stdout);
  const output = stdout;
  return await new Promise<string>((resolve, reject) => {
    let bytes = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("child output timeout"));
    }, timeoutMs);
    const onData = (chunk: Buffer | string) => {
      bytes += chunk.toString();
      const newline = bytes.indexOf("\n");
      if (newline >= 0) {
        const line = bytes.slice(0, newline);
        cleanup();
        resolve(line);
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error("child output failed"));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("child closed without output"));
    };
    function cleanup() {
      clearTimeout(timer);
      output.off("data", onData);
      output.off("error", onError);
      output.off("close", onClose);
    }
    output.on("data", onData);
    output.once("error", onError);
    output.once("close", onClose);
  });
}

async function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("child exit timeout"));
    }, timeoutMs);
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = () => {
      cleanup();
      reject(new Error("child process error"));
    };
    function cleanup() {
      clearTimeout(timer);
      child.off("close", onClose);
      child.off("error", onError);
    }
    child.once("close", onClose);
    child.once("error", onError);
  });
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill("SIGCONT"); } catch { /* already gone */ }
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  try {
    await waitForExit(child, 1_000);
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    await waitForExit(child, 2_000).catch(() => {});
  }
}

test("the retained macOS owner keeps a stable private file and close is idempotent", async () => {
  const f = fixture();
  try {
    const owner = await acquireApplicationOwnerLock(f.root);
    const lockPath = path.join(f.root, "application.lock");
    const stat = lstatSync(lockPath, { bigint: true });
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.uid, BigInt(process.getuid!()));
    assert.equal(stat.nlink, 1n);
    assert.equal(stat.mode & 0o777n, 0o600n);
    owner.assertCurrentOwnership();
    owner.close();
    owner.close();
    assert.equal(lstatSync(lockPath, { bigint: true }).ino, stat.ino);
    const reopened = await acquireApplicationOwnerLock(f.root);
    reopened.close();
  } finally { f.close(); }
});

test("two Node 24 processes contend immediately and SIGSTOP cannot age out ownership", async () => {
  const f = fixture();
  const owner = spawnNode(onceScript(true), [f.root]);
  try {
    assert.equal(await lineFrom(owner), "acquired");
    assert.equal(owner.kill("SIGSTOP"), true);
    const contender = spawnNode(onceScript(false), [f.root]);
    try {
      assert.equal(await lineFrom(contender), "application_owner_lock_held");
      assert.deepEqual(await waitForExit(contender), { code: 23, signal: null });
    } finally { await terminate(contender); }

    assert.equal(owner.kill("SIGCONT"), true);
    owner.stdin!.end("close\n");
    assert.equal(await lineFrom(owner), "closed");
    assert.deepEqual(await waitForExit(owner), { code: 0, signal: null });

    const next = spawnNode(onceScript(false), [f.root]);
    try {
      assert.equal(await lineFrom(next), "acquired");
      assert.deepEqual(await waitForExit(next), { code: 0, signal: null });
    } finally { await terminate(next); }
  } finally {
    await terminate(owner);
    f.close();
  }
});

test("different canonical private roots have independent owners", async () => {
  const firstFixture = fixture();
  const secondFixture = fixture();
  try {
    const first = await acquireApplicationOwnerLock(firstFixture.root);
    const second = await acquireApplicationOwnerLock(secondFixture.root);
    try {
      first.assertCurrentOwnership();
      second.assertCurrentOwnership();
    } finally {
      second.close();
      first.close();
    }
  } finally {
    secondFixture.close();
    firstFixture.close();
  }
});

test("a mocked device boundary selects that containing directory for APFS inspection", async (t) => {
  const f = fixture();
  const originalLstat = fs.lstatSync;
  const originalSpawn = childProcess.spawn;
  const parent = path.dirname(f.root);
  try {
    t.mock.method(fs, "lstatSync", ((filename: fs.PathLike, options?: { bigint?: boolean }) => {
      if (options?.bigint) {
        const value = originalLstat(filename, { bigint: true });
        if (filename === parent) value.dev += 1n;
        return value;
      }
      return originalLstat(filename);
    }) as typeof fs.lstatSync);
    syncBuiltinESMExports();
    t.mock.method(childProcess, "spawn", ((executable: string, args: readonly string[], options: Parameters<typeof childProcess.spawn>[2]) => {
      if (executable === "/usr/sbin/diskutil") return completedChild(args[2] === f.root ? "plist" : "", args[2] === f.root ? 0 : 1);
      if (executable === "/usr/bin/plutil") {
        return completedChild(args[1] === "FilesystemType" ? "apfs\n" : `${f.root}\n`);
      }
      return originalSpawn(executable, args, options);
    }) as typeof childProcess.spawn);
    const owner = await acquireApplicationOwnerLock(f.root);
    owner.close();
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.close();
  }
});

test("APFS type alone cannot admit a reported mount point on another device", async (t) => {
  const f = fixture();
  const originalSpawn = childProcess.spawn;
  try {
    t.mock.method(childProcess, "spawn", ((executable: string, args: readonly string[], options: Parameters<typeof childProcess.spawn>[2]) => {
      if (executable === "/usr/sbin/diskutil") return completedChild("plist");
      if (executable === "/usr/bin/plutil") {
        return completedChild(args[1] === "FilesystemType" ? "apfs\n" : "/dev\n");
      }
      return originalSpawn(executable, args, options);
    }) as typeof childProcess.spawn);
    await assert.rejects(acquireApplicationOwnerLock(f.root), { message: "application_owner_lock_root_unsafe" });
  } finally {
    t.mock.restoreAll();
    f.close();
  }
});

test("a non-APFS filesystem report is refused before the lock file is opened", async (t) => {
  const f = fixture();
  const originalSpawn = childProcess.spawn;
  try {
    t.mock.method(childProcess, "spawn", ((executable: string, args: readonly string[], options: Parameters<typeof childProcess.spawn>[2]) => {
      if (executable === "/usr/sbin/diskutil") return completedChild("plist");
      if (executable === "/usr/bin/plutil") return completedChild("hfs\n");
      return originalSpawn(executable, args, options);
    }) as typeof childProcess.spawn);
    await assert.rejects(acquireApplicationOwnerLock(f.root), { message: "application_owner_lock_root_unsafe" });
    assert.throws(() => lstatSync(path.join(f.root, "application.lock")), { code: "ENOENT" });
  } finally {
    t.mock.restoreAll();
    f.close();
  }
});

test("unsafe root and lock shapes refuse without repair, replacement, or unlink", async () => {
  for (const kind of ["root-symlink", "root-mode", "lock-symlink", "lock-hardlink", "lock-mode"] as const) {
    const f = fixture();
    const originalRoot = f.root;
    let stateRoot = originalRoot;
    const lockPath = path.join(originalRoot, "application.lock");
    const outside = path.join(path.dirname(originalRoot), `${path.basename(originalRoot)}-outside`);
    try {
      if (kind === "root-symlink") {
        mkdirSync(outside, { mode: 0o700 });
        stateRoot = `${originalRoot}-link`;
        symlinkSync(originalRoot, stateRoot);
      } else if (kind === "root-mode") {
        chmodSync(originalRoot, 0o755);
      } else {
        writeFileSync(outside, "operator-owned", { mode: 0o600 });
        if (kind === "lock-symlink") symlinkSync(outside, lockPath);
        if (kind === "lock-hardlink") linkSync(outside, lockPath);
        if (kind === "lock-mode") writeFileSync(lockPath, "operator-owned", { mode: 0o640 });
      }
      const beforeOutside = kind.startsWith("lock-") ? readFileSync(outside) : null;
      await assert.rejects(acquireApplicationOwnerLock(stateRoot), { message: "application_owner_lock_root_unsafe" });
      if (beforeOutside !== null) assert.deepEqual(readFileSync(outside), beforeOutside);
      if (kind === "root-mode") assert.equal(lstatSync(originalRoot).mode & 0o777, 0o755);
      if (kind === "lock-hardlink") assert.equal(lstatSync(lockPath).nlink, 2);
      if (kind === "lock-mode") assert.equal(lstatSync(lockPath).mode & 0o777, 0o640);
    } finally {
      try { fs.unlinkSync(`${originalRoot}-link`); } catch { /* absent */ }
      rmSync(outside, { recursive: true, force: true });
      f.close();
    }
  }
});

test("root pathname replacement is detected against the retained BigInt descriptor identity", async (t) => {
  const f = fixture();
  const original = fs.lstatSync;
  let rootChecks = 0;
  try {
    t.mock.method(fs, "lstatSync", ((filename: fs.PathLike, options?: { bigint?: boolean }) => {
      if (filename === f.root && options?.bigint && ++rootChecks === 2) {
        renameSync(f.root, `${f.root}.moved`);
        mkdirSync(f.root, { mode: 0o700 });
      }
      return options?.bigint ? original(filename, { bigint: true }) : original(filename);
    }) as typeof fs.lstatSync);
    syncBuiltinESMExports();
    await assert.rejects(acquireApplicationOwnerLock(f.root), { message: "application_owner_lock_root_unsafe" });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.close();
  }
});

test("lock pathname replacement is detected while the original locked descriptor stays retained", async (t) => {
  const f = fixture();
  const original = fs.lstatSync;
  const lockPath = path.join(f.root, "application.lock");
  let lockChecks = 0;
  try {
    t.mock.method(fs, "lstatSync", ((filename: fs.PathLike, options?: { bigint?: boolean }) => {
      if (filename === lockPath && options?.bigint && ++lockChecks === 2) {
        renameSync(lockPath, `${lockPath}.moved`);
        writeFileSync(lockPath, "replacement", { mode: 0o600 });
      }
      return options?.bigint ? original(filename, { bigint: true }) : original(filename);
    }) as typeof fs.lstatSync);
    syncBuiltinESMExports();
    await assert.rejects(acquireApplicationOwnerLock(f.root), { message: "application_owner_lock_root_unsafe" });
    assert.equal(readFileSync(lockPath, "utf8"), "replacement");
    assert.equal(lstatSync(`${lockPath}.moved`).isFile(), true);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.close();
  }
});

test("inode comparisons retain precision above Number.MAX_SAFE_INTEGER", async (t) => {
  const f = fixture();
  const originalLstat = fs.lstatSync;
  const originalFstat = fs.fstatSync;
  const base = 2n ** 60n;
  try {
    t.mock.method(fs, "lstatSync", ((filename: fs.PathLike, options?: { bigint?: boolean }) => {
      const value = options?.bigint ? originalLstat(filename, { bigint: true }) : originalLstat(filename);
      if (options?.bigint && value.isFile()) value.ino = base + 1n;
      return value;
    }) as typeof fs.lstatSync);
    syncBuiltinESMExports();
    t.mock.method(fs, "fstatSync", ((fd: number, options?: { bigint?: boolean }) => {
      const value = options?.bigint ? originalFstat(fd, { bigint: true }) : originalFstat(fd);
      if (options?.bigint && value.isFile()) value.ino = base;
      return value;
    }) as typeof fs.fstatSync);
    syncBuiltinESMExports();
    assert.equal(Number(base), Number(base + 1n));
    await assert.rejects(acquireApplicationOwnerLock(f.root), { message: "application_owner_lock_root_unsafe" });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.close();
  }
});

test("assertCurrentOwnership refuses later path replacement without releasing the retained descriptors", async (t) => {
  const f = fixture();
  const lockPath = path.join(f.root, "application.lock");
  try {
    const owner = await acquireApplicationOwnerLock(f.root);
    renameSync(lockPath, `${lockPath}.moved`);
    writeFileSync(lockPath, "replacement", { mode: 0o600 });
    const originalClose = fs.closeSync;
    const closed: number[] = [];
    try {
      t.mock.method(fs, "closeSync", ((fd: number) => { closed.push(fd); originalClose(fd); }) as typeof fs.closeSync);
      syncBuiltinESMExports();
      assert.throws(() => owner.assertCurrentOwnership(), { message: "application_owner_lock_root_unsafe" });
      assert.deepEqual(closed, []);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    owner.close();
  } finally { f.close(); }
});

test("unsupported platform refuses with a static redacted code", async () => {
  const script = `
    Object.defineProperty(process, "platform", { value: "linux" });
    const { acquireApplicationOwnerLock } = await import(${JSON.stringify(MODULE_URL)});
    try { await acquireApplicationOwnerLock("/not-observed"); }
    catch (error) { process.stdout.write(String(error.message) + "\\n"); process.exit(0); }
    process.exit(1);
  `;
  const child = spawnNode(script, []);
  try {
    assert.equal(await lineFrom(child), "application_owner_lock_unsupported");
    assert.deepEqual(await waitForExit(child), { code: 0, signal: null });
  } finally { await terminate(child); }
});

test("missing or invalid fixed helpers refuse without exposing their path", async (t) => {
  const f = fixture();
  const original = fs.lstatSync;
  try {
    t.mock.method(fs, "lstatSync", ((filename: fs.PathLike, options?: { bigint?: boolean }) => {
      if (filename === "/usr/bin/lockf") throw Object.assign(new Error("synthetic /secret/path"), { code: "ENOENT" });
      return options?.bigint ? original(filename, { bigint: true }) : original(filename);
    }) as typeof fs.lstatSync);
    syncBuiltinESMExports();
    await assert.rejects(acquireApplicationOwnerLock(f.root), (error: unknown) => {
      assert.equal((error as Error).message, "application_owner_lock_helper_unavailable");
      assert.doesNotMatch(String(error), /secret|usr\/bin/);
      return true;
    });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.close();
  }
});

test("a non-executable fixed helper is invalid and refuses statically", async (t) => {
  const f = fixture();
  const original = fs.lstatSync;
  try {
    t.mock.method(fs, "lstatSync", ((filename: fs.PathLike, options?: { bigint?: boolean }) => {
      if (filename === "/usr/bin/lockf" && options?.bigint) {
        const value = original(filename, { bigint: true });
        value.mode &= ~0o111n;
        return value;
      }
      return options?.bigint ? original(filename, { bigint: true }) : original(filename);
    }) as typeof fs.lstatSync);
    syncBuiltinESMExports();
    await assert.rejects(acquireApplicationOwnerLock(f.root), { message: "application_owner_lock_helper_unavailable" });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.close();
  }
});

test("a reaped non-contention lock helper failure releases descriptors and does not poison retry", async (t) => {
  const f = fixture();
  const originalSpawn = childProcess.spawn;
  try {
    t.mock.method(childProcess, "spawn", ((executable: string, args: readonly string[], options: Parameters<typeof childProcess.spawn>[2]) => {
      if (executable === "/usr/bin/lockf") return completedChild("", 1);
      return originalSpawn(executable, args, options);
    }) as typeof childProcess.spawn);
    await assert.rejects(acquireApplicationOwnerLock(f.root), { message: "application_owner_lock_helper_unavailable" });
    t.mock.restoreAll();
    const owner = await acquireApplicationOwnerLock(f.root);
    owner.close();
  } finally {
    t.mock.restoreAll();
    f.close();
  }
});

test("unconfirmed helper cleanup poisons acquisition but eventual close releases retained descriptors", async () => {
  for (const mode of ["no-close", "failed-kill"] as const) {
    const child = spawn(NODE24, [FAULT_CHILD, mode], { stdio: ["ignore", "pipe", "pipe"], env: {}, shell: false, detached: false });
    try {
      assert.equal(await lineFrom(child, 8_000), JSON.stringify({
        first: "application_owner_lock_cleanup_unconfirmed",
        second: "application_owner_lock_cleanup_unconfirmed",
        killSignal: "SIGKILL",
        closedBeforeEvent: 0,
        closedAfterEvent: 1,
      }));
      assert.deepEqual(await waitForExit(child), { code: 0, signal: null });
    } finally { await terminate(child); }
  }
});

test("an ambiguous owner close is attempted once per descriptor and never retried after fd reuse could occur", async () => {
  const child = spawn(NODE24, [FAULT_CHILD, "owner-close-failure"], { stdio: ["ignore", "pipe", "pipe"], env: {}, shell: false, detached: false });
  try {
    assert.equal(await lineFrom(child, 8_000), JSON.stringify({
      first: "application_owner_lock_cleanup_unconfirmed",
      secondClose: "no_throw",
      acquireAfterClose: "application_owner_lock_cleanup_unconfirmed",
      closeAttempts: 2,
    }));
    assert.deepEqual(await waitForExit(child), { code: 0, signal: null });
  } finally { await terminate(child); }
});
