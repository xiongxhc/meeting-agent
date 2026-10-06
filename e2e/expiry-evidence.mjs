// Pure component-C validation. No file/process/socket/SDK operations or origin attestation.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

const SCHEMA = "runtime-media-admission-evidence/v1";
const PROFILE = "runtime-media-evidence-test-20261005";
const MAX_RECORDS = 4096, MAX_LINE = 2048, MAX_BYTES = MAX_RECORDS * MAX_LINE;
const U64 = 18446744073709551615n;
const predicateKeys = ["session_present", "credential_matches", "media_version_matches", "bridge_binding_matches",
  "credential_expired", "reconnect_expired", "active", "capture_finished"];
const provenanceKeys = ["profile", "artifactManifestSha256", "sourceManifestSha256", "patchSha256", "buildMetadataSha256",
  "erratumSha256", "reconciledAuditSha256", "base", "candidateTree", "gatewaySha256", "sdkSha256"];
const identityKeys = ["dev", "ino", "uid", "mode", "nlink", "parentDev", "parentIno", "parentUid", "parentMode"];
function refuse(code = "invalid") { throw Object.assign(new Error(`expiry_evidence_${code}`), { code: `expiry_evidence_${code}` }); }
function require(value, code) { if (!value) refuse(code); }
function exact(value, keys) {
  require(value !== null && typeof value === "object" && !Array.isArray(value), "schema");
  const actual = Object.keys(value);
  require(actual.length === keys.length && keys.every(key => Object.hasOwn(value, key)), "schema");
}
function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  require(Number.isSafeInteger(value) && value >= min && value <= max, "schema");
}
function decimal(value, nonzero = false) {
  require(typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value), "schema");
  require(BigInt(value) <= U64 && (!nonzero || value !== "0"), "schema");
}
function ipv4(host) {
  require(/^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$/.test(host), "address");
  const octets = host.split(".").map(Number); require(octets.every(n => n <= 255), "address");
  return octets;
}
// SocketAddr representation, including Rust's numeric IPv6 scope IDs. Compare
// expanded words; map scope-free IPv4-mapped IPv6 to the equivalent IPv4 endpoint.
function endpoint(value) {
  require(typeof value === "string" && value.length <= 80, "address");
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):([0-9]{1,5})$/.exec(value);
  require(match, "address");
  const port = Number(match[3]); require(port <= 65535 && String(port) === match[3], "address");
  if (match[2]) return `4/${ipv4(match[2]).join(".")}/${port}`;
  let host = match[1], scope = 0;
  if (host.includes("%")) {
    const scoped = /^([^%]+)%(0|[1-9][0-9]{0,9})$/.exec(host); require(scoped, "address");
    host = scoped[1]; scope = Number(scoped[2]); require(scope <= 4294967295, "address");
  }
  if (host.includes(".")) {
    const cut = host.lastIndexOf(":"), tail = ipv4(host.slice(cut + 1));
    host = host.slice(0, cut + 1) + ((tail[0] << 8) | tail[1]).toString(16) + ":" + ((tail[2] << 8) | tail[3]).toString(16);
  }
  require(/^[0-9a-fA-F:]+$/.test(host), "address");
  const halves = host.split("::"); require(halves.length <= 2, "address");
  const groups = part => part === "" ? [] : part.split(":").map(word => {
    require(/^[0-9a-fA-F]{1,4}$/.test(word), "address"); return parseInt(word, 16);
  });
  const left = groups(halves[0]), right = halves.length === 2 ? groups(halves[1]) : [];
  require(halves.length === 2 ? left.length + right.length < 8 : left.length === 8, "address");
  const words = [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
  if (scope === 0 && words.slice(0, 5).every(n => n === 0) && words[5] === 65535)
    return `4/${[words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join(".")}/${port}`;
  return `6/${words.join(":")}/${scope}/${port}`;
}
function context(value, attempts) {
  exact(value, ["attempt_id", "transport"]); integer(value.attempt_id, 1, MAX_RECORDS);
  require(!attempts.has(value.attempt_id), "attempt"); attempts.add(value.attempt_id);
  if (value.transport?.kind === "tcp") {
    exact(value.transport, ["kind", "peer", "local"]); endpoint(value.transport.peer); endpoint(value.transport.local);
  } else { exact(value.transport, ["kind"]); require(value.transport.kind === "component", "schema"); }
}
function validateRecords(records, complete) {
  require(Array.isArray(records) && records.length > 0 && records.length <= MAX_RECORDS, "records");
  const attempts = new Set(), instance = records[0]?.instance;
  require(typeof instance === "string" && /^[0-9a-f]{32}$/.test(instance), "instance");
  for (const [index, row] of records.entries()) {
    require(row?.schema === SCHEMA && row.instance === instance, "instance");
    integer(row.sequence, 0, MAX_RECORDS - 1); require(row.sequence === index, "sequence");
    const base = ["schema", "instance", "sequence", "type"];
    if (row.type === "header") { exact(row, base); require(index === 0, "records"); }
    else if (row.type === "admission") {
      exact(row, [...base, "session_id", "reservation_epoch", "connection_id", "accepted", "context", "predicates"]);
      decimal(row.session_id); decimal(row.reservation_epoch, true); context(row.context, attempts);
      exact(row.predicates, predicateKeys); require(predicateKeys.every(key => typeof row.predicates[key] === "boolean"), "schema");
      require(typeof row.accepted === "boolean" && row.predicates.session_present, "decision");
      const p = row.predicates;
      const admissible = p.credential_matches && p.media_version_matches && p.bridge_binding_matches &&
        !p.credential_expired && !p.reconnect_expired && !p.active && !p.capture_finished;
      require(row.accepted === admissible, "decision");
      if (row.accepted) decimal(row.connection_id, true); else require(row.connection_id === null, "decision");
    } else if (row.type === "missing_session") {
      exact(row, [...base, "session_id", "session_present", "context"]); decimal(row.session_id);
      require(row.session_present === false, "decision"); context(row.context, attempts);
    } else if (row.type === "fence_release") {
      exact(row, [...base, "session_id", "reservation_epoch", "connection_id"]);
      decimal(row.session_id); decimal(row.reservation_epoch, true); decimal(row.connection_id, true);
    } else if (row.type === "completion") {
      exact(row, [...base, "record_count", "loss", "writer_error"]); integer(row.record_count, 2, MAX_RECORDS);
      require(index === records.length - 1 && row.record_count === records.length && row.loss === false && row.writer_error === false, "completion");
    } else refuse("schema");
    require(index !== 0 || row.type === "header", "records");
  }
  const finished = records.at(-1).type === "completion";
  require(!complete || finished, "incomplete");
  return finished;
}

