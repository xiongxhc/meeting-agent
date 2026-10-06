import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { test } from "node:test";
// @ts-expect-error Private harness JavaScript has no public declaration.
import { parseExpiryEvidence, selectReleasedAdmission, validateExpiryEvidence } from "./expiry-evidence.mjs";

// All bytes, lifecycle facts and provenance below are SYNTHETIC component C.
// They exercise the real validator, never attest executable/process origin.
const schema = "runtime-media-admission-evidence/v1", instance = "0123456789abcdef0123456789abcdef";
const predicates = { session_present: true, credential_matches: true, media_version_matches: true,
  bridge_binding_matches: true, credential_expired: false, reconnect_expired: false, active: false, capture_finished: false };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Adversarial JSON fixtures intentionally contain wrong field types.
function rows(): any[] {
  return [
    { schema, instance, sequence: 0, type: "header" },
    { schema, instance, sequence: 1, type: "admission", session_id: "41", reservation_epoch: "2", connection_id: "1",
      accepted: true, context: { attempt_id: 2, transport: { kind: "tcp", peer: "127.0.0.1:51000", local: "127.0.0.1:4000" } }, predicates: { ...predicates } },
    { schema, instance, sequence: 2, type: "fence_release", session_id: "41", reservation_epoch: "2", connection_id: "1" },
    { schema, instance, sequence: 3, type: "admission", session_id: "41", reservation_epoch: "2", connection_id: null,
      accepted: false, context: { attempt_id: 1, transport: { kind: "tcp", peer: "127.0.0.1:52000", local: "127.0.0.1:4000" } }, predicates: { ...predicates, credential_expired: true } },
    { schema, instance, sequence: 4, type: "completion", record_count: 5, loss: false, writer_error: false },
  ];
}
function bytes(records: unknown[] = rows()) { return Buffer.from(records.map(row => JSON.stringify(row) + "\n").join("")); }
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const digest = "a".repeat(64);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Negative tests mutate untrusted inputs into invalid schemas.
function fixture(journal = bytes()): any {
  // Bind structural fixtures to their actual bytes independently of the parser
  // under test. Count/identity/hash mismatches have separate explicit tests.
  const fixtureRows = journal.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const identity = { dev: "1", ino: "2", uid: 501, mode: 384, nlink: 1, parentDev: "1", parentIno: "3", parentUid: 501, parentMode: 448 };
  const provenance = { profile: "runtime-media-evidence-test-20261005", artifactManifestSha256: digest, sourceManifestSha256: digest,
    patchSha256: digest, buildMetadataSha256: digest, erratumSha256: digest, reconciledAuditSha256: digest,
    base: "c".repeat(40), candidateTree: "b".repeat(40), gatewaySha256: digest, sdkSha256: digest };
  return { journal, sessionId: "41", expectedProvenance: provenance,
    receipt: { schema: "meeting-expiry-ownership/v1", provenance: { ...provenance }, gatewayPid: 123,
      spawnObserved: true, exitCode: 0, signal: null, pipesClosed: true, observerFailure: null,
      binaryBeforeSha256: digest, binaryAfterSha256: digest, journalOpenedIdentity: { ...identity }, journalFinalIdentity: { ...identity },
      journalOpenedSize: 100, journalFinalSize: journal.length, journalSha256: hash(journal), instance: fixtureRows[0]?.instance,
      completion: { recordCount: fixtureRows.length, loss: false, writerError: false } },
    journalIdentity: { ...identity },
    probe: { local: "127.0.0.1:52000", remote: "127.0.0.1:4000", connected: true, writeCompleted: true,
      receivedBytes: 0, orderlyEnd: true, error: null, timedOut: false },
    ordering: { releaseObserved: 1, probeStarted: 2, probeSettled: 3, firstTeardown: 4,
      releaseInstance: instance, releaseSequence: 2 },
    nativeLifecycle: { sessionId: "41", connected: 1, faultDisconnected: 1, terminalDisconnected: 1, reconnecting: 0, reconnected: 0 },
    nativeProof: { recordedSamples: "86400", recordedFrames: 180, emittedSamples: 86537, prefixComplete: false, pages: 3,
      drain: "unconfirmed", nativeCleanup: "confirmed", custody: "departure_confirmed", timingCoverage: "available",
      timingWarnings: [], scope: "component_only_failure_oracle" },
    cleanup: { sdkTransportClosed: true, runtimeClosed: true, providerClosed: true, nativeChildReaped: true, nativeChildFailure: null },
  };
}

