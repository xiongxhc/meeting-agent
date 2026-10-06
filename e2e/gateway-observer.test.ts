import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { encodeFrame } from "@conversation/runtime";
// @ts-expect-error Private harness JavaScript has no public declaration.
import { createExpiryEvidenceReader } from "./expiry-evidence-collector.mjs";

const repository = path.resolve(import.meta.dirname, "..");
const frame = Buffer.from(encodeFrame(Buffer.from(JSON.stringify({ type: "voice_event", event: { type: "voice_session_started", session_id: "42", turn_id: "synthetic-turn", private_payload: "must-not-be-observed" } }))));

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
        assert.deepEqual(Object.keys(recorded[0]).sort(), ["at", "monotonicNs", "session_id", "turn_id", "type"]);
        assert.equal(recorded[0].session_id, "42");
        assert.ok(BigInt(recorded[0].monotonicNs) > 0n);
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

// Only synthetic executables, no gateway/SDK/network execution.
for (const scenario of ["evidence-bytes", "late-exit-failure", "duplicate-flag", "missing-separator", "gateway-mismatch", "ambient-only", "namespace-sync-failure"] as const) {
  test(`observer explicit private evidence: ${scenario} (synthetic C)`, { timeout: 8000 }, async () => {
    const root = mkdtempSync(path.join(realpathSync(tmpdir()), "meeting-observer-evidence-C-")); chmodSync(root, 0o700);
    const gateway = path.join(root, "gateway"), key = path.join(root, "key"), events = path.join(root, "events"), pids = path.join(root, "pids");
    const journalPath = path.join(root, "journal"), receiptPath = path.join(root, "receipt"), descriptorPath = path.join(root, "descriptor"), sdkPath = path.join(root, "sdk");
    const started = path.join(root, "started");
    const header = { schema: "runtime-media-admission-evidence/v1", instance: "a".repeat(32), sequence: 0, type: "header" };
    const journal = `${JSON.stringify(header)}\n${JSON.stringify({ ...header, sequence: 1, type: "completion", record_count: 2, loss: false, writer_error: false })}\n`;
    writeFileSync(gateway, `#!${process.execPath}\nconst fs=require('node:fs');\nfs.writeFileSync(${JSON.stringify(started)},process.env.RUNTIME_MEDIA_ADMISSION_EVIDENCE_PATH?'active':'inactive');\nif(process.env.RUNTIME_MEDIA_ADMISSION_EVIDENCE_PATH)fs.writeFileSync(process.env.RUNTIME_MEDIA_ADMISSION_EVIDENCE_PATH,${JSON.stringify(journal)},{flag:'wx',mode:0o600});\nconst bytes=Buffer.from('${frame.toString("base64")}','base64');process.stdout.write(bytes.subarray(0,2));setTimeout(()=>{process.stdout.write(bytes.subarray(2));process.exit(${scenario === "late-exit-failure" ? 9 : 0});},25);\n`, { mode: 0o700 });
    writeFileSync(key, `${"a".repeat(64)}\n`, { mode: 0o600 }); writeFileSync(sdkPath, "synthetic-sdk", { mode: 0o600 });
    const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
    const packagePaths = Object.fromEntries(["artifactManifest", "sourceManifest", "patch", "buildMetadata", "erratum", "reconciledAudit"].map(name => { const file = path.join(root, name); writeFileSync(file, `synthetic-${name}`, { mode: 0o600 }); return [name, file]; }));
    const expectedProvenance = { profile: "runtime-media-evidence-test-20261005", ...Object.fromEntries(Object.entries(packagePaths).map(([name, file]) => [`${name}Sha256`, digest(file)])), base: "b".repeat(40), candidateTree: "c".repeat(40), gatewaySha256: digest(gateway), sdkSha256: digest(sdkPath) };
    writeFileSync(descriptorPath, JSON.stringify({ schema: "meeting-expiry-collector/v1", privateRoot: root, journalPath, receiptPath, gatewayPath: gateway, sdkPath, packagePaths, expectedProvenance }), { mode: 0o600 });
    const faultModule = path.join(root, "synthetic-namespace-fault.mjs");
    if (scenario === "namespace-sync-failure") writeFileSync(faultModule, `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';const sync=fs.fsyncSync,unlink=fs.unlinkSync;fs.fsyncSync=fd=>{if(fs.fstatSync(fd).isDirectory())throw Object.assign(new Error('private-sync-diagnostic'),{code:'EIO'});sync(fd);};fs.unlinkSync=file=>{if(file===${JSON.stringify(receiptPath)})throw Object.assign(new Error('private-unlink-diagnostic'),{code:'EROFS'});unlink(file);};syncBuiltinESMExports();`, { mode: 0o600 });
    const prefix = scenario === "ambient-only" ? [] : ["--expiry-evidence-descriptor", descriptorPath, ...(scenario === "duplicate-flag" ? ["--expiry-evidence-descriptor", descriptorPath] : []), ...(scenario === "missing-separator" ? [] : ["--"])];
    const observer = spawn(process.execPath, [path.join(repository, "e2e/gateway-observer.mjs"), ...prefix, scenario === "gateway-mismatch" ? `${gateway}-other` : gateway, key, events, pids], { cwd: repository, env: { ...process.env, RUNTIME_MEDIA_ADMISSION_EVIDENCE_PATH: path.join(root, "ambient-journal"), ...(scenario === "namespace-sync-failure" ? { NODE_OPTIONS: `--import=${faultModule}` } : {}) }, stdio: ["pipe", "pipe", "pipe"] });
    const output: Buffer[] = []; let stderr = "";
    observer.stdout.on("data", (chunk: Buffer) => output.push(chunk)); observer.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); }); observer.stdin.end();
    try {
      const code = await new Promise<number | null>(resolve => observer.on("close", resolve));
      if (scenario === "evidence-bytes" || scenario === "ambient-only") {
        assert.equal(code, 0, stderr); assert.deepEqual(Buffer.concat(output), frame);
        assert.equal(readFileSync(started, "utf8"), scenario === "ambient-only" ? "inactive" : "active");
        if (scenario === "evidence-bytes") {
          const receipt = JSON.parse(readFileSync(receiptPath, "utf8")); assert.equal(receipt.exitCode, 0); assert.equal(receipt.spawnObserved, true); assert.equal(receipt.pipesClosed, true);
          assert.ok(!readFileSync(receiptPath, "utf8").includes("must-not-be-observed"));
        } else assert.throws(() => readFileSync(receiptPath));
      } else {
        assert.equal(code, 70); assert.match(stderr, /^gateway_observer_failed\n(?:expiry_collector_[a-z_]+\n)?$/);
        if (scenario === "namespace-sync-failure") {
          const reader = createExpiryEvidenceReader(descriptorPath); assert.equal(reader.readFinal().receipt.exitCode, 0); reader.close();
          // Actual observer code70 above is independent of these readable raw facts.
          // Future D must own/check that process outcome before report authorization.
          assert.deepEqual(Buffer.concat(output), frame);
        } else assert.throws(() => readFileSync(receiptPath));
        if (scenario === "late-exit-failure") assert.deepEqual(Buffer.concat(output), frame);
        else if (scenario === "namespace-sync-failure") assert.equal(readFileSync(started, "utf8"), "active");
        else assert.throws(() => readFileSync(started));
      }
    } finally { observer.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); }
  });
}
