import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createFilesystemOperatorWarningSink } from "../src/adapters/filesystem-operator-warning.ts";
import { operatorWarningKey, type OperatorWarningPayload } from "../src/ports/operator-warning.ts";

const payload: OperatorWarningPayload = {
  schema: "meeting-operator-warning/v1",
  occurrenceId: "meeting-warning@2026-09-02T14:00:00Z",
  stopAt: "2026-09-13T14:10:00.123Z",
  expiresAt: "2026-09-16T14:10:00.123Z",
  reason: "backfill_stopped",
};
const keyFor = (value: OperatorWarningPayload) => createHash("sha256")
  .update(JSON.stringify([value.schema, value.occurrenceId, value.stopAt, value.expiresAt])).digest("hex");

test("retained descriptor identity does not round distinct 64-bit inode values", async (t) => {
  const f = fixture();
  const originalLstat = fs.lstatSync;
  const originalFstat = fs.fstatSync;
  const openedInode = 2n ** 60n;
  assert.equal(Number(openedInode), Number(openedInode + 1n));
  try {
    mkdirSync(f.directory, { mode: 0o700 });
    writeFileSync(f.filename, JSON.stringify(payload) + "\n", { mode: 0o600 });
    t.mock.method(fs, "lstatSync", ((filename: fs.PathLike, options?: { bigint?: boolean }) => {
      if (options?.bigint) {
        const value = originalLstat(filename, { bigint: true });
        if (value.isFile()) value.ino = openedInode + 1n;
        return value;
      }
      const value = originalLstat(filename);
      if (value.isFile()) value.ino = Number(openedInode + 1n);
      return value;
    }) as typeof fs.lstatSync);
    t.mock.method(fs, "fstatSync", ((fd: number, options?: { bigint?: boolean }) => {
      if (options?.bigint) {
        const value = originalFstat(fd, { bigint: true });
        if (value.isFile()) value.ino = openedInode;
        return value;
      }
      const value = originalFstat(fd);
      if (value.isFile()) value.ino = Number(openedInode);
      return value;
    }) as typeof fs.fstatSync);
    syncBuiltinESMExports();
    await assert.rejects(createFilesystemOperatorWarningSink({ outboxDir: f.outboxDir }).accept({ key: keyFor(payload), payload }), /unsafe/);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); f.close();
  }
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "meeting-warning-"));
  chmodSync(root, 0o700);
  const outboxDir = path.join(root, "outbox");
  mkdirSync(outboxDir, { mode: 0o700 });
  const directory = path.join(outboxDir, "operator-warnings");
  return { root, outboxDir, directory, filename: path.join(directory, `${keyFor(payload)}.json`),
    close: () => rmSync(root, { recursive: true, force: true }) };
}

test("warning acceptance is private, durable, canonical and replay-idempotent across sink reopen", async () => {
  const f = fixture();
  try {
    const checkpoints: string[] = [];
    assert.equal(operatorWarningKey(payload), keyFor(payload));
    const sink = createFilesystemOperatorWarningSink({ outboxDir: f.outboxDir, durabilityCheckpoint: (step) => { checkpoints.push(step); } });
    assert.deepEqual(await sink.accept({ key: keyFor(payload), payload }), { key: keyFor(payload) });
    assert.deepEqual(JSON.parse(readFileSync(f.filename, "utf8")), payload);
    assert.equal(statSync(f.filename).mode & 0o777, 0o600);
    assert.equal(statSync(f.directory).mode & 0o777, 0o700);
    assert.ok(checkpoints.includes("file") && checkpoints.includes("directory"));
    assert.equal(existsSync(path.join(f.directory, "READY")), false);
    const before = readFileSync(f.filename);
    const reopened = createFilesystemOperatorWarningSink({ outboxDir: f.outboxDir });
    assert.deepEqual(await reopened.accept({ key: keyFor(payload), payload: { ...payload } }), { key: keyFor(payload) });
    assert.deepEqual(readFileSync(f.filename), before);
    assert.deepEqual(readdirSync(f.directory), [`${keyFor(payload)}.json`]);
  } finally { f.close(); }
});