test("producer-shaped original bytes yield owned records and the unique released TCP chain", () => {
  const parsed = parseExpiryEvidence(bytes());
  assert.equal(parsed.complete, true); assert.equal(parsed.pendingBytes, 0);
  assert.equal(parsed.records.length, 5);
  const selected = selectReleasedAdmission(parsed.records, { sessionId: "41" });
  assert.equal(selected.status, "released"); assert.equal(selected.acceptance.sequence, 1); assert.equal(selected.release.sequence, 2);
  assert.equal(validateExpiryEvidence(fixture()).ok, true);
});

test("tail parsing retains bounded unfinished bytes but never labels them complete", () => {
  const tail = Buffer.concat([bytes(rows().slice(0, 3)), Buffer.from('{"schema":')]);
  const parsed = parseExpiryEvidence(tail, { complete: false });
  assert.equal(parsed.complete, false); assert.equal(parsed.pendingBytes, 10); assert.equal(parsed.records.length, 3);
  assert.equal(selectReleasedAdmission(parsed.records, { sessionId: "41" }).status, "released");
  assert.throws(() => parseExpiryEvidence(tail));
  assert.equal(selectReleasedAdmission(parseExpiryEvidence(bytes(rows().slice(0, 2)), { complete: false }).records,
    { sessionId: "41" }).status, "pending");
});

test("tail mode never authorizes completeness even when the terminal record has arrived", () => {
  assert.equal(parseExpiryEvidence(bytes(), { complete: false }).complete, false);
  assert.equal(parseExpiryEvidence(bytes()).complete, true);
});

test("a freshly opened empty or partial-header tail remains pending before the first writer newline", () => {
  for (const tail of [Buffer.alloc(0), Buffer.from('{"schema":')]) {
    const parsed = parseExpiryEvidence(tail, { complete: false });
    assert.deepEqual(parsed, { records: [], complete: false, pendingBytes: tail.length });
    assert.equal(selectReleasedAdmission(parsed.records, { sessionId: "41" }).status, "pending");
    assert.throws(() => parseExpiryEvidence(tail));
  }
});

for (const [name, mutate] of [
  ["foreign instance", r => { r[3].instance = "f".repeat(32); }],
  ["sequence gap", r => { r[3].sequence = 4; }],
  ["unsafe sequence", r => { r[3].sequence = Number.MAX_SAFE_INTEGER + 1; }],
  ["zero attempt", r => { r[3].context.attempt_id = 0; }],
  ["overflow attempt", r => { r[3].context.attempt_id = 4097; }],
  ["fractional attempt", r => { r[3].context.attempt_id = 1.5; }],
  ["duplicate attempt", r => { r[3].context.attempt_id = 2; }],
  ["leading zero identity", r => { r[1].session_id = "041"; }],
  ["overflow u64", r => { r[1].session_id = "18446744073709551616"; }],
  ["numeric identity", r => { r[1].session_id = 41; }],
  ["zero reservation", r => { r[1].reservation_epoch = "0"; }],
  ["zero connection", r => { r[1].connection_id = "0"; }],
  ["accepted null connection", r => { r[1].connection_id = null; }],
  ["rejected string connection", r => { r[3].connection_id = "2"; }],
  ["string predicate", r => { r[1].predicates.active = "false"; }],
  ["accepted blocked", r => { r[1].predicates.active = true; }],
  ["present admission absent session", r => { r[3].predicates.session_present = false; }],
  ["rejected unblocked", r => { r[3].predicates.credential_expired = false; }],
  ["completion count", r => { r[4].record_count = 4; }],
  ["writer loss", r => { r[4].loss = true; }],
  ["writer error", r => { r[4].writer_error = true; }],
  ["duplicate header", r => { r[2] = { schema, instance, sequence: 2, type: "header" }; }],
  ["unknown type", r => { r[2].type = "secret"; }],
  ["extra secret field", r => { r[3].credential = "secret"; }],
  ["extra context field", r => { r[3].context.token = "secret"; }],
  ["extra transport field", r => { r[3].context.transport.token = "secret"; }],
  ["bad ipv4", r => { r[3].context.transport.peer = "999.0.0.1:4"; }],
  ["noncanonical ipv4", r => { r[3].context.transport.peer = "127.00.0.1:4"; }],
  ["overflow port", r => { r[3].context.transport.peer = "127.0.0.1:65536"; }],
  ["bad ipv6", r => { r[3].context.transport.peer = "[1::2::3]:4"; }],
  ["unbracketed ipv6", r => { r[3].context.transport.peer = "::1:4"; }],
] as [string, (r: ReturnType<typeof rows>) => void][]) {
  test(`parser refuses ${name} even outside the selected chain`, () => {
    const r = rows(); mutate(r); assert.throws(() => parseExpiryEvidence(bytes(r)));
  });
}

