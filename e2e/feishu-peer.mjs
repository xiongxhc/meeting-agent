// Scripted Feishu peers for the built end-to-end spine (D028): a local HTTP
// origin that answers ONLY what the shipped metadata resolver, the shipped SDK
// long-connection handshake and the organizer notification actually request,
// and a websocket server that delivers one real invite envelope into the
// SHIPPED `createFeishuInviteIngress` dispatcher through its own `accept()`.
//
// The long-connection frame follows the published 1.74.0 pbbp2 field numbers,
// exactly as test/lib/feishu-fixtures.ts already does; no SDK private import
// and no production codec is involved. Every request is logged with its path
// and status only -- never a body, a token or an identifier.

import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { once } from "node:events";
import { createServer } from "node:http";
import { TextDecoder } from "node:util";
import { WebSocketServer } from "ws";
import { createFeishuPeerControls } from "./feishu-peer-controls.mjs";
import { createFeishuUpgradeControls } from "./feishu-upgrade-controls.mjs";
export { ORGANIZER, RESERVE_ID } from "./feishu-peer-controls.mjs";

export const SCOPE = { region: "feishu", tenantKey: "e2e-tenant", appId: "cli_0123456789abcdef" };
/** The scripted inviter every e2e config lists in its invite allowlist. */
export const E2E_INVITER = "ou_e2e_inviter";
/** An inviter no e2e config lists: its invites are refused and recorded. */
export const E2E_STRANGER = "ou_e2e_stranger";

/** One scheduled-meeting invite; `startSeconds` is chosen by the harness. */
export function inviteEnvelope({ eventId, providerMeetingId, meetingNo, title, startSeconds, inviteSeconds, createTimeMs, inviterId = E2E_INVITER }) {
  return {
    schema: "2.0",
    header: { event_id: eventId, event_type: "vc.bot.meeting_invited_v1", app_id: SCOPE.appId, tenant_key: SCOPE.tenantKey, create_time: String(createTimeMs) },
    event: { meeting: { id: providerMeetingId, meeting_no: meetingNo, topic: title, start_time: String(startSeconds) }, invite_time: String(inviteSeconds), call_id: "e2e-call",
      inviter: { id: inviterId, user_type: 1 } },
  };
}

// --- pbbp2 frame encoding (published field numbers only) --------------------
function varint(value) {
  const bytes = [];
  do { let byte = value & 127; value = Math.floor(value / 128); if (value) byte |= 128; bytes.push(byte); } while (value);
  return Buffer.from(bytes);
}
function field(index, value) {
  return Buffer.concat([varint(index * 8 + 2), varint(value.length), value]);
}
export function eventFrame(raw, messageId = "e2e-message") {
  const headers = Object.entries({ message_id: messageId, sum: "1", seq: "0", type: "event", trace_id: "e2e" })
    .map(([key, value]) => field(5, Buffer.concat([field(1, Buffer.from(key)), field(2, Buffer.from(value))])));
  return Buffer.concat([Buffer.from([8, 1, 16, 1, 24, 1, 32, 1]), ...headers, field(8, Buffer.from(JSON.stringify(raw)))]);
}
export function framePayload(buffer) {
  let at = 0;
  const read = () => { let n = 0, shift = 0, b; do { b = buffer[at++]; n += (b & 127) * 2 ** shift; shift += 7; } while (b & 128); return n; };
  while (at < buffer.length) {
    const tag = read();
    if ((tag & 7) === 0) { read(); continue; }
    if ((tag & 7) !== 2) throw new Error("e2e_frame_wire");
    const length = read();
    const bytes = buffer.subarray(at, at + length);
    at += length;
    if (tag >>> 3 === 8) return JSON.parse(bytes.toString());
  }
  return null;
}

