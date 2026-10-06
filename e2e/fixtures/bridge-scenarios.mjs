import { Buffer } from "node:buffer";
import fs from "node:fs";
import timers from "node:timers";

const bindingKeys = ["physicalClientId", "physicalGenerationId", "occurrenceId", "bridgeSessionId"];
const modes = ["normal", "missing", "invalid", "stale_generation", "nonzero_exit", "held"];
function exactObject(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function parsePhysicalOutcomeScenario(value) {
  if (value === undefined) value = { schema: "e2e-bridge-physical-outcome/v1", mode: "normal" };
  if (!exactObject(value, ["schema", "mode"]) || value.schema !== "e2e-bridge-physical-outcome/v1" || !modes.includes(value.mode)) {
    throw new Error("invalid_physical_outcome_scenario");
  }
  return Object.freeze({ schema: value.schema, mode: value.mode });
}
function validClose(command) {
  return exactObject(command, ["schema", "binding", "action"]) && command.schema === "e2e-bridge-physical-outcome-close/v1" &&
    ["emit", "omit"].includes(command.action) && exactObject(command.binding, bindingKeys) && bindingKeys.every(key => typeof command.binding[key] === "string");
}

// Even a regular-file-to-FIFO replacement cannot block open. Verify the owned
// descriptor and identity before any read, and bound reads if the file grows.
export function readPhysicalOutcomeClose(filename) {
  let before;
  try { before = fs.lstatSync(filename); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("physical_outcome_control_read_failed");
  }
  try {
    if (!before.isFile() || before.size > 16 * 1024) throw new Error();
    let fd;
    try {
      fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > 16 * 1024) throw new Error();
      const bytes = Buffer.alloc(16 * 1024 + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = fs.readSync(fd, bytes, length, bytes.length - length, length);
        if (count === 0) break;
        length += count;
      }
      const after = fs.lstatSync(filename), final = fs.fstatSync(fd);
      if (length > 16 * 1024 || final.size > 16 * 1024 || !after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino) throw new Error();
      const command = JSON.parse(bytes.subarray(0, length).toString("utf8"));
      if (!validClose(command)) throw new Error();
      return command;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  } catch { throw new Error("physical_outcome_control_read_failed"); }
}

// The parent already validated custody. Preserve that binding, including its
// key order, independently of scenario serialization or mutable child state.
export function createPhysicalOutcomeEmitter({ binding, scenario, write, close, now = () => new Date().toISOString(), onState = () => {} }) {
  const selected = parsePhysicalOutcomeScenario(scenario);
  if (!exactObject(binding, bindingKeys) || bindingKeys.some(key => typeof binding[key] !== "string")) throw new Error("invalid_physical_outcome_binding");
  const expected = Object.freeze(Object.fromEntries(bindingKeys.map(key => [key, binding[key]])));
  let started = false, terminal = false, held = false, closed = false, timer = null, observation;
  let resolve, reject;
  const completion = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  function closeOnce() {
    if (closed) return;
    closed = true;
    close();
  }
  function settle(emit, cause, failure) {
    if (terminal) return;
    terminal = true; held = false;
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    try {
      if (failure) throw failure;
      if (emit) {
        const outcome = observation.left !== null
          ? { outcome: "departure_confirmed", reason: "departure_observed" }
          : observation.joined ? { outcome: "departure_unconfirmed", reason: "departure_not_observed" }
            : { outcome: "no_join_action", reason: "join_not_issued" };
        const serialized = { ...expected };
        if (selected.mode === "stale_generation") serialized.physicalGenerationId = (expected.physicalGenerationId[0] === "0" ? "1" : "0") + expected.physicalGenerationId.slice(1);
        const bytes = Buffer.from(selected.mode === "invalid" ? '{"schema":"bridge-process-outcome/v1"}\n'
          : `${JSON.stringify({ schema: "bridge-process-outcome/v1", ...serialized, ...outcome, observedAt: now() })}\n`);
        if (write(bytes) !== bytes.length) throw new Error();
      }
      closeOnce();
      const phase = emit ? "emitted" : "closed_missing";
      onState({ mode: selected.mode, phase, ...(cause ? { cause } : {}) });
      resolve({ exitCode: selected.mode === "nonzero_exit" ? 2 : 0, phase });
    } catch {
      try { closeOnce(); } catch { /* one close attempt only */ }
      const code = failure ? "invalid_physical_outcome_close" : "physical_outcome_io_failed";
      try { onState({ mode: selected.mode, phase: "failed", cause: code }); } catch { /* bounded failure remains authoritative */ }
      reject(new Error(code));
    }
  }
  return {
    finish({ joined, left }) {
      if (started || terminal) return completion;
      started = true; observation = { joined, left };
      if (selected.mode !== "held") settle(selected.mode !== "missing");
      else {
        held = true;
        timer = timers.setTimeout(() => settle(false, "hold_timeout"), 1000);
        try { onState({ mode: selected.mode, phase: "held", binding: { ...expected } }); }
        catch { settle(false, null, new Error()); }
      }
      return completion;
    },
    closeWith(command) {
      if (!held || terminal) throw new Error("physical_outcome_not_held");
      if (!validClose(command) || bindingKeys.some(key => command.binding[key] !== expected[key])) {
        settle(false, null, new Error());
        throw new Error("invalid_physical_outcome_close");
      }
      settle(command.action === "emit", command.action === "omit" ? "controlled_omit" : undefined);
    },
    dispose() { settle(false, "disposed"); },
  };
}