for (const [name, mutate] of [
  ["empty line", b => Buffer.concat([b, Buffer.from("\n")])],
  ["BOM", b => Buffer.concat([Buffer.from([239, 187, 191]), b])],
  ["invalid UTF8", b => Buffer.concat([b, Buffer.from([255])])],
  ["UTF8 replacement", b => Buffer.concat([b, Buffer.from("\ufffd")])],
  ["missing newline", b => b.subarray(0, b.length - 1)],
  ["duplicate JSON key", b => Buffer.from(b.toString().replace('"sequence":0', '"sequence":0,"sequence":0'))],
  ["whitespace", b => Buffer.from(b.toString().replace('"sequence":0', '"sequence": 0'))],
  ["escaped key", b => Buffer.from(b.toString().replace('"schema"', '"sch\\u0065ma"'))],
  ["noncanonical number", b => Buffer.from(b.toString().replace('"sequence":0', '"sequence":0.0'))],
  ["completion followed by bytes", b => Buffer.concat([b, bytes(rows().slice(0, 1))])],
  ["line bound", b => Buffer.concat([b, Buffer.alloc(2048, 120)])],
  ["total bound", () => Buffer.alloc(4096 * 2048 + 1, 120)],
] as [string, (b: Buffer) => Uint8Array][]) {
  test(`original-byte parser refuses ${name}`, () => assert.throws(() => parseExpiryEvidence(mutate(bytes()))));
}

test("record cap and tail bounds apply before completion, and malformed terminated tail is immediate failure", () => {
  const header = rows()[0];
  const r = Array.from({ length: 4097 }, (_, sequence) => ({ ...header, sequence }));
  assert.throws(() => parseExpiryEvidence(bytes(r), { complete: false }));
  assert.throws(() => parseExpiryEvidence(Buffer.concat([bytes([header]), Buffer.alloc(2048, 120)]), { complete: false }));
  assert.throws(() => parseExpiryEvidence(Buffer.from(JSON.stringify(header) + "\n{}\n"), { complete: false }));
});

