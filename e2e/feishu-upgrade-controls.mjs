// Private pending-upgrade owner. No response is written for the selected GET;
// only a real Duplex close event settles its unaccepted transport ownership.
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

const discardError = () => {};
const retainErrorSink = (emitter) => {
  if (!emitter.listeners("error").includes(discardError)) emitter.on("error", discardError);
};

function validUpgrade(request, socket, head) {
  try {
    const url = request.url, headers = request.headers;
    if (request.method !== "GET" || typeof url !== "string" || url.length > 2048
      || Buffer.byteLength(url) > 2048 || url.includes("#")
      || (url !== "/ws" && !url.startsWith("/ws?"))
      || !Buffer.isBuffer(head) || head.length !== 0
      || socket.destroyed || socket.closed || !socket.readable || !socket.writable
      || socket.readableEnded || socket.writableEnded || socket.readableLength !== 0
      || request.readableLength !== 0 || !headers || typeof headers !== "object") return false;
    const names = Object.keys(headers);
    if (names.length > 64) return false;
    let extent = 0;
    for (const name of names) {
      const property = Object.getOwnPropertyDescriptor(headers, name);
      if (name.length > 64 || !property || !("value" in property)
        || typeof property.value !== "string" || property.value.length > 2048) return false;
      extent += Buffer.byteLength(name) + Buffer.byteLength(property.value);
      if (extent > 8192) return false;
    }
    // Node's normalized headers alone can conceal duplicate handshake headers.
    const raw = request.rawHeaders;
    if (!Array.isArray(raw) || raw.length > 128 || raw.length % 2) return false;
    const seen = new Set();
    extent = 0;
    for (let index = 0; index < raw.length; index += 2) {
      const name = raw[index], value = raw[index + 1];
      if (typeof name !== "string" || typeof value !== "string"
        || name.length > 64 || value.length > 2048) return false;
      extent += Buffer.byteLength(name) + Buffer.byteLength(value);
      if (extent > 8192) return false;
      const lower = name.toLowerCase();
      if (seen.has(lower)) return false;
      seen.add(lower);
    }
    return headers.upgrade?.toLowerCase() === "websocket"
      && headers.connection?.split(",").some((part) => part.trim().toLowerCase() === "upgrade")
      && headers["sec-websocket-version"] === "13"
      && /^[+/0-9A-Za-z]{22}==$/.test(headers["sec-websocket-key"] ?? "")
      && Buffer.from(headers["sec-websocket-key"], "base64").length === 16
      && headers["transfer-encoding"] === undefined
      && (headers["content-length"] === undefined || headers["content-length"] === "0");
  } catch {
    return false;
  }
}

