import { spawn, type ChildProcess } from "node:child_process";
import { constants, openSync, closeSync, fstatSync, readSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { createBridgeSessionValidator } from "../contracts/bridge-session-v1.ts";
import { createBridgeSessionValidatorV2 } from "../contracts/bridge-session-v2.ts";
import { OUTCOME_MAX_BYTES, decodeBridgeProcessOutcome, sameCustodyBinding, validateCustodyBinding } from "../contracts/bridge-process-outcome-v1.ts";
import { validateBridgeSlots } from "../config.ts";
import type { BridgeProcessSlot, BridgeShutdownResult, BridgeProcessFailure } from "../ports/bridge-process.ts";

export type ChildBridgeOptions = {
  readonly physicalClientId: string;
  readonly bridgeId: string;
  readonly executable: string;
  readonly staticConfigPath: string;
  readonly argv?: readonly string[];
  readonly cooperativeGraceMs?: number;
  /** Test seam: the invalid-control-line rate window (default 5 minutes). */
  readonly invalidLineWindowMs?: number;
  /** Wire contract for this slot; default v1 keeps the legacy behaviour byte for byte (D026). */
  readonly protocol?: "bridge-session/v1" | "bridge-session/v2";
};

const PROTOCOLS = ["bridge-session/v1", "bridge-session/v2"] as const;
/** A control line the validator refuses is dropped, never forwarded, and does
 * not stop capture. Only a sustained violation is treated as a broken bridge:
 * more than 8 in a row, or more than 16 within any 5 minutes. A bridge that
 * misbehaves now and then never loses the meeting however long it runs. */
const MAX_CONSECUTIVE_INVALID_LINES = 8;
const MAX_INVALID_LINES_PER_WINDOW = 16;
const INVALID_LINE_WINDOW_MS = 5 * 60 * 1000;

/** Exactly the `audio` object the accepted Mac executable decodes for feishu-bridge-config/v3. */
function validAudio(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const audio = value as Record<string, unknown>;
  const display = audio.captureDisplayId, uid = audio.outputDeviceUid;
  return Object.keys(audio).length === 2 && Object.hasOwn(audio, "captureDisplayId") && Object.hasOwn(audio, "outputDeviceUid") &&
    Number.isInteger(display) && (display as number) >= 1 && (display as number) <= 4_294_967_295 &&
    typeof uid === "string" && uid.length > 0 && Buffer.byteLength(uid) <= 512 && !uid.includes("\0");
}

function readStaticConfig(filename: string, v2: boolean): Record<string, unknown> {
  let fd: number;
  try { fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new Error("invalid_bridge_static_config"); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65_536) throw new Error("invalid_bridge_static_config");
    const bytes = Buffer.alloc(65_537); let offset = 0;
    const deadline = performance.now() + 1000;
    while (performance.now() < deadline) {
      let count: number;
      try { count = readSync(fd, bytes, offset, bytes.length - offset, null); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EINTR") continue; throw new Error("invalid_bridge_static_config"); }
      offset += count;
      if (offset > 65_536) throw new Error("invalid_bridge_static_config");
      if (count === 0) {
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset)));
        if (typeof value !== "object" || value === null || Array.isArray(value) ||
            (value as Record<string, unknown>).schema !== "feishu-bridge-config/v1" || Object.hasOwn(value, "custody")) throw new Error("invalid_bridge_static_config");
        const record = value as Record<string, unknown>;
        if (Object.hasOwn(record, "audio") !== v2 || v2 && !validAudio(record.audio)) throw new Error("invalid_bridge_static_config");
        return record;
      }
    }
    throw new Error("invalid_bridge_static_config");
  } catch { throw new Error("invalid_bridge_static_config"); }
  finally { closeSync(fd); }
}

