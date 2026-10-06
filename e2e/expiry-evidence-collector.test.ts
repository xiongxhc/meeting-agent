// Actual private files and owned child fixtures: synthetic component-C only.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { chmodSync, linkSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { clearTimeout, setTimeout } from "node:timers";
// @ts-expect-error Private harness JavaScript has no public declaration.
import { parseExpiryEvidence } from "./expiry-evidence.mjs";

// @ts-expect-error Private harness JavaScript has no public declaration.
const collector = await import("./expiry-evidence-collector.mjs").catch(() => null);
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const header = { schema: "runtime-media-admission-evidence/v1", instance: "a".repeat(32), sequence: 0, type: "header" };
const journal = Buffer.from(`${JSON.stringify(header)}\n${JSON.stringify({ ...header, sequence: 1, type: "completion", record_count: 2, loss: false, writer_error: false })}\n`);
function fixture(script = "") {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "expiry-collector-C-")); chmodSync(root, 0o700);
  const gatewayPath = path.join(root, "gateway"), sdkPath = path.join(root, "sdk.tgz");
  const journalPath = path.join(root, "journal"), receiptPath = path.join(root, "receipt"), descriptorPath = path.join(root, "descriptor");
  writeFileSync(gatewayPath, `#!${process.execPath}\nconst fs = require('node:fs');\n${script}\n`, { mode: 0o700 });
  writeFileSync(sdkPath, "synthetic-sdk", { mode: 0o600 });
  const packageNames = ["artifactManifest", "sourceManifest", "patch", "buildMetadata", "erratum", "reconciledAudit"] as const;
  const packagePaths = Object.fromEntries(packageNames.map(name => {
    const file = path.join(root, name); writeFileSync(file, `synthetic-${name}`, { mode: 0o600 }); return [name, file];
  })) as Record<typeof packageNames[number], string>;
  const expectedProvenance = { profile: "runtime-media-evidence-test-20261005", ...Object.fromEntries(Object.entries(packagePaths).map(([name, file]) => [`${name}Sha256`, digest(readFileSync(file))])), base: "b".repeat(40), candidateTree: "c".repeat(40), gatewaySha256: digest(readFileSync(gatewayPath)), sdkSha256: digest(readFileSync(sdkPath)) };
  const descriptor = { schema: "meeting-expiry-collector/v1", privateRoot: root, journalPath, receiptPath, gatewayPath, sdkPath, packagePaths, expectedProvenance };
  writeFileSync(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
  return { root, descriptorPath, descriptor, gatewayPath, sdkPath, journalPath, receiptPath };
}
const writeJournal = `fs.writeFileSync(process.env.RUNTIME_MEDIA_ADMISSION_EVIDENCE_PATH, Buffer.from('${journal.toString("base64")}', 'base64'), {flag:'wx',mode:0o600});`;
function api() { assert.ok(collector, "private collector module must exist"); return collector; }
function cleanup(f: ReturnType<typeof fixture>) { rmSync(f.root, { recursive: true, force: true }); }

