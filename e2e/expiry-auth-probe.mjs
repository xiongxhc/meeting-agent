// Fresh real MED3 authentication after issued expiry, before voice stop/finish.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import net from "node:net";
import { URL } from "node:url";
import timers from "node:timers";
import { performance } from "node:perf_hooks";

function socketAddress(address, port) {
  if (typeof address !== "string" || address.length > 80 || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  let host = address;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const parts = host.split("%");
  if (parts.length > 2 || (parts.length === 2 && (!/^(0|[1-9][0-9]{0,9})$/.test(parts[1]) || Number(parts[1]) > 4294967295))) return null;
  const family = net.isIP(parts[0]);
  if (family === 4) return parts.length === 1 ? `${host}:${port}` : null;
  if (family !== 6) return null;
  // URL canonicalizes validated scope-free IPv6; Rust's numeric scope is retained.
  host = new URL(`http://[${parts[0]}]/`).hostname.slice(1, -1);
  const scope = parts.length === 2 ? Number(parts[1]) : 0;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped && scope === 0) {
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}:${port}`;
  }
  return `[${host}${scope === 0 ? "" : `%${scope}`}]:${port}`;
}

export async function probeExpiredCredential(lease, { connect = net.connect, reconnectDeadline } = {}) {
  assert.equal(lease.mediaProtocolVersion, 3);
  assert.ok(typeof lease.expiresAtMs === "bigint" && BigInt(Date.now()) >= lease.expiresAtMs, "credential has not expired");
  assert.ok(Number.isFinite(reconnectDeadline) && reconnectDeadline > performance.now(), "reconnect refusal would mask credential expiry");
  const endpoint = new URL(lease.endpoint);
  assert.ok(endpoint.protocol === "tcp:" && endpoint.port && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
  const token = Buffer.from(lease.credential, "utf8"), bridge = Buffer.from(lease.bridgeSessionId, "utf8");
  assert.ok(token.length > 0 && token.length <= 128 && bridge.length > 0 && bridge.length <= 64);
  const id = Buffer.alloc(8); id.writeBigUInt64BE(lease.sessionId);
  const body = Buffer.concat([id, Buffer.from([token.length]), token, Buffer.from([bridge.length]), bridge]);
  const header = Buffer.alloc(10); header.write("MED3"); header[4] = 3; header[5] = 1; header.writeUInt32BE(body.length, 6);
  const auth = Buffer.concat([header, body]);
  const probeDeadline = Math.min(reconnectDeadline, performance.now() + 1500);
  return await new Promise(resolve => {
    const observation = { local: null, remote: null, connected: false, writeCompleted: false,
      receivedBytes: 0, orderlyEnd: false, error: null, timedOut: false };
    let settled = false, socket, timer;
    const finish = () => {
      if (settled) return;
      settled = true; timers.clearTimeout(timer);
      // This snapshot survives destroy(), which can clear the socket endpoints.
      const result = Object.freeze({ ...observation });
      socket?.destroy(); resolve(result);
    };
    try { socket = connect({ host: endpoint.hostname.replace(/^\[|\]$/g, ""), port: Number(endpoint.port) }); }
    catch { observation.error = "connect_error"; finish(); return; }
    timer = timers.setTimeout(() => { observation.timedOut = true; finish(); }, Math.max(0, probeDeadline - performance.now()));
    socket.once("connect", () => {
      if (settled) return;
      observation.connected = true;
      const local = socketAddress(socket.localAddress, socket.localPort), remote = socketAddress(socket.remoteAddress, socket.remotePort);
      if (local === null || remote === null) { observation.error = "socket_address"; finish(); return; }
      observation.local = local; observation.remote = remote;
      if (performance.now() >= probeDeadline) { observation.timedOut = true; finish(); return; }
      try {
        socket.write(auth, error => {
          if (settled) return;
          if (error) { observation.error = "write_error"; finish(); }
          else observation.writeCompleted = true;
        });
      } catch { observation.error = "write_error"; finish(); }
    });
    socket.on("data", bytes => {
      if (settled) return;
      observation.receivedBytes += bytes.length; observation.error = "unexpected_data"; finish();
    });
    socket.once("end", () => {
      if (settled) return;
      observation.orderlyEnd = true;
      if (performance.now() >= probeDeadline) observation.timedOut = true;
      finish();
    });
    socket.once("error", () => { if (!settled) { observation.error = "socket_error"; finish(); } });
    socket.once("close", () => { if (!settled) { observation.error = "socket_closed"; finish(); } });
  });
}

export async function expiredCredentialRefused(lease, options) {
  const probe = await probeExpiredCredential(lease, options);
  if (probe.connected && probe.writeCompleted && probe.receivedBytes === 0 && probe.orderlyEnd && probe.error === null && !probe.timedOut) return true;
  throw new Error("expired_credential_refusal_unproven");
}
