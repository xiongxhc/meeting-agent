import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
// @ts-expect-error Test-only harness module has no public declaration.
import { readStateFile } from "./state-file.mjs";

// N40 r24: the bridge child rewrites state.json in place (writeFileSync) on
// every playback, flush and capture change while entry.mjs polls it from
// another process. A read that lands mid-rewrite must not surface as null.
test("a state read concurrent with an in-place rewrite returns a complete document", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "state-file-"));
  const filename = path.join(dir, "state.json");
  try {
    const writerSource = `
      import { writeFileSync } from "node:fs";
      const filename = ${JSON.stringify(filename)};
      const playback = Array.from({ length: 2000 }, (_, i) => ({ sequence: String(i), generation: "4", held: true }));
      writeFileSync(filename, JSON.stringify({ capturePosition: { sequence: "0" }, playback }));
      process.stdout.write("ready\\n");
      const deadline = Date.now() + 1500;
      for (let i = 1; Date.now() < deadline; i++) writeFileSync(filename, JSON.stringify({ capturePosition: { sequence: String(i) }, playback }));
    `;
    const writer = spawn(process.execPath, ["--input-type=module", "-e", writerSource], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve) => writer.stdout.once("data", () => resolve()));
    let reads = 0, torn = 0, rawTorn = 0, writerDone = false;
    const exited = new Promise<number | null>((resolve) => writer.once("exit", (code) => { writerDone = true; resolve(code); }));
    while (!writerDone) {
      for (let i = 0; i < 200; i++, reads++) {
        // A plain parse first, to prove reads really overlap writes.
        try { JSON.parse(readFileSync(filename, "utf8")); } catch { rawTorn++; }
        if (readStateFile(filename)?.capturePosition == null) torn++;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(await exited, 0);
    assert.ok(rawTorn >= 10, `race not exercised: ${rawTorn} raw tears in ${reads} reads`);
    assert.equal(torn, 0, `torn reads ${torn} of ${reads} (raw tears ${rawTorn})`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a missing state file still reads as null without waiting", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "state-file-"));
  try {
    const started = process.hrtime.bigint();
    assert.equal(readStateFile(path.join(dir, "state.json")), null);
    assert.ok(process.hrtime.bigint() - started < 5_000_000n);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A tear held longer than any fixed retry count (here ~120 ms, beyond 50
// one-millisecond tries) is still waited out inside the 250 ms deadline.
test("a tear held for ~120 ms is waited out within the deadline", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "state-file-"));
  const filename = path.join(dir, "state.json");
  try {
    writeFileSync(filename, JSON.stringify({ capturePosition: { sequence: "0" } }));
    const writerSource = `
      import { writeFileSync } from "node:fs";
      const filename = ${JSON.stringify(filename)};
      writeFileSync(filename, '{"capturePosition":');
      process.stdout.write("torn\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
      writeFileSync(filename, JSON.stringify({ capturePosition: { sequence: "1" } }));
    `;
    const writer = spawn(process.execPath, ["--input-type=module", "-e", writerSource], { stdio: ["ignore", "pipe", "inherit"] });
    const exited = new Promise<number | null>((resolve) => writer.once("exit", resolve));
    await new Promise<void>((resolve) => writer.stdout.once("data", () => resolve()));
    const started = performance.now();
    const value = readStateFile(filename);
    const elapsed = performance.now() - started;
    assert.equal(value?.capturePosition?.sequence, "1");
    assert.ok(elapsed < 250, `waited ${elapsed} ms`);
    assert.equal(await exited, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Permanently invalid content gives up at the deadline, and pauses between
// tries rather than spinning: CPU stays well below the wall time spent.
test("a permanently invalid state file returns null at the deadline without spinning", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "state-file-"));
  const filename = path.join(dir, "state.json");
  try {
    writeFileSync(filename, '{"capturePosition":');
    const cpu = process.cpuUsage(), started = performance.now();
    assert.equal(readStateFile(filename), null);
    const elapsed = performance.now() - started, used = process.cpuUsage(cpu);
    const cpuMs = (used.user + used.system) / 1000;
    assert.ok(elapsed >= 245 && elapsed < 1000, `gave up after ${elapsed} ms`);
    assert.ok(cpuMs < elapsed / 2, `cpu ${cpuMs} ms over ${elapsed} ms`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