for (const mutation of ["mode", "hardlink", "symlink", "replace", "truncate", "oversize", "prefix-rewrite", "parent-mode"] as const) {
  test(`held file refuses actual ${mutation} mutation (synthetic C)`, () => {
    const f = fixture();
    try {
      const reader = api().createExpiryEvidenceReader(f.descriptorPath);
      writeFileSync(f.journalPath, journal, { mode: 0o600 });
      assert.equal(reader.readTail().parsed.complete, false);
      if (mutation === "mode") chmodSync(f.journalPath, 0o644);
      if (mutation === "hardlink") linkSync(f.journalPath, path.join(f.root, "link"));
      if (mutation === "symlink") { renameSync(f.journalPath, path.join(f.root, "old")); symlinkSync(path.join(f.root, "old"), f.journalPath); }
      if (mutation === "replace") { renameSync(f.journalPath, path.join(f.root, "old")); writeFileSync(f.journalPath, journal, { mode: 0o600 }); }
      if (mutation === "truncate") truncateSync(f.journalPath, 5);
      if (mutation === "oversize") truncateSync(f.journalPath, 4096 * 2048 + 1);
      if (mutation === "prefix-rewrite") {
        const rewritten = Buffer.from(journal.toString().replaceAll("a".repeat(32), "d".repeat(32)));
        assert.equal(rewritten.length, journal.length);
        assert.equal(parseExpiryEvidence(rewritten).complete, true); // schema-valid, same length: only custody guard refuses
        writeFileSync(f.journalPath, rewritten);
      }
      if (mutation === "parent-mode") chmodSync(f.root, 0o755);
      assert.throws(() => reader.readTail(), mutation === "prefix-rewrite" ? { message: "expiry_collector_identity" } : /^Error: expiry_collector_[a-z_]+$/);
      reader.close();
    } finally { cleanup(f); }
  });
}
for (const mutation of ["descriptor-extra", "descriptor-mode", "stale-journal", "stale-receipt", "binary-hash", "source-hash", "sdk-hash", "root-symlink"] as const) {
  test(`prelaunch refuses ${mutation} (synthetic C)`, () => {
    const f = fixture(); let descriptorPath = f.descriptorPath;
    try {
      if (mutation === "descriptor-extra") writeFileSync(descriptorPath, JSON.stringify({ ...f.descriptor, token: "never-echo" }));
      if (mutation === "descriptor-mode") chmodSync(descriptorPath, 0o644);
      if (mutation === "stale-journal") writeFileSync(f.journalPath, journal);
      if (mutation === "stale-receipt") writeFileSync(f.receiptPath, "{}");
      if (mutation === "binary-hash") writeFileSync(f.gatewayPath, "changed");
      if (mutation === "source-hash") writeFileSync(f.descriptor.packagePaths.sourceManifest, "changed");
      if (mutation === "sdk-hash") writeFileSync(f.sdkPath, "changed");
      if (mutation === "root-symlink") { symlinkSync(f.root, `${f.root}-link`); descriptorPath = `${f.root}-link/descriptor`; }
      assert.throws(() => api().createExpiryEvidenceCollector(descriptorPath), /^Error: expiry_collector_[a-z_]+$/);
    } finally { rmSync(`${f.root}-link`, { recursive: true, force: true }); cleanup(f); }
  });
}
for (const scenario of ["success", "exit-failure", "signal", "missing-journal", "binary-change", "source-change", "observer-failure", "receipt-collision", "spawn-error"] as const) {
  test(`actual owned child ${scenario} (synthetic C)`, { timeout: 5000 }, async () => {
    const suffix = scenario === "exit-failure" ? "process.exit(9);" : scenario === "signal" ? "process.kill(process.pid,'SIGTERM');" : "";
    const f = fixture((scenario === "missing-journal" || scenario === "spawn-error" ? "" : writeJournal) + suffix);
    try {
      const c = api().createExpiryEvidenceCollector(f.descriptorPath);
      const child = c.spawn([], { env: { ...process.env }, cwd: scenario === "spawn-error" ? path.join(f.root, "absent-cwd") : f.root });
      child.stdin.end(); child.stdout.resume(); child.stderr.resume();
      await new Promise(resolve => child.on("close", resolve));
      await c.whenClosed();
      if (scenario === "binary-change") writeFileSync(f.gatewayPath, "changed");
      if (scenario === "source-change") writeFileSync(f.descriptor.packagePaths.erratum, "changed");
      if (scenario === "observer-failure") c.fail();
      if (scenario === "receipt-collision") writeFileSync(f.receiptPath, "must-not-replace", { mode: 0o600 });
      const result = c.complete();
      if (scenario === "success") {
        assert.equal(result.ok, true); assert.equal(result.receipt.gatewayPid, child.pid);
        assert.equal(result.receipt.spawnObserved, true); assert.equal(result.receipt.exitCode, 0);
        assert.equal(result.receipt.signal, null); assert.equal(result.receipt.pipesClosed, true);
        assert.equal(fs.statSync(f.receiptPath).mode & 0o7777, 0o600); assert.equal(fs.statSync(f.receiptPath).nlink, 1);
        assert.equal(fs.readdirSync(f.root).filter(name => name.startsWith(".expiry-receipt-pending-")).length, 0);
        const reader = api().createExpiryEvidenceReader(f.descriptorPath);
        const final = reader.readFinal(); assert.deepEqual(final.journal, journal); assert.deepEqual(final.receipt, result.receipt); reader.close();
      } else {
        assert.equal(result.ok, false); assert.match(result.code, /^expiry_collector_[a-z_]+$/);
        if (scenario === "receipt-collision") assert.equal(readFileSync(f.receiptPath, "utf8"), "must-not-replace");
        else assert.throws(() => readFileSync(f.receiptPath));
      }
      c.close();
    } finally { cleanup(f); }
  });
}