/** Strict producer-compatible compact ASCII JSONL, original bytes only.
 * Tail mode discards no terminated record, and retains only an unfinished
 * bounded final line. Even a final completion is unusable with partial bytes. */
export function parseExpiryEvidence(bytes, { complete = true } = {}) {
  require(bytes instanceof Uint8Array && bytes.byteLength <= MAX_BYTES, "bounds");
  require(typeof complete === "boolean", "schema");
  // Decode the entire input, including unfinished tails, with no replacement.
  try { new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { refuse("encoding"); }
  require(bytes.every(byte => byte <= 127), "encoding");
  const records = []; let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 10) continue;
    require(i + 1 - start <= MAX_LINE && i > start && records.length < MAX_RECORDS, "bounds");
    const line = Buffer.from(bytes.subarray(start, i)).toString("ascii"); let row;
    try { row = JSON.parse(line); } catch { refuse("schema"); }
    require(JSON.stringify(row) === line, "grammar"); records.push(row); start = i + 1;
  }
  const pendingBytes = bytes.length - start;
  require(pendingBytes < MAX_LINE && (!complete || pendingBytes === 0), "incomplete");
  if (!complete && records.length === 0) return { records, complete: false, pendingBytes };
  const finished = validateRecords(records, complete);
  require(!finished || pendingBytes === 0, "completion");
  return { records, complete: complete && finished, pendingBytes };
}

