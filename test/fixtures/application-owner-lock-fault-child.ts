import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

const mode = process.argv[2];
assert.ok(mode === "no-close" || mode === "failed-kill" || mode === "owner-close-failure");

const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), "meeting-owner-lock-fault-")));
fs.chmodSync(root, 0o700);

try {
  const module = await import("../../src/adapters/application-owner-lock.ts");
  if (mode === "owner-close-failure") {
    const owner = await module.acquireApplicationOwnerLock(root);
    const originalClose = fs.closeSync;
    const attempted: number[] = [];
    let leakedLockFd: number | undefined;
    fs.closeSync = ((fd: number) => {
      attempted.push(fd);
      if (attempted.length === 1) {
        leakedLockFd = fd;
        throw new Error("synthetic close ambiguity");
      }
      originalClose(fd);
    }) as typeof fs.closeSync;
    syncBuiltinESMExports();
    let first = "no_throw";
    try { owner.close(); } catch (error) { first = (error as Error).message; }
    let secondClose = "no_throw";
    try { owner.close(); } catch (error) { secondClose = (error as Error).message; }
    let acquireAfterClose = "acquired";
    try { (await module.acquireApplicationOwnerLock(root)).close(); }
    catch (error) { acquireAfterClose = (error as Error).message; }
    fs.closeSync = originalClose;
    syncBuiltinESMExports();
    if (leakedLockFd !== undefined) originalClose(leakedLockFd);
    process.stdout.write(JSON.stringify({ first, secondClose, acquireAfterClose, closeAttempts: attempted.length }) + "\n");
  } else {
    const originalSpawn = childProcess.spawn;
    const originalClose = fs.closeSync;
    const closed: number[] = [];
    let killSignal = "none";
    class StuckChild extends EventEmitter {
      readonly stdout = new PassThrough();
      readonly stderr = null;
      readonly stdin = null;
      readonly pid = 424242;
      kill(signal?: NodeJS.Signals | number): boolean {
        killSignal = String(signal);
        return mode === "no-close";
      }
    }
    const stuck = new StuckChild();
    childProcess.spawn = (() => stuck as unknown as ChildProcess) as typeof childProcess.spawn;
    fs.closeSync = ((fd: number) => { closed.push(fd); originalClose(fd); }) as typeof fs.closeSync;
    syncBuiltinESMExports();
    let first = "acquired";
    try { (await module.acquireApplicationOwnerLock(root)).close(); }
    catch (error) { first = (error as Error).message; }
    let second = "acquired";
    try { (await module.acquireApplicationOwnerLock(root)).close(); }
    catch (error) { second = (error as Error).message; }
    const closedBeforeEvent = closed.length;
    stuck.emit("close", null, "SIGKILL");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const closedAfterEvent = closed.length;
    childProcess.spawn = originalSpawn;
    fs.closeSync = originalClose;
    syncBuiltinESMExports();
    process.stdout.write(JSON.stringify({ first, second, killSignal, closedBeforeEvent, closedAfterEvent }) + "\n");
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