test("reader is finite, bounded pending and refuses absent receipt despite completion", () => {
  const f = fixture();
  try {
    const reader = api().createExpiryEvidenceReader(f.descriptorPath);
    assert.equal(reader.readTail().status, "pending");
    writeFileSync(f.journalPath, Buffer.from(JSON.stringify(header).slice(0, 8)), { mode: 0o600 });
    assert.equal(reader.readTail().parsed.complete, false);
    writeFileSync(f.journalPath, journal);
    assert.equal(reader.readTail().parsed.complete, false);
    assert.throws(() => reader.readFinal(), { message: "expiry_collector_receipt" }); reader.close();
  } finally { cleanup(f); }
});

test("unchanged observed prefix can append valid completion (synthetic C)", () => {
  const f = fixture();
  try {
    const reader = api().createExpiryEvidenceReader(f.descriptorPath), prefix = Buffer.from(`${JSON.stringify(header)}\n`);
    writeFileSync(f.journalPath, prefix, { mode: 0o600 }); assert.equal(reader.readTail().parsed.records.length, 1);
    fs.appendFileSync(f.journalPath, journal.subarray(prefix.length)); assert.equal(reader.readTail().parsed.records.length, 2); reader.close();
  } finally { cleanup(f); }
});

for (const fault of ["file-sync-unlink", "directory-sync-unlink", "link", "pending-unlink", "final-artifact-unlink", "dangling-collision"] as const) {
  test(`receipt publication ${fault} (synthetic fault injection)`, { timeout: 5000 }, async () => {
    const f = fixture(writeJournal), original = { sync: fs.fsyncSync, unlink: fs.unlinkSync, link: fs.linkSync };
    let directorySyncCalls = 0;
    try {
      const c = api().createExpiryEvidenceCollector(f.descriptorPath), child = c.spawn([], { env: process.env });
      child.stdin.end(); child.stdout.resume(); child.stderr.resume(); await c.whenClosed();
      if (fault === "dangling-collision") symlinkSync(path.join(f.root, "absent-target"), f.receiptPath);
      fs.fsyncSync = fd => {
        if (fs.fstatSync(fd).isDirectory()) {
          directorySyncCalls++;
          if (fault === "directory-sync-unlink") throw Object.assign(new Error("private-dir-sync-diagnostic"), { code: "EIO" });
          if (fault === "final-artifact-unlink") writeFileSync(f.descriptor.packagePaths.erratum, "changed-after-publication");
        } else if (fault === "file-sync-unlink") throw Object.assign(new Error("private-file-sync-diagnostic"), { code: "EIO" });
        original.sync(fd);
      };
      fs.unlinkSync = file => {
        if (fault === "file-sync-unlink" || fault === "pending-unlink" || ((fault === "directory-sync-unlink" || fault === "final-artifact-unlink") && file === f.receiptPath))
          throw Object.assign(new Error("private-unlink-diagnostic"), { code: "EROFS" });
        original.unlink(file);
      };
      if (fault === "link") fs.linkSync = () => { throw Object.assign(new Error("private-link-diagnostic"), { code: "EIO" }); };
      syncBuiltinESMExports();
      const result = c.complete(); c.close();
      fs.fsyncSync = original.sync; fs.unlinkSync = original.unlink; fs.linkSync = original.link; syncBuiltinESMExports();
      assert.equal(result.ok, false); assert.match(result.code, /^expiry_collector_[a-z_]+$/);
      if (fault === "directory-sync-unlink" || fault === "final-artifact-unlink") assert.equal(directorySyncCalls, 1);
      if (fault === "file-sync-unlink" || fault === "link") {
        assert.throws(() => fs.lstatSync(f.receiptPath), { code: "ENOENT" });
        const reader = api().createExpiryEvidenceReader(f.descriptorPath); assert.throws(() => reader.readFinal(), { message: "expiry_collector_receipt" }); reader.close();
        if (fault === "file-sync-unlink") assert.equal(fs.readdirSync(f.root).filter(name => name.startsWith(".expiry-receipt-pending-")).length, 1);
      } else if (fault === "directory-sync-unlink") {
        // Post-publication namespace sync can fail while readable valid bytes remain.
        // Raw file consistency is intentionally not owned observer authorization.
        const reader = api().createExpiryEvidenceReader(f.descriptorPath); assert.deepEqual(reader.readFinal().journal, journal); reader.close();
        assert.equal(fs.statSync(f.receiptPath).nlink, 1);
      } else if (fault === "pending-unlink") {
        assert.equal(fs.statSync(f.receiptPath).nlink, 2);
        const reader = api().createExpiryEvidenceReader(f.descriptorPath); assert.throws(() => reader.readFinal(), { message: "expiry_collector_identity" }); reader.close();
      } else if (fault === "dangling-collision") assert.equal(fs.lstatSync(f.receiptPath).isSymbolicLink(), true);
      else assert.equal(fs.statSync(f.receiptPath).nlink, 1);
    } finally { fs.fsyncSync = original.sync; fs.unlinkSync = original.unlink; fs.linkSync = original.link; syncBuiltinESMExports(); cleanup(f); }
  });
}

