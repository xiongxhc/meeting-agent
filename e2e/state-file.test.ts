import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

// A caller's bounded reader keeps its own refusals; a tear is still retried.
test("a caller-supplied byte reader is retried across a tear and its null means absent", () => {
  const texts = ['{"capturePosition":', '{"capturePosition":{"sequence":"2"}}'];
  let calls = 0;
  assert.deepEqual(readStateFile("ignored", { read: () => texts[Math.min(calls++, 1)] }), { capturePosition: { sequence: "2" } });
  assert.equal(calls, 2);
  assert.equal(readStateFile("ignored", { read: () => null }), null);
});

// Every reader of the live bridge state goes through readStateFile: a raw
// JSON.parse or boundedJson of state.json fails its phase on one torn write.
test("no harness module parses the live bridge state.json without the retrying reader", () => {
  const dir = import.meta.dirname, offenders: string[] = [];
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".mjs"))) {
    readFileSync(path.join(dir, name), "utf8").split("\n").forEach((line, index) => {
      if (/"state\.json"|\.statePath\b/.test(line) && /JSON\.parse\(|boundedJson\(|capacityPrivateJson\(/.test(line)) offenders.push(`${name}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});

// Only an absent file is "absent". A bounded reader's refusal (symlink, extent)
// must surface, or a caller would silently report no bridge.
test("a reader refusal surfaces as an error; only ENOENT or a null read means absent", async () => {
  assert.throws(() => readStateFile("ignored", { read: () => { throw new Error("file_extent"); } }), /file_extent/);
  assert.equal(readStateFile("ignored", { read: () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); } }), null);
  // @ts-expect-error Test-only harness module has no public declaration.
  const { boundedBytes } = await import("./ingress-run.mjs");
  const dir = mkdtempSync(path.join(os.tmpdir(), "state-file-"));
  try {
    const target = path.join(dir, "target.json"), link = path.join(dir, "state.json");
    writeFileSync(target, JSON.stringify({ capturePosition: { sequence: "1" } }));
    symlinkSync(target, link);
    const bounded = { read: (file: string) => boundedBytes(file, true)?.toString("utf8") ?? null };
    assert.throws(() => readStateFile(link, bounded));
    assert.equal(readStateFile(path.join(dir, "missing.json"), bounded), null);
    assert.deepEqual(readStateFile(target, bounded), { capturePosition: { sequence: "1" } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