for (const [name, mutate] of [
  ["foreign session", r => { r[3].session_id = "42"; }],
  ["foreign reservation", r => { r[3].reservation_epoch = "3"; }],
  ["wrong release connection", r => { r[2].connection_id = "3"; }],
  ["wrong release reservation", r => { r[2].reservation_epoch = "3"; }],
  ["wrong release session", r => { r[2].session_id = "42"; }],
  ["foreign probe tuple", r => { r[3].context.transport.peer = "127.0.0.1:53000"; }],
  ["reversed release order", r => { [r[2], r[3]] = [r[3], r[2]]; r[2].sequence = 2; r[3].sequence = 3; }],
  ["component rejection", r => { r[3].context.transport = { kind: "component" }; }],
  ["component acceptance", r => { r[1].context.transport = { kind: "component" }; }],
  ["reconnect also expired", r => { r[3].predicates.reconnect_expired = true; }],
  ["active also true", r => { r[3].predicates.active = true; }],
  ["capture also finished", r => { r[3].predicates.capture_finished = true; }],
  ["credential mismatch", r => { r[3].predicates.credential_matches = false; }],
  ["version mismatch", r => { r[3].predicates.media_version_matches = false; }],
  ["bridge mismatch", r => { r[3].predicates.bridge_binding_matches = false; }],
  ["missing-session decision", r => { r[3] = { schema, instance, sequence: 3, type: "missing_session", session_id: "41", session_present: false, context: r[3].context }; }],
] as [string, (r: ReturnType<typeof rows>) => void][]) {
  test(`validator refuses ${name}`, () => { const r = rows(); mutate(r); assert.equal(validateExpiryEvidence(fixture(bytes(r))).ok, false); });
}

test("validator refuses duplicate releases, replacement acceptance, absent links and pre-parsed caller bypass", () => {
  for (const [extra, code] of [[rows()[2], "expiry_evidence_chain"],
    [{ ...rows()[1], connection_id: "2", context: { ...rows()[1].context, attempt_id: 3 } }, "expiry_evidence_ambiguous"]]) {
    const r = rows(); r.splice(3, 0, extra); r.forEach((row, i) => { row.sequence = i; }); r.at(-1)!.record_count = r.length;
    assert.deepEqual(validateExpiryEvidence(fixture(bytes(r))), { ok: false, code });
  }
  for (const [index, code] of [[1, "expiry_evidence_chain"], [2, "expiry_evidence_incomplete"],
    [3, "expiry_evidence_ambiguous"], [4, "expiry_evidence_incomplete"]] as [number, string][]) {
    const r = rows(); r.splice(index, 1); r.forEach((row, i) => { row.sequence = i; });
    if (r.at(-1)?.type === "completion") r.at(-1)!.record_count = r.length;
    assert.deepEqual(validateExpiryEvidence(fixture(bytes(r))), { ok: false, code });
  }
  assert.throws(() => selectReleasedAdmission([{ type: "admission", accepted: true }], { sessionId: "41" }));
});

test("release selector independently refuses a second same-session original TCP acceptance", () => {
  const r = rows(); r.splice(3, 0, { ...rows()[1], connection_id: "2", context: { ...rows()[1].context, attempt_id: 3 } });
  r.forEach((row, index) => { row.sequence = index; }); r.at(-1).record_count = r.length;
  assert.throws(() => selectReleasedAdmission(r, { sessionId: "41" }), { code: "expiry_evidence_ambiguous" });
});

for (const position of [3, 4]) {
  for (const peer of ["127.0.0.1:52000", "[::ffff:127.0.0.1]:52000"]) {
    test(`probe tuple is ambiguous with a foreign missing-session decision at ${position} using ${peer}`, () => {
      const r = rows(); r.splice(position, 0, { schema, instance, sequence: position, type: "missing_session",
        session_id: "42", session_present: false, context: { attempt_id: 3,
          transport: { kind: "tcp", peer, local: "127.0.0.1:4000" } } });
      r.forEach((row, index) => { row.sequence = index; }); r.at(-1).record_count = r.length;
      assert.deepEqual(validateExpiryEvidence(fixture(bytes(r))), { ok: false, code: "expiry_evidence_ambiguous" });
    });
  }
}

test("a foreign missing-session decision on another measured tuple does not invalidate the selected probe", () => {
  const r = rows(); r.splice(4, 0, { schema, instance, sequence: 4, type: "missing_session", session_id: "42", session_present: false,
    context: { attempt_id: 3, transport: { kind: "tcp", peer: "127.0.0.1:53000", local: "127.0.0.1:4000" } } });
  r[5].sequence = 5; r[5].record_count = r.length;
  assert.equal(validateExpiryEvidence(fixture(bytes(r))).ok, true);
});