for (const mutation of ["oversized", "duplicate-key", "parent-replace", "receipt-mode", "receipt-link", "receipt-extra", "receipt-process", "receipt-provenance", "receipt-journal"] as const) {
  test(`private descriptor/receipt refuses ${mutation} (synthetic C)`, { timeout: 5000 }, async () => {
    const f = fixture(writeJournal);
    try {
      if (mutation === "oversized") {
        writeFileSync(f.descriptorPath, "x".repeat(16385));
        assert.throws(() => api().createExpiryEvidenceReader(f.descriptorPath), { message: "expiry_collector_bounds" }); return;
      }
      if (mutation === "duplicate-key") {
        writeFileSync(f.descriptorPath, JSON.stringify(f.descriptor).replace('{"schema":', '{"schema":"duplicate","schema":'));
        assert.throws(() => api().createExpiryEvidenceReader(f.descriptorPath), { message: "expiry_collector_descriptor" }); return;
      }
      const c = api().createExpiryEvidenceCollector(f.descriptorPath);
      const child = c.spawn([], { env: process.env }); child.stdin.end(); child.stdout.resume(); child.stderr.resume();
      await new Promise(resolve => child.on("close", resolve)); await c.whenClosed(); assert.equal(c.complete().ok, true); c.close();
      const reader = api().createExpiryEvidenceReader(f.descriptorPath); reader.readTail();
      if (mutation === "parent-replace") {
        renameSync(f.root, `${f.root}-old`); fs.mkdirSync(f.root, { mode: 0o700 });
        assert.throws(() => reader.readFinal(), { message: "expiry_collector_identity" }); reader.close();
        rmSync(f.root, { recursive: true, force: true }); renameSync(`${f.root}-old`, f.root); return;
      }
      if (mutation === "receipt-mode") chmodSync(f.receiptPath, 0o644);
      else if (mutation === "receipt-link") linkSync(f.receiptPath, path.join(f.root, "receipt-link"));
      else {
        const receipt = JSON.parse(readFileSync(f.receiptPath, "utf8"));
        if (mutation === "receipt-extra") receipt.key = "never-echo";
        if (mutation === "receipt-process") receipt.exitCode = 9;
        if (mutation === "receipt-provenance") receipt.provenance.erratumSha256 = "d".repeat(64);
        if (mutation === "receipt-journal") receipt.journalSha256 = "e".repeat(64);
        writeFileSync(f.receiptPath, JSON.stringify(receipt));
      }
      assert.throws(() => reader.readFinal(), /^Error: expiry_collector_[a-z_]+$/); reader.close();
    } finally { cleanup(f); rmSync(`${f.root}-old`, { recursive: true, force: true }); }
  });
}