/** Scheduling only: this result never substitutes for full final validation. */
export function selectReleasedAdmission(records, { sessionId }) {
  decimal(sessionId);
  if (Array.isArray(records) && records.length === 0) return { status: "pending", code: "expiry_evidence_acceptance_pending" };
  validateRecords(records, false);
  const accepted = records.filter(row => row.type === "admission" && row.session_id === sessionId && row.accepted);
  require(accepted.length <= 1, "ambiguous");
  if (accepted.length === 0) return { status: "pending", code: "expiry_evidence_acceptance_pending" };
  const acceptance = accepted[0]; require(acceptance.context.transport.kind === "tcp", "transport");
  const releases = records.filter(row => row.type === "fence_release" && row.session_id === sessionId);
  require(releases.length <= 1, "ambiguous");
  if (releases.length === 0) return { status: "pending", code: "expiry_evidence_release_pending" };
  const release = releases[0];
  require(release.reservation_epoch === acceptance.reservation_epoch && release.connection_id === acceptance.connection_id &&
    release.sequence > acceptance.sequence, "chain");
  return { status: "released", acceptance, release };
}
function provenance(value) {
  exact(value, provenanceKeys); require(value.profile === PROFILE, "profile");
  for (const key of provenanceKeys.filter(key => !["profile", "base", "candidateTree"].includes(key)))
    require(typeof value[key] === "string" && /^[0-9a-f]{64}$/.test(value[key]), "provenance");
  for (const key of ["base", "candidateTree"]) require(typeof value[key] === "string" && /^[0-9a-f]{40}$/.test(value[key]), "provenance");
}
function same(a, b, keys, code) { require(keys.every(key => a[key] === b[key]), code); }
function identity(value) {
  exact(value, identityKeys);
  for (const key of ["dev", "ino", "parentDev", "parentIno"]) decimal(value[key]);
  integer(value.uid); integer(value.parentUid);
  require(value.uid === value.parentUid && value.mode === 0o600 && value.nlink === 1 && value.parentMode === 0o700, "identity");
}
function nativeProof(value) {
  exact(value, ["recordedSamples", "recordedFrames", "emittedSamples", "prefixComplete", "pages", "drain", "nativeCleanup",
    "custody", "timingCoverage", "timingWarnings", "scope"]);
  decimal(value.recordedSamples, true); require(BigInt(value.recordedSamples) <= 86537n, "native");
  integer(value.recordedFrames, 1, 181); integer(value.pages, 1, 32);
  require(value.emittedSamples === 86537 && value.prefixComplete === (value.recordedSamples === "86537") &&
    value.drain === "unconfirmed" && value.nativeCleanup === "confirmed" && value.custody === "departure_confirmed" &&
    value.scope === "component_only_failure_oracle", "native");
  require(Array.isArray(value.timingWarnings) && value.timingWarnings.length <= 16 &&
    new Set(value.timingWarnings).size === value.timingWarnings.length, "native");
  const allowed = ["capture_alignment_missing", "missing_timing", "wall_alignment_missing", "missing_clock_pair", "local_wall_timestamp_estimate"];
  require(value.timingWarnings.every(warning => allowed.includes(warning)), "native");
  require(value.timingCoverage === (value.timingWarnings.some(warning => warning !== "local_wall_timestamp_estimate") ? "partial" : "available"), "native");
}
function validate(input) {
  exact(input, ["journal", "sessionId", "expectedProvenance", "receipt", "journalIdentity", "probe", "ordering", "nativeLifecycle", "nativeProof", "cleanup"]);
  const parsed = parseExpiryEvidence(input.journal), records = parsed.records;
  decimal(input.sessionId); provenance(input.expectedProvenance);
  const receipt = input.receipt;
  exact(receipt, ["schema", "provenance", "gatewayPid", "spawnObserved", "exitCode", "signal", "pipesClosed", "observerFailure",
    "binaryBeforeSha256", "binaryAfterSha256", "journalOpenedIdentity", "journalFinalIdentity", "journalOpenedSize", "journalFinalSize",
    "journalSha256", "instance", "completion"]);
  require(receipt.schema === "meeting-expiry-ownership/v1", "schema"); provenance(receipt.provenance);
  same(receipt.provenance, input.expectedProvenance, provenanceKeys, "provenance");
  integer(receipt.gatewayPid, 1);
  require(receipt.spawnObserved === true && receipt.exitCode === 0 && receipt.signal === null && receipt.pipesClosed === true &&
    receipt.observerFailure === null, "process");
  require(receipt.binaryBeforeSha256 === input.expectedProvenance.gatewaySha256 &&
    receipt.binaryAfterSha256 === input.expectedProvenance.gatewaySha256, "provenance");
  identity(receipt.journalOpenedIdentity); identity(receipt.journalFinalIdentity); identity(input.journalIdentity);
  same(receipt.journalOpenedIdentity, receipt.journalFinalIdentity, identityKeys, "identity");
  same(input.journalIdentity, receipt.journalFinalIdentity, identityKeys, "identity");
  integer(receipt.journalOpenedSize, 0, MAX_BYTES); integer(receipt.journalFinalSize, 0, MAX_BYTES);
  require(receipt.journalOpenedSize <= receipt.journalFinalSize && receipt.journalFinalSize === input.journal.byteLength &&
    receipt.journalSha256 === createHash("sha256").update(input.journal).digest("hex") && receipt.instance === records[0].instance, "identity");
  exact(receipt.completion, ["recordCount", "loss", "writerError"]);
  require(receipt.completion.recordCount === records.length && receipt.completion.loss === false && receipt.completion.writerError === false, "completion");
  // All final integration records must be TCP; component fixtures cannot hide
  // even as unrelated records. Every release must refer to a preceding unique acceptance.
  const accepted = new Map(), released = new Set();
  for (const row of records) {
    if (row.context) require(row.context.transport.kind === "tcp", "transport");
    const key = `${row.session_id}/${row.reservation_epoch}/${row.connection_id}`;
    if (row.type === "admission" && row.accepted) { require(!accepted.has(key), "chain"); accepted.set(key, row); }
    if (row.type === "fence_release") {
      require(accepted.has(key) && accepted.get(key).sequence < row.sequence && !released.has(key), "chain"); released.add(key);
    }
  }
  const selected = selectReleasedAdmission(records, { sessionId: input.sessionId }); require(selected.status === "released", "incomplete");
  const { acceptance, release } = selected;
  require(!records.some(row => row.type === "missing_session" && row.session_id === input.sessionId), "chain");
  exact(input.probe, ["local", "remote", "connected", "writeCompleted", "receivedBytes", "orderlyEnd", "error", "timedOut"]);
  const probe = input.probe;
  require(probe.connected === true && probe.writeCompleted === true && probe.receivedBytes === 0 && probe.orderlyEnd === true &&
    probe.error === null && probe.timedOut === false, "probe");
  const local = endpoint(probe.local), remote = endpoint(probe.remote);
  const matching = records.filter(row => ["admission", "missing_session"].includes(row.type) && row.context.transport.kind === "tcp" &&
    endpoint(row.context.transport.peer) === local && endpoint(row.context.transport.local) === remote);
  require(matching.length === 1, "ambiguous"); const rejection = matching[0];
  require(rejection.type === "admission" && rejection.session_id === input.sessionId && rejection.reservation_epoch === acceptance.reservation_epoch &&
    !rejection.accepted && rejection.connection_id === null && release.sequence < rejection.sequence, "chain");
  for (const key of predicateKeys) require(rejection.predicates[key] ===
    ["session_present", "credential_matches", "media_version_matches", "bridge_binding_matches", "credential_expired"].includes(key), "cause");
  exact(input.ordering, ["releaseObserved", "probeStarted", "probeSettled", "firstTeardown", "releaseInstance", "releaseSequence"]);
  const order = input.ordering;
  for (const key of ["releaseObserved", "probeStarted", "probeSettled", "firstTeardown"]) integer(order[key], 1);
  require(order.releaseObserved < order.probeStarted && order.probeStarted < order.probeSettled && order.probeSettled < order.firstTeardown &&
    order.releaseInstance === release.instance && order.releaseSequence === release.sequence, "ordering");
  exact(input.nativeLifecycle, ["sessionId", "connected", "faultDisconnected", "terminalDisconnected", "reconnecting", "reconnected"]);
  require(input.nativeLifecycle.sessionId === input.sessionId && input.nativeLifecycle.connected === 1 &&
    input.nativeLifecycle.faultDisconnected === 1 && input.nativeLifecycle.terminalDisconnected === 1 &&
    input.nativeLifecycle.reconnecting === 0 && input.nativeLifecycle.reconnected === 0, "native"); nativeProof(input.nativeProof);
  exact(input.cleanup, ["sdkTransportClosed", "runtimeClosed", "providerClosed", "nativeChildReaped", "nativeChildFailure"]);
  require(input.cleanup.sdkTransportClosed === true && input.cleanup.runtimeClosed === true && input.cleanup.providerClosed === true &&
    input.cleanup.nativeChildReaped === true && input.cleanup.nativeChildFailure === null, "cleanup");
  return { ok: true, proof: { scope: "instrumented_test_candidate", profile: PROFILE, instance: release.instance,
    sessionId: input.sessionId, reservationEpoch: acceptance.reservation_epoch, connectionId: acceptance.connection_id,
    acceptanceSequence: acceptance.sequence, releaseSequence: release.sequence, rejectionSequence: rejection.sequence,
    acceptanceAttemptId: acceptance.context.attempt_id, rejectionAttemptId: rejection.context.attempt_id,
    journalSha256: receipt.journalSha256, ...input.expectedProvenance } };
}

/** Safe refusal only; supplied private facts are validated, never attested.
 * Real controller must first execute the existing native failure oracle. */
export function validateExpiryEvidence(input) {
  try { return validate(input); }
  catch (error) {
    const allowed = ["invalid", "schema", "bounds", "encoding", "grammar", "records", "instance", "sequence", "attempt", "address",
      "decision", "completion", "incomplete", "ambiguous", "chain", "transport", "profile", "provenance", "identity", "process", "probe", "cause", "ordering", "native", "cleanup"];
    const code = allowed.map(name => `expiry_evidence_${name}`).includes(error?.code) ? error.code : "expiry_evidence_invalid";
    return { ok: false, code };
  }
}
