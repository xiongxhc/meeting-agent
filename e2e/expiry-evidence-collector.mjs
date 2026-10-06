// Private TEST collector. Process-origin custody, not cryptographic attestation.
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";
import { parseExpiryEvidence } from "./expiry-evidence.mjs";

const MAX_BYTES = 4096 * 2048, MAX_PRIVATE_BYTES = 16384;
const packageKeys = ["artifactManifest", "sourceManifest", "patch", "buildMetadata", "erratum", "reconciledAudit"];
const provenanceKeys = ["profile", ...packageKeys.map(key => `${key}Sha256`), "base", "candidateTree", "gatewaySha256", "sdkSha256"];
const identityKeys = ["dev", "ino", "uid", "mode", "nlink", "parentDev", "parentIno", "parentUid", "parentMode"];
const receiptKeys = ["schema", "provenance", "gatewayPid", "spawnObserved", "exitCode", "signal", "pipesClosed", "observerFailure",
  "binaryBeforeSha256", "binaryAfterSha256", "journalOpenedIdentity", "journalFinalIdentity", "journalOpenedSize", "journalFinalSize",
  "journalSha256", "instance", "completion"];
const codes = ["descriptor", "path", "identity", "bounds", "file", "journal", "receipt", "provenance", "process", "observer", "state"];
function refuse(code) { throw Object.assign(new Error(`expiry_collector_${code}`), { code: `expiry_collector_${code}` }); }
function require(value, code) { if (!value) refuse(code); }
function safe(error, fallback) { return codes.some(code => error?.code === `expiry_collector_${code}`) ? error : Object.assign(new Error(`expiry_collector_${fallback}`), { code: `expiry_collector_${fallback}` }); }
function guarded(fn, fallback) { try { return fn(); } catch (error) { throw safe(error, fallback); } }
function exact(value, keys, code) { require(value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), code); }
function same(a, b, keys) { return keys.every(key => a[key] === b[key]); }
function statIdentity(stat) { return { dev: String(stat.dev), ino: String(stat.ino), uid: Number(stat.uid), mode: Number(stat.mode & 0o7777n), nlink: Number(stat.nlink) }; }
function assertPath(file) {
  require(typeof file === "string" && file.length > 1 && file.length <= 4096 && path.isAbsolute(file) && path.normalize(file) === file && !file.includes("\0"), "path");
  let cursor = path.parse(file).root;
  for (const piece of file.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, piece); const stat = lstatSync(cursor, { bigint: true });
    require(!stat.isSymbolicLink(), "path");
    if (cursor !== file) require(stat.isDirectory(), "path");
  }
}
function absent(file) {
  try { lstatSync(file); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  refuse("state");
}
function openRegular(file, { owner, mode, maxBytes }) {
  assertPath(file);
  function check(stat) {
    require(stat.isFile() && stat.nlink === 1n && (owner === undefined || stat.uid === BigInt(owner)) &&
      (mode === undefined || (stat.mode & 0o7777n) === BigInt(mode)), "identity");
    require(stat.size <= BigInt(maxBytes), "bounds");
  }
  const before = lstatSync(file, { bigint: true }); check(before);
  // Precheck avoids opening existing special files; NONBLOCK also prevents a
  // regular-to-FIFO race from blocking before the held/named identity checks.
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true }), named = lstatSync(file, { bigint: true });
    for (const value of [stat, named]) {
      check(value); require(same(statIdentity(value), statIdentity(before), ["dev", "ino", "uid", "mode", "nlink"]), "identity");
    }
    // Append growth is legitimate; replacement and observed regression are not.
    require(stat.size >= before.size && named.size >= stat.size, "identity");
    return { fd, stat, identity: statIdentity(stat) };
  } catch (error) { closeSync(fd); throw error; }
}
function bytesAt(fd, size) {
  const bytes = Buffer.alloc(size); let offset = 0;
  while (offset < size) { const read = readSync(fd, bytes, offset, size - offset, offset); require(read > 0, "file"); offset += read; }
  return bytes;
}
function privateJson(file, owner, code) {
  return guarded(() => {
    const opened = openRegular(file, { owner, mode: 0o600, maxBytes: MAX_PRIVATE_BYTES });
    try {
      const bytes = bytesAt(opened.fd, Number(opened.stat.size));
      const after = fstatSync(opened.fd, { bigint: true });
      require(same(statIdentity(after), opened.identity, ["dev", "ino", "uid", "mode", "nlink"]) && after.size === opened.stat.size, "identity");
      assertPath(file); const named = lstatSync(file, { bigint: true });
      require(same(statIdentity(named), opened.identity, ["dev", "ino", "uid", "mode", "nlink"]) && named.size === opened.stat.size, "identity");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); const value = JSON.parse(text);
      require(JSON.stringify(value) === text, code); return { value, identity: opened.identity, sha256: hash(bytes) };
    } finally { closeSync(opened.fd); }
  }, code);
}
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function hashFile(file, owner, mode, maxBytes) {
  const opened = openRegular(file, { owner, mode, maxBytes });
  try {
    const hasher = createHash("sha256"), buffer = Buffer.alloc(65536); let offset = 0;
    while (offset < Number(opened.stat.size)) {
      const read = readSync(opened.fd, buffer, 0, Math.min(buffer.length, Number(opened.stat.size) - offset), offset);
      require(read > 0, "file"); hasher.update(buffer.subarray(0, read)); offset += read;
    }
    const after = fstatSync(opened.fd, { bigint: true });
    require(same(statIdentity(after), opened.identity, ["dev", "ino", "uid", "mode", "nlink"]) && after.size === opened.stat.size, "identity");
    assertPath(file); const named = lstatSync(file, { bigint: true });
    require(same(statIdentity(named), opened.identity, ["dev", "ino", "uid", "mode", "nlink"]) && named.size === opened.stat.size, "identity");
    return { sha256: hasher.digest("hex"), identity: opened.identity };
  } finally { closeSync(opened.fd); }
}
function provenance(value) {
  exact(value, provenanceKeys, "provenance"); require(value.profile === "runtime-media-evidence-test-20261005", "provenance");
  for (const key of provenanceKeys) {
    if (key === "profile") continue;
    require(typeof value[key] === "string" && (key === "base" || key === "candidateTree" ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/).test(value[key]), "provenance");
  }
}
function context(descriptorPath) {
  return guarded(() => {
    assertPath(descriptorPath);
    const root = path.dirname(descriptorPath), rootFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const parent = fstatSync(rootFd, { bigint: true });
      require(parent.isDirectory() && parent.uid === BigInt(process.getuid()) && (parent.mode & 0o7777n) === 0o700n, "identity");
      const descriptor = privateJson(descriptorPath, Number(parent.uid), "descriptor"), value = descriptor.value;
      exact(value, ["schema", "privateRoot", "journalPath", "receiptPath", "gatewayPath", "sdkPath", "packagePaths", "expectedProvenance"], "descriptor");
      require(value.schema === "meeting-expiry-collector/v1" && value.privateRoot === root, "descriptor");
      for (const key of ["journalPath", "receiptPath", "gatewayPath", "sdkPath"]) require(typeof value[key] === "string" && path.dirname(value[key]) === root && path.normalize(value[key]) === value[key] && !value[key].includes("\0"), "path");
      exact(value.packagePaths, packageKeys, "descriptor"); provenance(value.expectedProvenance);
      const paths = [descriptorPath, ...["journalPath", "receiptPath", "gatewayPath", "sdkPath"].map(key => value[key]), ...Object.values(value.packagePaths)];
      require(new Set(paths).size === paths.length, "path");
      const fingerprints = new Map();
      function checkParent() {
        assertPath(root); const named = lstatSync(root, { bigint: true }), held = fstatSync(rootFd, { bigint: true });
        require(named.isDirectory() && held.isDirectory() && [named, held].every(stat => stat.dev === parent.dev && stat.ino === parent.ino && stat.uid === parent.uid && (stat.mode & 0o7777n) === 0o700n), "identity");
        const now = privateJson(descriptorPath, Number(parent.uid), "descriptor");
        require(same(now.identity, descriptor.identity, ["dev", "ino", "uid", "mode", "nlink"]) && now.sha256 === descriptor.sha256, "descriptor");
      }
      function verifyArtifacts() {
        checkParent();
        for (const [key, file, owner, mode, max] of [
          ["gateway", value.gatewayPath, Number(parent.uid), 0o700, 128 * 1024 * 1024],
          ["sdk", value.sdkPath, Number(parent.uid), undefined, 32 * 1024 * 1024],
          ...packageKeys.map(key => [key, value.packagePaths[key], undefined, undefined, 16 * 1024 * 1024]),
        ]) {
          const actual = hashFile(file, owner, mode, max);
          require(actual.sha256 === value.expectedProvenance[`${key}Sha256`], "provenance");
          if (fingerprints.has(key)) require(same(actual.identity, fingerprints.get(key), ["dev", "ino", "uid", "mode", "nlink"]), "identity");
          else fingerprints.set(key, actual.identity);
        }
        return value.expectedProvenance.gatewaySha256;
      }
      // Hide the descriptor object inside the closure; callers cannot rewrite its authority.
      verifyArtifacts(); return { value, parent, checkParent, verifyArtifacts, syncParent: () => fsyncSync(rootFd), close: () => closeSync(rootFd) };
    } catch (error) { closeSync(rootFd); throw error; }
  }, "descriptor");
}
function journalReader(ctx) {
  let opened, openedIdentity, openedSize, previous = Buffer.alloc(0), closed = false, failure;
  function read(complete) {
    if (failure) throw failure;
    try {
      require(!closed, "state"); ctx.checkParent();
      if (!opened) {
        try { lstatSync(ctx.value.journalPath); } catch (error) {
          if (error.code === "ENOENT" && !complete) return { status: "pending", parsed: { records: [], complete: false, pendingBytes: 0 } };
          throw error;
        }
        opened = openRegular(ctx.value.journalPath, { owner: Number(ctx.parent.uid), mode: 0o600, maxBytes: MAX_BYTES });
        openedSize = Number(opened.stat.size);
        openedIdentity = { ...opened.identity, parentDev: String(ctx.parent.dev), parentIno: String(ctx.parent.ino), parentUid: Number(ctx.parent.uid), parentMode: 0o700 };
      }
      assertPath(ctx.value.journalPath);
      const held = fstatSync(opened.fd, { bigint: true }), named = lstatSync(ctx.value.journalPath, { bigint: true });
      require(held.isFile() && named.isFile() && same(statIdentity(held), openedIdentity, ["dev", "ino", "uid", "mode", "nlink"]) && same(statIdentity(named), openedIdentity, ["dev", "ino", "uid", "mode", "nlink"]), "identity");
      require(held.size <= BigInt(MAX_BYTES), "bounds"); require(held.size >= BigInt(previous.length) && held.size >= BigInt(openedSize), "identity");
      const bytes = bytesAt(opened.fd, Number(held.size));
      require(bytes.subarray(0, previous.length).equals(previous), "identity");
      const after = fstatSync(opened.fd, { bigint: true });
      require(after.size >= held.size && after.size <= BigInt(MAX_BYTES) && (!complete || after.size === held.size) && same(statIdentity(after), openedIdentity, ["dev", "ino", "uid", "mode", "nlink"]), "identity");
      ctx.checkParent(); const finalNamed = lstatSync(ctx.value.journalPath, { bigint: true });
      require(same(statIdentity(finalNamed), openedIdentity, ["dev", "ino", "uid", "mode", "nlink"]) && finalNamed.size >= held.size && (!complete || finalNamed.size === held.size), "identity");
      const parsed = guarded(() => parseExpiryEvidence(bytes, { complete }), "journal"); previous = bytes;
      return { status: "available", journal: bytes, parsed, journalIdentity: { ...openedIdentity }, journalOpenedIdentity: { ...openedIdentity }, journalOpenedSize: openedSize };
    } catch (error) { failure = safe(error, "journal"); throw failure; }
  }
  return { read, close() { if (!closed) { closed = true; if (opened) closeSync(opened.fd); } } };
}
function validateReceipt(receipt, ctx, final) {
  exact(receipt, receiptKeys, "receipt"); provenance(receipt.provenance);
  require(receipt.schema === "meeting-expiry-ownership/v1" && same(receipt.provenance, ctx.value.expectedProvenance, provenanceKeys), "receipt");
  require(Number.isSafeInteger(receipt.gatewayPid) && receipt.gatewayPid > 0 && receipt.spawnObserved === true && receipt.exitCode === 0 && receipt.signal === null && receipt.pipesClosed === true && receipt.observerFailure === null, "process");
  require(receipt.binaryBeforeSha256 === ctx.value.expectedProvenance.gatewaySha256 && receipt.binaryAfterSha256 === ctx.value.expectedProvenance.gatewaySha256, "provenance");
  for (const identity of [receipt.journalOpenedIdentity, receipt.journalFinalIdentity]) { exact(identity, identityKeys, "receipt"); require(same(identity, final.journalIdentity, identityKeys), "identity"); }
  require(Number.isSafeInteger(receipt.journalOpenedSize) && receipt.journalOpenedSize >= 0 && receipt.journalOpenedSize <= final.journal.length && receipt.journalFinalSize === final.journal.length && receipt.journalSha256 === hash(final.journal) && receipt.instance === final.parsed.records[0].instance, "receipt");
  exact(receipt.completion, ["recordCount", "loss", "writerError"], "receipt");
  require(receipt.completion.recordCount === final.parsed.records.length && receipt.completion.loss === false && receipt.completion.writerError === false, "receipt");
}