test("late receipt fsync exception removes success-looking receipt (synthetic fault injection)", { timeout: 5000 }, async () => {
  const f = fixture(writeJournal), original = fs.fsyncSync;
  try {
    const c = api().createExpiryEvidenceCollector(f.descriptorPath), child = c.spawn([], { env: process.env });
    child.stdin.end(); child.stdout.resume(); child.stderr.resume(); await new Promise(resolve => child.on("close", resolve)); await c.whenClosed();
    fs.fsyncSync = () => { throw new Error("secret-shaped-diagnostic-never-echo"); }; syncBuiltinESMExports();
    const result = c.complete(); assert.deepEqual(result, { ok: false, code: "expiry_collector_receipt" }); c.close();
    assert.throws(() => readFileSync(f.receiptPath)); assert.deepEqual(readFileSync(f.journalPath), journal);
  } finally { fs.fsyncSync = original; syncBuiltinESMExports(); cleanup(f); }
});

test("completion cannot accept supplied reaped facts or close before actual child close (synthetic C)", { timeout: 5000 }, async () => {
  const f = fixture(writeJournal + "setTimeout(()=>process.exit(0),40);");
  try {
    const c = api().createExpiryEvidenceCollector(f.descriptorPath), child = c.spawn([], { env: process.env });
    child.stdin.end(); child.stdout.resume(); child.stderr.resume();
    // Extra caller facts have no authority: complete owns its captured events.
    assert.deepEqual(c.complete({ reaped: true, exitCode: 0, pipesClosed: true }), { ok: false, code: "expiry_collector_process" });
    await new Promise(resolve => child.on("close", resolve));
    assert.deepEqual(c.complete(), { ok: false, code: "expiry_collector_state" }); assert.throws(() => readFileSync(f.receiptPath)); c.close();
  } finally { cleanup(f); }
});