export function createChildBridgeSlot(options: ChildBridgeOptions): BridgeProcessSlot {
  validateBridgeSlots([options]);
  const grace = options.cooperativeGraceMs ?? 10_000;
  const argv = [...(options.argv ?? [])];
  const v2 = options.protocol === "bridge-session/v2";
  if (options.protocol !== undefined && !PROTOCOLS.includes(options.protocol)) throw new Error("invalid_bridge_launch_config");
  if (!path.isAbsolute(options.executable) || !path.isAbsolute(options.staticConfigPath) ||
      !Number.isInteger(grace) || grace < 1000 || grace > 30_000 || argv.length > 16 ||
      argv.some((value) => typeof value !== "string" || value.includes("\0")) || Buffer.byteLength(JSON.stringify(argv)) > 4096) throw new Error("invalid_bridge_launch_config");
  return { physicalClientId: options.physicalClientId, bridgeId: options.bridgeId, async launch(value) {
    const binding = validateCustodyBinding(value);
    if (binding.physicalClientId !== options.physicalClientId) throw new Error("physical_client_binding_conflict");
    const config = { ...readStaticConfig(options.staticConfigPath, v2), schema: v2 ? "feishu-bridge-config/v3" : "feishu-bridge-config/v2", custody: binding };
    const bytes = JSON.stringify(config);
    if (Buffer.byteLength(bytes) > 65_536) throw new Error("invalid_bridge_static_config");
    const directory = mkdtempSync(path.join(os.tmpdir(), "meeting-bridge-"));
    const filename = path.join(directory, "config.json");
    try { writeFileSync(filename, bytes, { mode: 0o600, flag: "wx" }); }
    catch {
      // A failed write can have created a partial private file. Only these
      // freshly owned paths are eligible for cleanup; never expose OS details.
      try { unlinkSync(filename); } catch { /* absent or unremovable */ }
      try { rmdirSync(directory); } catch { /* leave private residue for operator */ }
      throw new Error("bridge_config_creation_failed");
    }
    const env: NodeJS.ProcessEnv = {};
    const allowed = { HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME, PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LC_CTYPE: process.env.LC_CTYPE };
    for (const [name, value] of Object.entries(allowed)) {
      if (value !== undefined) env[name] = value;
    }
    let child: ChildProcess;
    try { child = spawn(options.executable, [...argv, "--config", filename], { stdio: ["pipe", "pipe", "pipe", "pipe"], env, shell: false, detached: false }); }
    catch {
      try { unlinkSync(filename); rmdirSync(directory); } catch { /* private residue only */ }
      throw new Error("bridge_launch_failed");
    }
    const validator = v2 ? createBridgeSessionValidatorV2(binding.bridgeSessionId) : createBridgeSessionValidator(binding.bridgeSessionId);
    const listeners = new Set<(raw: unknown) => void>();
    const closedListeners = new Set<() => void>();
    let invalidLines = 0, consecutiveInvalid = 0, protocolViolation = false, discarding = false;
    const recentInvalid: number[] = [];
    const pending = new Map<() => void, number>();
    let pendingBytes = 0, sentCount = 0, stopping = false, reaped = false, exited = false;
    let failure: BridgeProcessFailure | null = null;
    let exitDiagnostic: BridgeShutdownResult["exitDiagnostic"] = null;
    const stdout = Buffer.alloc(131_072);
    let stdoutLength = 0, outcomeBytes = Buffer.alloc(0), stderrBytes = 0, outcomeEOF = false;
    let shutdownPromise: Promise<BridgeShutdownResult> | null = null;
    let closeResolve!: () => void;
    const closed = new Promise<void>((resolve) => { closeResolve = resolve; });
    function settleSends(): void { for (const cancel of [...pending.keys()]) cancel(); }
    function fail(code: BridgeProcessFailure): void {
      failure ??= code;
      // The cached ownership promise is returned by every shutdown caller and
      // awaited by application close, including failures discovered during I/O.
      void shutdown();
    }
    child.on("error", () => fail("launch_failed"));
    child.on("exit", (code, signal) => {
      exited = true; settleSends();
      if (signal !== null) failure ??= "child_failed";
      else if (code !== 0) exitDiagnostic = "nonzero_exit";
    });
    child.on("close", () => {
      reaped = true; closeResolve(); settleSends();
      // After stdout has ended, so every line the child wrote was delivered first.
      const notify = [...closedListeners]; closedListeners.clear();
      for (const listener of notify) { try { listener(); } catch { /* a listener's failure is its own */ } }
    });
    child.stdin!.on("error", () => { settleSends(); if (!stopping) fail("protocol_failed"); });
    child.stdout!.on("error", () => fail("protocol_failed"));
    child.stderr!.on("error", () => fail("protocol_failed"));
    // Drained and counted; diagnostic volume never stops capture.
    child.stderr!.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; });
    function invalidLine(): boolean {
      invalidLines += 1; consecutiveInvalid += 1; protocolViolation = true;
      const now = performance.now();
      recentInvalid.push(now);
      while (recentInvalid.length > 0 && now - recentInvalid[0]! > (options.invalidLineWindowMs ?? INVALID_LINE_WINDOW_MS)) recentInvalid.shift();
      if (consecutiveInvalid > MAX_CONSECUTIVE_INVALID_LINES || recentInvalid.length > MAX_INVALID_LINES_PER_WINDOW) { fail("protocol_failed"); return false; }
      return true;
    }
    child.stdout!.on("data", (chunk: Buffer) => {
      if (failure !== null) return;
      for (const byte of chunk) {
        if (byte !== 10) {
          if (discarding) continue;
          if (stdoutLength >= stdout.length) { discarding = true; stdoutLength = 0; if (!invalidLine()) return; continue; }
          stdout[stdoutLength++] = byte; continue;
        }
        if (discarding) { discarding = false; continue; }
        let raw: unknown, valid = false;
        try {
          raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout.subarray(0, stdoutLength)));
          valid = validator.acceptEvent(raw).ok;
        } catch { valid = false; }
        stdoutLength = 0;
        if (!valid) { if (!invalidLine()) return; continue; }
        consecutiveInvalid = 0;
        for (const listener of listeners) listener(raw);
      }
    });
    child.stdout!.on("end", () => { if (stdoutLength !== 0) fail("protocol_failed"); });
    const outcomePipe = child.stdio[3] as Readable;
    outcomePipe.on("error", () => fail("protocol_failed"));
    outcomePipe.on("data", (chunk: Buffer) => {
      if (outcomeBytes.length + chunk.length > OUTCOME_MAX_BYTES) { fail("protocol_failed"); return; }
      outcomeBytes = Buffer.concat([outcomeBytes, chunk]);
    });
    outcomePipe.on("end", () => { outcomeEOF = true; });

    async function waitUntil(deadline: number): Promise<boolean> {
      if (reaped) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([closed, new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - performance.now())); })]);
      if (timer !== undefined) clearTimeout(timer);
      return reaped;
    }
    function shutdown(): Promise<BridgeShutdownResult> {
      if (shutdownPromise) return shutdownPromise;
      stopping = true; settleSends();
      shutdownPromise = (async () => {
        child.stdin!.end();
        const cooperative = performance.now() + grace;
        if (!await waitUntil(cooperative)) {
          failure ??= "cleanup_failed";
          if (!exited) child.kill("SIGTERM");
          if (!await waitUntil(performance.now() + 1000)) {
            if (!exited) child.kill("SIGKILL");
            await waitUntil(performance.now() + 2000);
          }
        }
        let outcome: BridgeShutdownResult["outcome"] = null;
        // Tolerated while live, but an invalid control plane still blocks
        // custody clearing (private custody contract).
        if (protocolViolation) failure ??= "protocol_failed";
        if (!reaped) failure = "reap_failed";
        if (failure === null) {
          try {
            if (!outcomeEOF || outcomeBytes.length === 0) throw new Error("missing");
            if (outcomeBytes.at(-1) !== 10 || outcomeBytes.subarray(0, -1).includes(10)) throw new Error("framing");
            const parsed = decodeBridgeProcessOutcome(new TextDecoder("utf-8", { fatal: true }).decode(outcomeBytes.subarray(0, -1)));
            if (!sameCustodyBinding(binding, parsed)) throw new Error("binding");
            outcome = parsed;
          } catch { failure = outcomeBytes.length === 0 ? "outcome_missing" : "protocol_failed"; }
        }
        listeners.clear(); child.stdin!.destroy(); child.stdout!.destroy(); child.stderr!.destroy(); outcomePipe.destroy();
        if (reaped) {
          try { unlinkSync(filename); rmdirSync(directory); }
          catch { failure ??= "cleanup_failed"; outcome = null; }
        }
        return { reaped, outcome, failure, exitDiagnostic };
      })();
      return shutdownPromise;
    }
    return { shutdown, controlNoise: () => ({ invalidLines, stderrBytes }), bridge: {
      send(message) {
        if (stopping || exited || reaped) return Promise.reject(new Error("bridge_closed"));
        const bytes = Buffer.from(JSON.stringify(message) + "\n");
        if (sentCount >= 256 || bytes.length > 65_536 || pending.size >= 16 || pendingBytes + bytes.length > 65_536 ||
            message.type === "join" && message.meetingOccurrenceId !== binding.occurrenceId || !validator.acceptCommand(message).ok) return Promise.reject(new Error("bridge_control_rejected"));
        sentCount += 1; pendingBytes += bytes.length;
        return new Promise<void>((resolve, reject) => {
          const cancel = () => finish(false);
          const finish = (success: boolean) => {
            if (!pending.delete(cancel)) return;
            pendingBytes -= bytes.length;
            if (success) resolve(); else reject(new Error("bridge_closed"));
          };
          pending.set(cancel, bytes.length);
          child.stdin!.write(bytes, (error) => finish(!error));
        });
      },
      subscribe(listener) { if (stopping) return () => {}; listeners.add(listener); return () => { listeners.delete(listener); }; },
      onClosed(listener: () => void) {
        if (reaped) { queueMicrotask(listener); return () => {}; }
        closedListeners.add(listener); return () => { closedListeners.delete(listener); };
      },
    } };
  } };
}