// Narrow receive observation, not a general protobuf codec. Parse every extent
// before exposing the legacy JSON projection; malformed bytes never reach the
// old, deliberately unchanged framePayload decoder in a socket callback.
function inspectReceivedFrame(buffer) {
  const invalid = (reason = "e2e_frame_invalid") => ({ observation: { kind: "invalid", reason } });
  try {
    if (!(buffer instanceof Uint8Array) || buffer.byteLength > 65536) return invalid();
    let at = 0;
    const refuse = () => { throw new Error("e2e_frame_invalid"); };
    const read = (end, maximum = Number.MAX_SAFE_INTEGER) => {
      let value = 0;
      for (let count = 0; count < 8; count++) {
        if (at >= end) refuse();
        const byte = buffer[at++];
        value += (byte & 127) * 2 ** (7 * count);
        if (!Number.isSafeInteger(value) || value > maximum) refuse();
        if (!(byte & 128)) {
          if (count && byte === 0) refuse();
          return value;
        }
      }
      refuse();
    };
    const tag = (end) => {
      const value = read(end, 0xffffffff);
      const index = Math.floor(value / 8), wire = value % 8;
      if (!index || (wire !== 0 && wire !== 2)) refuse();
      return { index, wire };
    };
    const extent = (end, maximum) => {
      const length = read(end, maximum);
      if (length > end - at) refuse();
      const value = buffer.subarray(at, at + length);
      at += length;
      return value;
    };
    const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const headers = new Map(), seen = new Set();
    let method, payloadBytes, headerCount = 0;
    while (at < buffer.length) {
      const { index, wire } = tag(buffer.length);
      if (index !== 5 && seen.has(index)) refuse();
      seen.add(index);
      if ((index <= 4 && wire !== 0) || (index >= 5 && index <= 9 && wire !== 2)) refuse();
      if (wire === 0) {
        const value = read(buffer.length, index === 4 ? 0xffffffff : Number.MAX_SAFE_INTEGER);
        if (index === 4) method = value;
      } else if (index === 5) {
        if (++headerCount > 32) refuse();
        const length = read(buffer.length, 65536);
        if (length > buffer.length - at) refuse();
        const end = at + length, parts = new Map();
        while (at < end) {
          const part = tag(end);
          if (part.wire !== 2 || (part.index !== 1 && part.index !== 2) || parts.has(part.index)) refuse();
          parts.set(part.index, utf8.decode(extent(end, part.index === 1 ? 64 : 256)));
        }
        const key = parts.get(1), value = parts.get(2);
        if (!key || value === undefined || headers.has(key)) refuse();
        headers.set(key, value);
      } else {
        const value = extent(buffer.length, index === 8 ? 8192 : 65536);
        if (index === 8) payloadBytes = value;
        else if (index === 6 || index === 7 || index === 9) utf8.decode(value);
      }
    }
    const payload = payloadBytes?.length ? JSON.parse(utf8.decode(payloadBytes)) : null;
    // The pinned SDK's periodic method0/type=ping has no event payload/ID.
    if (method === 0 && headers.get("type") === "ping" && !payloadBytes?.length) {
      return { observation: { kind: "ping" }, legacyPayload: payload };
    }
    const messageId = headers.get("message_id");
    if (method !== 1 || headers.get("type") !== "event" || !messageId) {
      return { ...invalid("e2e_frame_identity"), legacyPayload: payload };
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || !Number.isInteger(payload.code) || (payload.code !== 200 && payload.code !== 500)) {
      return { ...invalid("e2e_frame_reply"), legacyPayload: payload };
    }
    return { observation: { kind: "ack", messageId, payload }, legacyPayload: payload };
  } catch {
    // Never expose decoding/JSON/UTF-8 error text or malformed input.
    return invalid();
  }
}

/** Exact received reply facts only; pending-envelope correlation is the driver's job. */
export function observeFeishuFrame(buffer) {
  return inspectReceivedFrame(buffer).observation;
}

/** The actual socket receive callback, also usable without listeners in tests. */
export function createFeishuFrameReceiver(profile) {
  if (profile !== undefined && profile !== "backlog-257") throw new Error("e2e_receiver_profile");
  const maximum = profile === "backlog-257" ? 257 : 64;
  const acknowledgements = [], observations = [];
  let ordinal = 0, invalid = false, overflow = false;
  return {
    acknowledgements, observations,
    get invalid() { return invalid; },
    get overflow() { return overflow; },
    receive(buffer) {
      const received = inspectReceivedFrame(buffer);
      const observation = received.observation;
      ordinal++;
      if (received.legacyPayload) acknowledgements.push(received.legacyPayload);
      if (observation.kind === "ping") return;
      if (observation.kind === "invalid") invalid = true;
      if (observations.length === maximum) { overflow = true; return; }
      observations.push({ ordinal, ...observation });
    },
  };
}

/** Listener-free construction is shared with the actual peer registration. */
export function createFeishuUpgradeServer(server) {
  const websocket = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 65536 });
  const controls = createFeishuUpgradeControls(websocket);
  server.on("upgrade", controls.handler);
  return Object.freeze({ websocket, controls,
    close() {
      server.removeListener("upgrade", controls.handler);
      return controls.close();
    },
  });
}

/**
 * @param meeting the occurrence the reservation must agree with, so the
 *   shipped resolver's own occurrence/meeting-number checks are exercised.
 */
export async function startFeishuPeer(options) {
  // Validate the selected literal before constructing any HTTP/socket owner.
  const frameObservation = createFeishuFrameReceiver(options.receiverProfile);
  let wsPath = null;
  const controls = createFeishuPeerControls({ ...options, wsPath: () => wsPath });
  const { requests, messages } = controls;
  const server = createServer(controls.handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  wsPath = `${origin.replace("http:", "ws:")}/ws`;

  const sockets = new Set();
  const upgrades = createFeishuUpgradeServer(server);
  const { websocket } = upgrades;
  const { acknowledgements } = frameObservation;
  websocket.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("message", frameObservation.receive);
    socket.on("close", () => sockets.delete(socket));
  });

  let closing = null;
  return {
    origin, requests, messages, acknowledgements, frameObservation,
    armNext: controls.armNext, release: controls.release,
    readPendingHold: controls.readPendingHold,
    armNextUpgrade: upgrades.controls.armNextUpgrade,
    readPendingUpgrade: upgrades.controls.readPendingUpgrade,
    readUpgradeObservation: upgrades.controls.readUpgradeObservation,
    get connectionCount() { return sockets.size; },
    /** The SDK HttpInstance request hook: same shape, local origin. */
    rewriteRequest(defaultRequest) {
      return (options) => {
        const url = new URL(options.url);
        return defaultRequest({ ...options, url: origin + url.pathname + url.search, proxy: false });
      };
    },
    deliverInvite(raw, messageId) {
      if (sockets.size === 0) throw new Error("e2e_no_long_connection");
      for (const socket of sockets) socket.send(eventFrame(raw, messageId));
    },
    close() {
      if (closing) return closing;
      const upgradeClose = upgrades.close();
      closing = (async () => {
        controls.close();
        for (const socket of sockets) socket.terminate();
        await Promise.all([upgradeClose, new Promise((resolve) => websocket.close(() => resolve()))]);
        server.closeAllConnections();
        await new Promise((resolve) => server.close(() => resolve()));
      })();
      return closing;
    },
  };
}