for (const [name, mutate] of [
  ["optimistic ready flag", f => { f.evidenceValidated = true; }],
  ["legacy profile", f => { f.expectedProvenance.profile = "runtime14d"; }],
  ["foreign package", f => { f.receipt.provenance.gatewaySha256 = "c".repeat(64); }],
  ["binary replaced", f => { f.receipt.binaryAfterSha256 = "c".repeat(64); }],
  ["nonzero exit", f => { f.receipt.exitCode = 1; }],
  ["signal exit", f => { f.receipt.signal = "SIGTERM"; }],
  ["unobserved spawn", f => { f.receipt.spawnObserved = false; }],
  ["open pipes", f => { f.receipt.pipesClosed = false; }],
  ["observer failure", f => { f.receipt.observerFailure = "failed"; }],
  ["replaced inode", f => { f.receipt.journalFinalIdentity.ino = "4"; }],
  ["final controller identity mismatch", f => { f.journalIdentity.ino = "4"; }],
  ["bad journal mode", f => { f.receipt.journalOpenedIdentity.mode = 420; }],
  ["hardlink", f => { f.receipt.journalOpenedIdentity.nlink = 2; }],
  ["wrong parent owner", f => { f.receipt.journalOpenedIdentity.parentUid = 502; }],
  ["nonprivate parent", f => { f.receipt.journalOpenedIdentity.parentMode = 493; }],
  ["size regression", f => { f.receipt.journalOpenedSize = f.journal.length + 1; }],
  ["journal hash mismatch", f => { f.receipt.journalSha256 = "c".repeat(64); }],
  ["stale receipt instance", f => { f.receipt.instance = "f".repeat(32); }],
  ["receipt completion mismatch", f => { f.receipt.completion.recordCount = 6; }],
  ["probe not connected", f => { f.probe.connected = false; }],
  ["incomplete write", f => { f.probe.writeCompleted = false; }],
  ["probe ACK", f => { f.probe.receivedBytes = 1; }],
  ["probe reset", f => { f.probe.error = "ECONNRESET"; }],
  ["probe timeout", f => { f.probe.timedOut = true; }],
  ["probe not orderly", f => { f.probe.orderlyEnd = false; }],
  ["teardown before probe", f => { f.ordering.firstTeardown = 2; }],
  ["probe before release observed", f => { f.ordering.releaseObserved = 3; }],
  ["wrong release observation", f => { f.ordering.releaseSequence = 3; }],
  ["foreign native session", f => { f.nativeLifecycle.sessionId = "42"; }],
  ["native recovery", f => { f.nativeLifecycle.reconnected = 1; }],
  ["unconfirmed native proof", f => { f.nativeProof.nativeCleanup = "unconfirmed"; }],
  ["unconfirmed SDK close", f => { f.cleanup.sdkTransportClosed = false; }],
  ["child cleanup failure", f => { f.cleanup.nativeChildFailure = "failed"; }],
] as [string, (f: ReturnType<typeof fixture>) => void][]) {
  test(`validator refuses ${name} with valid journal bytes`, () => {
    const f = fixture(); mutate(f); const result = validateExpiryEvidence(f);
    assert.equal(result.ok, false); assert.match(result.code, /^expiry_evidence_[a-z_]+$/);
    assert.deepEqual(Object.keys(result), ["ok", "code"]);
  });
}

test("IPv6 expansion, scoped addresses and IPv4-mapped probe endpoints compare measured endpoints", () => {
  for (const [gatewayPeer, gatewayLocal, probeLocal, probeRemote] of [
    ["[::1]:52000", "[::1]:4000", "[0:0:0:0:0:0:0:1]:52000", "[::1]:4000"],
    ["[fe80::1%3]:52000", "[fe80::2%3]:4000", "[fe80:0:0:0:0:0:0:1%3]:52000", "[fe80::2%3]:4000"],
    ["[::ffff:127.0.0.1]:52000", "[::ffff:7f00:1]:4000", "127.0.0.1:52000", "127.0.0.1:4000"],
  ] as [string, string, string, string][]) {
    const r = rows(); r[3].context.transport.peer = gatewayPeer; r[3].context.transport.local = gatewayLocal;
    const f = fixture(bytes(r)); f.probe.local = probeLocal; f.probe.remote = probeRemote;
    assert.equal(validateExpiryEvidence(f).ok, true);
    f.probe.remote = "[fe80::2%4]:4000"; assert.equal(validateExpiryEvidence(f).ok, false);
  }
});