// Actual special files, no FIFO writer. The independent parent deadline contains
// a blocking-open regression; a timer inside the blocked child would not suffice.
for (const scenario of ["descriptor-fifo", "journal-fifo", "receipt-fifo", "metadata-fifo", "gateway-fifo", "sdk-fifo", "descriptor-fifo-race", "journal-fifo-race", "descriptor-regular-race", "journal-regular-race", "journal-append-race"] as const) {
  test(`finite regular open ${scenario} (actual FIFO/synthetic owned child)`, { timeout: 8000 }, async () => {
    const f = fixture();
    const target = scenario.startsWith("descriptor") ? f.descriptorPath : scenario.startsWith("receipt") ? f.receiptPath : scenario.startsWith("metadata") ? f.descriptor.packagePaths.sourceManifest : scenario.startsWith("gateway") ? f.gatewayPath : scenario.startsWith("sdk") ? f.sdkPath : f.journalPath;
    const prefix = Buffer.from(`${JSON.stringify(header)}\n`);
    const initialFifo = scenario.endsWith("-fifo"), append = scenario === "journal-append-race";
    let child: ReturnType<typeof spawn> | undefined, startupTimer: ReturnType<typeof setTimeout> | undefined, blockedTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (scenario.startsWith("journal") || scenario.startsWith("receipt")) writeFileSync(f.journalPath, append ? prefix : journal, { mode: 0o600 });
      if (initialFifo) {
        rmSync(target, { force: true });
        assert.equal(spawnSync("/usr/bin/mkfifo", ["-m", "600", target], { stdio: "ignore" }).status, 0);
      }
      const probe = path.join(f.root, "finite-open-probe.mjs"), moduleUrl = new URL("./expiry-evidence-collector.mjs", import.meta.url).href;
      writeFileSync(probe, `import fs from 'node:fs';import{spawnSync}from'node:child_process';import{syncBuiltinESMExports}from'node:module';import{setTimeout,clearTimeout}from'node:timers';import{createExpiryEvidenceReader}from ${JSON.stringify(moduleUrl)};
const target=${JSON.stringify(target)},scenario=${JSON.stringify(scenario)},descriptor=${JSON.stringify(f.descriptorPath)};
let reader,opened=0,armed=true;const original=fs.openSync;
if(scenario.startsWith('journal')||scenario.startsWith('receipt'))reader=createExpiryEvidenceReader(descriptor);
fs.openSync=function(file,...args){if(file===target){opened++;if(armed&&scenario.endsWith('-race')){armed=false;
 if(scenario.includes('-fifo-')){fs.renameSync(target,target+'.old');if(spawnSync('/usr/bin/mkfifo',['-m','600',target],{stdio:'ignore'}).status!==0)throw new Error('fixture_fifo_setup');}
 else if(scenario.includes('-regular-')){const bytes=fs.readFileSync(target);fs.renameSync(target,target+'.old');fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});}
 else fs.appendFileSync(target,Buffer.from(${JSON.stringify(journal.subarray(prefix.length).toString("base64"))},'base64'));
}}return original(file,...args);};syncBuiltinESMExports();
fs.writeSync(1,'ENTERED\\n');const timer=setTimeout(()=>fs.writeSync(1,'CHILD_TIMER\\n'),100);
let outcome;try{const result=reader?(scenario.startsWith('receipt')?reader.readFinal():reader.readTail()):(reader=createExpiryEvidenceReader(descriptor));outcome={returned:true,records:result?.parsed?.records?.length??null};}catch(error){outcome={code:/^expiry_collector_[a-z_]+$/.test(error?.code)?error.code:'unexpected'};}finally{fs.openSync=original;syncBuiltinESMExports();reader?.close();clearTimeout(timer);}
fs.writeSync(1,JSON.stringify({...outcome,opened})+'\\n');`, { mode: 0o600 });
      child = spawn(process.execPath, [probe], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", intervention: string | null = null;
      const kill = (reason: string) => { intervention = reason; child?.kill("SIGKILL"); };
      startupTimer = setTimeout(() => kill("startup"), 3000);
      child.stdout!.on("data", (bytes: Buffer) => {
        stdout += bytes.toString();
        if (!blockedTimer && stdout.includes("ENTERED\n")) { clearTimeout(startupTimer); blockedTimer = setTimeout(() => kill("blocked_open"), 500); }
      });
      child.stderr!.on("data", (bytes: Buffer) => { stderr += bytes.toString(); });
      const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        child!.once("error", reject); child!.once("close", (code, signal) => resolve({ code, signal }));
      });
      assert.equal(intervention, null, `parent intervened: ${intervention}`); assert.deepEqual(exit, { code: 0, signal: null }); assert.equal(stderr, "");
      assert.ok(!stdout.includes("CHILD_TIMER"));
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      if (append) { assert.equal(result.returned, true); assert.equal(result.records, 2); }
      else { assert.equal(result.code, "expiry_collector_identity"); if (initialFifo) assert.equal(result.opened, 0, "pre-existing special file must refuse before open"); }
    } finally {
      clearTimeout(startupTimer); clearTimeout(blockedTimer);
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL"); await new Promise(resolve => child!.once("close", resolve));
      }
      cleanup(f);
    }
  });
}