test("invalid metadata or mismatched stable key is refused before filesystem mutation", async () => {
  for (const invalid of [
    { ...payload, schema: "other" }, { ...payload, occurrenceId: "not-an-occurrence" },
    { ...payload, stopAt: "2026-09-13T14:10:00Z" },
    { ...payload, expiresAt: "2026-09-17T14:10:00.123Z" },
    { ...payload, stopAt: "2026-02-30T00:00:00.000Z" },
    { ...payload, reason: "provider secret error" },
    { ...payload, transcript: "must not be persisted" },
    { ...payload, occurrenceId: `${"x".repeat(401)}@2026-09-02T14:00:00Z` },
  ]) {
    const f = fixture();
    try {
      const sink = createFilesystemOperatorWarningSink({ outboxDir: f.outboxDir });
      await assert.rejects(sink.accept({ key: keyFor(payload), payload: invalid as OperatorWarningPayload }), /invalid operator warning/);
      assert.equal(existsSync(f.directory), false);
    } finally { f.close(); }
  }
  const f = fixture();
  try {
    await assert.rejects(createFilesystemOperatorWarningSink({ outboxDir: f.outboxDir }).accept({ key: "../outside", payload }), /invalid operator warning/);
    assert.equal(existsSync(f.directory), false);
  } finally { f.close(); }
});

test("conflicting, oversized, permissive and symlink warning files are never accepted or overwritten", async () => {
  for (const kind of ["conflict", "oversized", "permissive", "symlink"] as const) {
    const f = fixture();
    try {
      mkdirSync(f.directory, { mode: 0o700 });
      const outside = path.join(f.root, "outside");
      const canonical = JSON.stringify(payload) + "\n";
      writeFileSync(outside, canonical, { mode: 0o600 });
      if (kind === "symlink") symlinkSync(outside, f.filename);
      else writeFileSync(f.filename, kind === "oversized" ? "x".repeat(8192) : kind === "permissive" ? canonical : "conflicting bytes", { mode: kind === "permissive" ? 0o644 : 0o600 });
      const before = readFileSync(f.filename);
      await assert.rejects(createFilesystemOperatorWarningSink({ outboxDir: f.outboxDir }).accept({ key: keyFor(payload), payload }));
      assert.deepEqual(readFileSync(f.filename), before);
      assert.equal(readFileSync(outside, "utf8"), canonical);
    } finally { f.close(); }
  }
});

test("crash between atomic link and staging unlink does not poison exact-byte acceptance", async () => {
  const f = fixture();
  try {
    mkdirSync(f.directory, { mode: 0o700 });
    const orphan = path.join(f.directory, `.${keyFor(payload)}-interrupted.tmp`);
    writeFileSync(orphan, JSON.stringify(payload) + "\n", { mode: 0o600 });
    linkSync(orphan, f.filename);
    const before = readFileSync(orphan);
    assert.deepEqual(await createFilesystemOperatorWarningSink({ outboxDir: f.outboxDir }).accept({ key: keyFor(payload), payload }), { key: keyFor(payload) });
    assert.deepEqual(readFileSync(orphan), before);
    assert.deepEqual(readFileSync(f.filename), before);
  } finally { f.close(); }
});

test("symlink or permissive inbox directories fail without modifying their targets", async () => {
  for (const kind of ["root-link", "child-link", "root-mode", "child-mode"] as const) {
    const f = fixture();
    try {
      const outside = path.join(f.root, "outside"); mkdirSync(outside, { mode: 0o700 });
      let outboxDir = f.outboxDir;
      if (kind === "root-link") { outboxDir = path.join(f.root, "outbox-link"); symlinkSync(f.outboxDir, outboxDir); }
      if (kind === "child-link") symlinkSync(outside, f.directory);
      if (kind === "root-mode") chmodSync(f.outboxDir, 0o755);
      if (kind === "child-mode") { mkdirSync(f.directory); chmodSync(f.directory, 0o755); }
      await assert.rejects(createFilesystemOperatorWarningSink({ outboxDir }).accept({ key: keyFor(payload), payload }));
      assert.deepEqual(readdirSync(outside), []);
      assert.equal(existsSync(f.filename), false);
    } finally { f.close(); }
  }
});

test("file and directory durability failures return no receipt; exact-byte replay repairs durability", async () => {
  for (const fault of ["file", "directory"] as const) {
    const f = fixture();
    try {
      const sink = createFilesystemOperatorWarningSink({ outboxDir: f.outboxDir,
        durabilityCheckpoint: (step) => {
          if (step === "file") assert.equal(existsSync(f.filename), false, "final warning must not expose a possibly partial write");
          if (step === fault) throw new Error(`injected ${fault} durability failure`);
        } });
      await assert.rejects(sink.accept({ key: keyFor(payload), payload }), /injected .* durability failure/);
      const reopened = createFilesystemOperatorWarningSink({ outboxDir: f.outboxDir });
      assert.deepEqual(await reopened.accept({ key: keyFor(payload), payload }), { key: keyFor(payload) });
      assert.deepEqual(JSON.parse(readFileSync(f.filename, "utf8")), payload);
      assert.deepEqual(readdirSync(f.directory), [`${keyFor(payload)}.json`]);
    } finally { f.close(); }
  }
});
