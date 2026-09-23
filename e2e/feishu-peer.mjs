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
import { WebSocketServer } from "ws";

export const SCOPE = { region: "feishu", tenantKey: "e2e-tenant", appId: "cli_0123456789abcdef" };
export const ORGANIZER = { openId: "ou_e2e_organizer", displayName: "Scripted Organizer" };
export const RESERVE_ID = "reserve-e2e-1";

/** One scheduled-meeting invite; `startSeconds` is chosen by the harness. */
export function inviteEnvelope({ eventId, providerMeetingId, meetingNo, title, startSeconds, inviteSeconds, createTimeMs }) {
  return {
    schema: "2.0",
    header: { event_id: eventId, event_type: "vc.bot.meeting_invited_v1", app_id: SCOPE.appId, tenant_key: SCOPE.tenantKey, create_time: String(createTimeMs) },
    event: { meeting: { id: providerMeetingId, meeting_no: meetingNo, topic: title, start_time: String(startSeconds) }, invite_time: String(inviteSeconds), call_id: "e2e-call" },
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

function json(response, body, status = 200) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

/**
 * @param meeting the occurrence the reservation must agree with, so the
 *   shipped resolver's own occurrence/meeting-number checks are exercised.
 */
export async function startFeishuPeer({ meeting }) {
  /** Redacted request trace: method, matched route and status only. */
  const requests = [];
  const messages = [];
  let wsPath = null;

  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://peer.invalid");
      const route = (name, status = 200) => { requests.push({ method: request.method, route: name, status }); };
      const path = url.pathname;
      if (path.endsWith("/auth/v3/tenant_access_token/internal") || path.endsWith("/auth/v3/app_access_token/internal")) {
        route("tenant_access_token");
        json(response, { code: 0, msg: "ok", tenant_access_token: "e2e-scripted-token", app_access_token: "e2e-scripted-token", expire: 7200 });
        return;
      }
      if (path.endsWith("/callback/ws/endpoint")) {
        route("ws_endpoint");
        json(response, { code: 0, data: { URL: `${wsPath}?device_id=e2e&service_id=1`, ClientConfig: { PingInterval: 120, ReconnectCount: 1, ReconnectInterval: 0, ReconnectNonce: 0 } } });
        return;
      }
      if (path.endsWith(`/vc/v1/reserves/${RESERVE_ID}/get_active_meeting`)) {
        route("reserve_active_meeting");
        json(response, { code: 0, msg: "ok", data: { meeting: { id: meeting.providerMeetingId, meeting_no: meeting.meetingNo, start_time: String(meeting.startSeconds), topic: meeting.title } } });
        return;
      }
      if (path.endsWith(`/vc/v1/reserves/${RESERVE_ID}`)) {
        route("reserve_get");
        json(response, { code: 0, msg: "ok", data: { reserve: { id: RESERVE_ID, meeting_no: meeting.meetingNo, reserve_user_id: ORGANIZER.openId } } });
        return;
      }
      if (path.includes("/contact/v3/users/")) {
        route("contact_user_get");
        json(response, { code: 0, msg: "ok", data: { user: { open_id: ORGANIZER.openId, name: ORGANIZER.displayName } } });
        return;
      }
      if (path.endsWith("/im/v1/messages")) {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        messages.push({ receiveId: body.receive_id, uuid: body.uuid, text: JSON.parse(body.content ?? "{}").text,
          textBytes: typeof body.content === "string" ? body.content.length : 0, at: Date.now() });
        route("im_message");
        json(response, { code: 0, msg: "ok", data: { message_id: `om_e2e_${messages.length}` } });
        return;
      }
      route("unmatched", 404);
      json(response, { code: 99, msg: "not scripted" }, 404);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  wsPath = `${origin.replace("http:", "ws:")}/ws`;

  const sockets = new Set();
  const websocket = new WebSocketServer({ server, perMessageDeflate: false, maxPayload: 65536 });
  const acknowledgements = [];
  websocket.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("message", (bytes) => {
      const payload = framePayload(Buffer.from(bytes));
      if (payload) acknowledgements.push(payload);
    });
    socket.on("close", () => sockets.delete(socket));
  });

  return {
    origin, requests, messages, acknowledgements,
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
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise((resolve) => websocket.close(() => resolve()));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
