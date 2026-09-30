import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { encodeFrame } from "@conversation/runtime";

const repository = path.resolve(import.meta.dirname, "..");
const frame = Buffer.from(encodeFrame(Buffer.from(JSON.stringify({ type: "voice_event", event: { type: "voice_session_started", turn_id: "synthetic-turn", private_payload: "must-not-be-observed" } }))));

for (const scenario of ["split-coalesced", "malformed", "event-log-failure", "pid-log-failure"] as const) {
  test(`gateway observer preserves bytes and reaps child: ${scenario}`, { timeout: 8000 }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "meeting-observer-test-"));
    const fixture = path.join(root, "gateway"), key = path.join(root, "key"), childPid = path.join(root, "actual-pid");
    const events = scenario === "event-log-failure" ? root : path.join(root, "events");
    const pids = scenario === "pid-log-failure" ? root : path.join(root, "pids");
    const bytes = scenario === "malformed" ? Buffer.from([255, 255, 255, 255]) : Buffer.concat([frame, frame]);
    writeFileSync(key, `${"a".repeat(64)}\n`, { mode: 0o600 });
    writeFileSync(fixture, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(childPid)}, String(process.pid));\nconst bytes = Buffer.from(${JSON.stringify(bytes.toString("base64"))}, 'base64');\nprocess.stdout.write(bytes.subarray(0, 2));\nsetTimeout(() => { process.stdout.write(bytes.subarray(2)); ${scenario === "split-coalesced" ? "process.exit(0);" : "setInterval(() => {}, 1000);"} }, 20);\n`, { mode: 0o700 });
    const observer = spawn(process.execPath, [path.join(repository, "e2e/gateway-observer.mjs"), fixture, key, events, pids], { cwd: repository, stdio: ["pipe", "pipe", "pipe"] });
    const output: Buffer[] = []; let stderr = "";
    observer.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    observer.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    try {
      const code = await new Promise<number | null>((resolve) => observer.on("close", resolve));
      if (scenario === "split-coalesced") {
        assert.equal(code, 0); assert.deepEqual(Buffer.concat(output), bytes);
        const recorded = readFileSync(events, "utf8").trim().split("\n").map((line) => JSON.parse(line));
        assert.equal(recorded.length, 2);
        assert.deepEqual(Object.keys(recorded[0]).sort(), ["at", "turn_id", "type"]);
      } else {
        assert.equal(code, 70); assert.match(stderr, /gateway_observer_failed/);
      }
      // PID logging can fail before the synthetic child has executed its script.
      let pid: number | undefined;
      try { pid = Number(readFileSync(childPid, "utf8")); } catch { /* observer reaped spawn before script */ }
      if (pid) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      observer.kill("SIGKILL"); rmSync(root, { recursive: true, force: true });
    }
  });
}