/** Raw filesystem consistency only, never observer-lifecycle authorization.
 * A post-publication failure can leave readable final bytes if cleanup also fails.
 * Controller MUST independently require its actual owned observer close 0/no signal.
 * Finite calls only. Controller owns its existing deadline and observer wait.
 * Before launch readTail may be pending; neither reader nor collector creates journal. */
export function createExpiryEvidenceReader(descriptorPath) {
  const ctx = context(descriptorPath), reader = journalReader(ctx); let closed = false;
  return {
    readTail: () => reader.read(false),
    readFinal: () => guarded(() => {
      ctx.verifyArtifacts(); const final = reader.read(true);
      const receipt = privateJson(ctx.value.receiptPath, Number(ctx.parent.uid), "receipt").value;
      validateReceipt(receipt, ctx, final); ctx.verifyArtifacts();
      return { journal: final.journal, journalIdentity: final.journalIdentity, receipt };
    }, "receipt"),
    close() { if (!closed) { closed = true; reader.close(); ctx.close(); } },
  };
}

/** Owns the actual ChildProcess; callers cannot supply spawn/exit/reaped facts.
 * complete() must follow observed close, after observer forwarding/decoding checks. */
export function createExpiryEvidenceCollector(descriptorPath, { gatewayPath } = {}) {
  const ctx = context(descriptorPath), reader = journalReader(ctx);
  try { require(gatewayPath === undefined || gatewayPath === ctx.value.gatewayPath, "descriptor"); absent(ctx.value.journalPath); absent(ctx.value.receiptPath); } catch (error) { reader.close(); ctx.close(); throw safe(error, "state"); }
  let child, spawnObserved = false, closedEvent, failed = false, completed = false, closed = false;
  const pipes = new Set(); let resolveClosed;
  const closedPromise = new Promise(resolve => { resolveClosed = resolve; });
  function settleClosed() { if (closedEvent && pipes.size === 3) resolveClosed(); }
  return {
    spawn(args, { env = {}, cwd = ctx.value.privateRoot } = {}) {
      require(!child && !closed && !completed && Array.isArray(args) && args.every(arg => typeof arg === "string"), "state");
      guarded(() => { ctx.verifyArtifacts(); absent(ctx.value.journalPath); absent(ctx.value.receiptPath); }, "provenance");
      child = spawn(ctx.value.gatewayPath, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...env, RUNTIME_MEDIA_ADMISSION_EVIDENCE_PATH: ctx.value.journalPath } });
      child.once("spawn", () => { spawnObserved = true; }); child.on("error", () => { failed = true; });
      for (const [index, stream] of child.stdio.entries()) { stream.once("close", () => { pipes.add(index); settleClosed(); }); stream.on("error", () => { failed = true; }); }
      child.once("close", (code, signal) => {
        closedEvent = { code, signal };
        // Node may emit child close before the parent's writable stdin close.
        // The child has exited; close our owned pipe and observe its actual close.
        child.stdin.destroy(); settleClosed();
      });
      return child;
    },
    whenClosed() { require(child && !closed, "state"); return closedPromise; },
    readTail: () => reader.read(false),
    fail() { failed = true; },
    complete() {
      let createdReceipt, pendingPath, receiptFd, published = false;
      try {
        require(!closed && !completed, "state"); completed = true;
        require(child && spawnObserved && closedEvent && closedEvent.code === 0 && closedEvent.signal === null && pipes.size === 3, "process");
        require(!failed, "observer"); const final = reader.read(true); const binaryAfterSha256 = ctx.verifyArtifacts();
        const completion = final.parsed.records.at(-1);
        const receipt = { schema: "meeting-expiry-ownership/v1", provenance: { ...ctx.value.expectedProvenance }, gatewayPid: child.pid,
          spawnObserved, exitCode: closedEvent.code, signal: closedEvent.signal, pipesClosed: true, observerFailure: null,
          binaryBeforeSha256: ctx.value.expectedProvenance.gatewaySha256, binaryAfterSha256,
          journalOpenedIdentity: final.journalOpenedIdentity, journalFinalIdentity: final.journalIdentity,
          journalOpenedSize: final.journalOpenedSize, journalFinalSize: final.journal.length, journalSha256: hash(final.journal), instance: final.parsed.records[0].instance,
          completion: { recordCount: completion.record_count, loss: completion.loss, writerError: completion.writer_error } };
        validateReceipt(receipt, ctx, final); ctx.checkParent();
        const bytes = Buffer.from(JSON.stringify(receipt)); require(bytes.length <= MAX_PRIVATE_BYTES, "bounds");
        pendingPath = path.join(ctx.value.privateRoot, `.expiry-receipt-pending-${randomBytes(16).toString("hex")}`);
        require(![descriptorPath, ...["journalPath", "receiptPath", "gatewayPath", "sdkPath"].map(key => ctx.value[key]), ...Object.values(ctx.value.packagePaths)].includes(pendingPath), "path");
        receiptFd = openSync(pendingPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        createdReceipt = statIdentity(fstatSync(receiptFd, { bigint: true }));
        function checkOwned(file, links, size) {
          assertPath(file);
          for (const stat of [fstatSync(receiptFd, { bigint: true }), lstatSync(file, { bigint: true })]) {
            require(stat.isFile() && same(statIdentity(stat), createdReceipt, ["dev", "ino", "uid"]) && stat.uid === ctx.parent.uid &&
              (stat.mode & 0o7777n) === 0o600n && stat.nlink === BigInt(links) && stat.size === BigInt(size), "identity");
          }
        }
        fchmodSync(receiptFd, 0o600); checkOwned(pendingPath, 1, 0);
        let offset = 0;
        while (offset < bytes.length) { const written = writeSync(receiptFd, bytes, offset, bytes.length - offset); require(written > 0, "receipt"); offset += written; }
        // No authoritative final name exists until complete payload sync succeeds.
        fsyncSync(receiptFd); checkOwned(pendingPath, 1, bytes.length);
        require(hash(bytesAt(receiptFd, bytes.length)) === hash(bytes), "receipt"); ctx.checkParent();
        linkSync(pendingPath, ctx.value.receiptPath); // exclusive: never overwrites a collision
        published = true;
        checkOwned(pendingPath, 2, bytes.length); checkOwned(ctx.value.receiptPath, 2, bytes.length);
        unlinkSync(pendingPath);
        checkOwned(ctx.value.receiptPath, 1, bytes.length); ctx.checkParent();
        ctx.syncParent(); ctx.checkParent(); checkOwned(ctx.value.receiptPath, 1, bytes.length);
        const recorded = privateJson(ctx.value.receiptPath, Number(ctx.parent.uid), "receipt");
        require(recorded.sha256 === hash(bytes) && same(recorded.identity, createdReceipt, ["dev", "ino", "uid"]), "receipt");
        ctx.verifyArtifacts(); closeSync(receiptFd); receiptFd = undefined;
        return { ok: true, receipt };
      } catch (error) {
        // Pre-publication failures leave only unadoptable pending residue. Later
        // failure plus cleanup failure may leave readable bytes; the observer's
        // actual nonzero outcome remains an independent mandatory controller gate.
        if (createdReceipt) {
          for (const file of [pendingPath, ...(published ? [ctx.value.receiptPath] : [])]) {
            try { if (same(statIdentity(lstatSync(file, { bigint: true })), createdReceipt, ["dev", "ino", "uid"])) unlinkSync(file); } catch { /* original failure remains authoritative */ }
          }
        }
        if (receiptFd !== undefined) { try { closeSync(receiptFd); } catch { /* preserve original failure */ } }
        return { ok: false, code: safe(error, "receipt").code };
      }
    },
    close() { if (!closed) { closed = true; reader.close(); ctx.close(); } },
  };
}