/** Captures the actual public noServer WebSocketServer used by the peer. */
export function createFeishuUpgradeControls(websocket) {
  const owners = new Map(), seenSockets = new WeakSet(), events = [];
  let arm = null, held = null, arrivals = 0, accepted = 0, ordinal = 0;
  let disposed = false, invalid = false, overflow = false, closing = null, resolveClose = null;
  let unconfirmedCleanup = false;
  const increment = (value) => {
    if (value === Number.MAX_SAFE_INTEGER) { invalid = overflow = true; return value; }
    return value + 1;
  };
  const record = (id, kind) => {
    ordinal = increment(ordinal);
    if (events.length === 16) { invalid = overflow = true; return; }
    events.push(Object.freeze({ ordinal, id, kind }));
  };
  const settleCleanup = () => {
    if (disposed && owners.size === 0 && !unconfirmedCleanup && resolveClose) {
      const resolve = resolveClose; resolveClose = null; resolve();
    }
  };
  const detach = (owner) => {
    const { socket } = owner;
    socket.removeListener("close", owner.onClose);
    socket.removeListener("end", owner.onEnd);
    socket.removeListener("data", owner.onData);
    socket.removeListener("error", owner.onError);
    // A static sink remains safe for late errors without retaining this owner.
    retainErrorSink(socket);
  };
  const refuse = (owner) => {
    invalid = true;
    if (owner.terminal || owner.local !== null) return;
    owner.local = disposed ? "fixture" : "refused";
    record(owner.fact?.id ?? null, "refused");
    owner.socket.destroy();
  };
  function handler(request, socket, head) {
    try {
      arrivals = increment(arrivals);
      retainErrorSink(request);
      if (seenSockets.has(socket)) {
        invalid = true;
        const owner = owners.get(socket);
        if (owner) refuse(owner);
        else record(null, "refused");
        return;
      }
      seenSockets.add(socket);
      // Excess transports are immediately refused, never admitted to this finite
      // owner set. Without a retained close receipt, cleanup stays unconfirmed.
      if (owners.size === 4 || socket.closed) {
        invalid = true;
        if (owners.size === 4) {
          overflow = true;
          if (!socket.closed) unconfirmedCleanup = true;
        }
        record(null, "refused");
        retainErrorSink(socket); socket.destroy();
        return;
      }
      const owner = { socket, fact: null, local: null, terminal: false,
        onClose: null, onEnd: null, onData: null, onError: null };
      owner.onClose = () => {
        if (owner.terminal) return;
        owner.terminal = true;
        owners.delete(socket);
        if (held === owner) held = null;
        if (owner.local === "fixture") record(owner.fact?.id ?? null, "fixture_closed");
        else if (owner.fact && owner.local === null) record(owner.fact.id, "remote_closed");
        detach(owner);
        settleCleanup();
      };
      owner.onEnd = () => {}; // FIN alone is not close; preserve allowHalfOpen.
      owner.onData = () => refuse(owner); // Count no bytes and retain none.
      owner.onError = () => refuse(owner); // Error text is never retained.
      owners.set(socket, owner);
      socket.on("close", owner.onClose);
      socket.on("end", owner.onEnd);
      socket.on("data", owner.onData);
      socket.on("error", owner.onError);
      if (disposed || !validUpgrade(request, socket, head)) { refuse(owner); return; }
      if (arm !== null) {
        owner.fact = Object.freeze({ id: arm, method: "GET", route: "ws_upgrade", arrival: arrivals });
        arm = null; held = owner;
        record(owner.fact.id, "held");
        socket.resume();
        return;
      }
      try {
        websocket.handleUpgrade(request, socket, head, (client) => {
          // Accepted transports belong to WebSocketServer, not the hold owner.
          owner.terminal = true; owners.delete(socket); detach(owner);
          accepted = increment(accepted); record(null, "accepted");
          websocket.emit("connection", client, request);
        });
        // This peer has no asynchronous verifyClient. Public ws refusals that
        // return without handoff remain owned and must be marked adverse too.
        if (!owner.terminal) refuse(owner);
      } catch {
        refuse(owner);
      }
    } finally {
      // All peer forwarding is synchronous. Neither held/refused socket
      // callbacks nor their shared lexical scope retain completed HTTP input.
      request = null;
      head = null;
    }
  }
  return Object.freeze({
    handler,
    armNextUpgrade() {
      if (disposed) throw new Error("e2e_peer_upgrade_closed");
      if (arm !== null || held !== null) throw new Error("e2e_peer_upgrade_busy");
      arm = randomUUID(); return arm;
    },
    readPendingUpgrade(id) {
      if (typeof id !== "string" || id.length > 64) throw new Error("e2e_peer_invalid_upgrade_id");
      return held?.fact.id === id ? held.fact : null;
    },
    readUpgradeObservation() {
      // After excess refusal this is a conservative pending floor, not a
      // fabricated zero: unknown close cannot settle the memoized cleanup.
      return Object.freeze({ arrivals, accepted, pending: owners.size || (unconfirmedCleanup ? 1 : 0), disposed, invalid, overflow,
        events: Object.freeze([...events]) });
    },
    close() {
      if (closing) return closing;
      disposed = true; arm = null;
      closing = new Promise((resolve) => { resolveClose = resolve; });
      for (const owner of owners.values()) {
        // Mark before destroy; synchronous/late close must not look remote.
        if (owner.local === null) owner.local = "fixture";
        owner.socket.destroy();
      }
      // Also cover a callback already queued when peer detaches its handler.
      Promise.resolve().then(settleCleanup);
      return closing;
    },
  });
}