test("u64 maximum strings remain exact without Number conversion and parser owns its records", () => {
  const r = rows(); for (const row of r) if ("session_id" in row) row.session_id = "18446744073709551615";
  const original = bytes(r), parsed = parseExpiryEvidence(original); original.fill(120);
  assert.equal(parsed.records[1].session_id, "18446744073709551615");
  assert.equal(selectReleasedAdmission(parsed.records, { sessionId: "18446744073709551615" }).status, "released");
});

test("4096 valid records and a 2047-byte unfinished tail are within bounds", () => {
  const r = [rows()[0], ...Array.from({ length: 4094 }, (_, index) => ({ schema, instance, sequence: index + 1,
    type: "missing_session", session_id: "42", session_present: false, context: { attempt_id: index + 1, transport: { kind: "component" } } })),
  { schema, instance, sequence: 4095, type: "completion", record_count: 4096, loss: false, writer_error: false }];
  assert.equal(parseExpiryEvidence(bytes(r)).records.length, 4096);
  const overflow = [...r.slice(0, -1), { ...r[1], sequence: 4095, context: { attempt_id: 4095, transport: { kind: "component" } } },
    { ...r.at(-1), sequence: 4096, record_count: 4097 }];
  assert.throws(() => parseExpiryEvidence(bytes(overflow)));
  const tail = Buffer.concat([bytes(rows().slice(0, 3)), Buffer.alloc(2047, 120)]);
  assert.equal(parseExpiryEvidence(tail, { complete: false }).pendingBytes, 2047);
  assert.throws(() => parseExpiryEvidence(Buffer.concat([tail, Buffer.from("x")]), { complete: false }));
});

for (const key of ["artifactManifestSha256", "sourceManifestSha256", "patchSha256", "buildMetadataSha256", "erratumSha256",
  "reconciledAuditSha256", "base", "candidateTree", "gatewaySha256", "sdkSha256"]) {
  test(`validator binds independent ${key} rather than a receipt's self-assertion`, () => {
    const f = fixture(); f.receipt.provenance[key] = "d".repeat(["base", "candidateTree"].includes(key) ? 40 : 64);
    assert.equal(validateExpiryEvidence(f).ok, false);
    delete f.expectedProvenance[key]; assert.equal(validateExpiryEvidence(f).ok, false);
  });
}

test("every unrelated record is checked and synthetic component decisions cannot hide behind a valid TCP chain", () => {
  const r = rows(), unrelated = { schema, instance, sequence: 4, type: "missing_session", session_id: "42", session_present: false,
    context: { attempt_id: 3, transport: { kind: "component" } } };
  r.splice(4, 0, unrelated); r[5].sequence = 5; r[5].record_count = 6;
  assert.equal(parseExpiryEvidence(bytes(r)).records.length, 6);
  const f = fixture(bytes(r)); f.receipt.completion.recordCount = 6;
  assert.equal(validateExpiryEvidence(f).ok, false);
  unrelated.session_present = true; assert.throws(() => parseExpiryEvidence(bytes(r)));
});

test("missing and malformed inputs fail safely without echoing a secret-shaped value", () => {
  for (const value of [undefined, null, {}, { ttlEnforcementAcceptance: "pass", credential: "sensitive" }]) {
    assert.deepEqual(validateExpiryEvidence(value), { ok: false, code: "expiry_evidence_schema" });
  }
  assert.throws(() => parseExpiryEvidence(bytes().toString()));
  const f = fixture(); f.receipt.observerFailure = "sensitive";
  assert.deepEqual(validateExpiryEvidence(f), { ok: false, code: "expiry_evidence_process" });
});
