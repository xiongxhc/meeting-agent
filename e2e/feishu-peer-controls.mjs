// Private scripted Feishu HTTP handler. The server and listener-free tests use
// this exact code; controls affect external responses, never application state.
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { createFeishuReservationRegistry } from "./feishu-reservation-registry.mjs";

export const ORGANIZER = { openId: "ou_e2e_organizer", displayName: "Scripted Organizer" };
export const RESERVE_ID = "reserve-e2e-1";
const ROUTES = new Set(["tenant_access_token", "ws_endpoint", "reserve_active_meeting", "reserve_get", "contact_user_get"]);
const MAX_BODY = 65536, MAX_PENDING = 32, MAX_HISTORY = 256;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT", "TRACE"]);
const ignoreError = () => {};

function matchRoute(path, legacyMetadata = true) {
  if (path.endsWith("/auth/v3/tenant_access_token/internal") || path.endsWith("/auth/v3/app_access_token/internal")) return "tenant_access_token";
  if (path.endsWith("/callback/ws/endpoint")) return "ws_endpoint";
  if (legacyMetadata && path.endsWith(`/vc/v1/reserves/${RESERVE_ID}/get_active_meeting`)) return "reserve_active_meeting";
  if (legacyMetadata && path.endsWith(`/vc/v1/reserves/${RESERVE_ID}`)) return "reserve_get";
  if (legacyMetadata && path.includes("/contact/v3/users/")) return "contact_user_get";
  if (path.endsWith("/im/v1/messages")) return "im_message";
  return "unmatched";
}
function json(response, body, status) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

/** Fixed bounds: five route arms, 32 body readers/holds, 64KiB per body,
 * 256 redacted trace entries (oldest evicted), 256 accepted messages.
 * A hold ID is allocated by armNext and binds the next matching arrival;
 * release refuses until that request's complete body has been read.
 */
export function createFeishuPeerControls(options) {
  if (!options || Object.hasOwn(options, "meeting") === Object.hasOwn(options, "reservations"))
    throw new Error("e2e_peer_invalid_registry");
  const { meeting, wsPath } = options;
  const registry = Object.hasOwn(options, "reservations") ? createFeishuReservationRegistry({ reservations: options.reservations }) : null;
  const requests = [], messages = [], arms = new Map(), holds = new Map(), pending = new Set();
  let closed = false;
  const requireOpen = () => { if (closed) throw new Error("e2e_peer_closed"); };
  function trace(method, route, status) {
    if (requests.length === MAX_HISTORY) requests.shift();
    requests.push({ method, route, status });
  }
  function success(route, chunks) {
    switch (route) {
      case "tenant_access_token": return { code: 0, msg: "ok", tenant_access_token: "e2e-scripted-token", app_access_token: "e2e-scripted-token", expire: 7200 };
      case "ws_endpoint": return { code: 0, data: { URL: `${wsPath()}?device_id=e2e&service_id=1`, ClientConfig: { PingInterval: 120, ReconnectCount: 1, ReconnectInterval: 0, ReconnectNonce: 0 } } };
      case "reserve_active_meeting": return { code: 0, msg: "ok", data: { meeting: { id: meeting.providerMeetingId, meeting_no: meeting.meetingNo, start_time: String(meeting.startSeconds), topic: meeting.title } } };
      case "reserve_get": return { code: 0, msg: "ok", data: { reserve: { id: RESERVE_ID, meeting_no: meeting.meetingNo, reserve_user_id: ORGANIZER.openId } } };
      case "contact_user_get": return { code: 0, msg: "ok", data: { user: { open_id: ORGANIZER.openId, name: ORGANIZER.displayName } } };
      case "im_message": {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid message");
        const content = JSON.parse(body.content ?? "{}");
        if (content === null) throw new Error("invalid content");
        messages.push({ receiveId: body.receive_id, uuid: body.uuid, text: content.text,
          textBytes: typeof body.content === "string" ? body.content.length : 0, at: Date.now() });
        return { code: 0, msg: "ok", data: { message_id: `om_e2e_${messages.length}` } };
      }
      default: return { code: 99, msg: "not scripted" };
    }
  }
  function handler(request, response) {
    const method = METHODS.has(request.method) ? request.method : "OTHER";
    let route = "unmatched", invalidURL = false, metadata = null;
    try {
      if (typeof request.url !== "string" || request.url.length > 2048) throw new Error("invalid URL");
      const url = new URL(request.url, "http://peer.invalid");
      if (registry) {
        metadata = registry.lookup({ method: request.method, url });
        // URL parsing normalizes dot segments/backslashes and discards fragment
        // suffixes. None may alias a literal registered HTTP request identity.
        const rawPath = request.url.split(/[?#]/, 1)[0];
        if (metadata && (rawPath !== url.pathname || request.url.includes("#")))
          metadata = { route: "unmatched", status: 404, body: { code: 99, msg: "not scripted" } };
      }
      route = metadata?.route ?? matchRoute(url.pathname, !registry);
    } catch { invalidURL = true; }
    function reject(status, msg) {
      trace(method, route, status); json(response, { code: 99, msg }, status);
      request.on("error", ignoreError); request.resume();
    }
    if (closed) { reject(503, "peer closed"); return; }
    if (pending.size === MAX_PENDING) { reject(503, "request limit"); return; }
    if (invalidURL) { reject(400, "invalid request"); return; }
    if (metadata && metadata.status !== 200) { reject(metadata.status, metadata.body.msg); return; }
    const control = arms.get(route);
    arms.delete(route);
    const chunks = [];
    let bytes = 0, settled = false;
    const fact = control?.outcome === "hold" ? Object.freeze({ id: control.id, method, route }) : null;
    const owned = { fact, cancel, respond: () => respond(metadata?.body ?? success(route, chunks), 200) };
    pending.add(owned);
    function cleanup() {
      settled = true; chunks.length = 0; pending.delete(owned);
      if (control?.id) holds.delete(control.id);
      request.off("data", onData); request.off("end", onEnd);
      request.off("aborted", cancel); request.off("close", onRequestClose); request.off("error", cancel);
      response.off("close", onResponseClose); response.off("error", cancel);
      request.on("error", ignoreError); response.on("error", ignoreError);
    }
    function respond(body, status) {
      if (settled) return;
      cleanup(); trace(method, route, status); json(response, body, status);
      request.resume();
    }
    function refuse(status, msg) { respond({ code: 99, msg }, status); }
    function cancel() {
      if (settled) return;
      cleanup(); trace(method, route, 499); response.destroy(); request.destroy();
    }
    function onRequestClose() { if (!request.complete || request.aborted) cancel(); }
    function onResponseClose() { if (!response.writableFinished) cancel(); }
    function onData(chunk) {
      bytes += chunk.length;
      if (bytes > MAX_BODY) { refuse(413, "body limit"); return; }
      // Only organizer notifications consume request body bytes.
      if (route === "im_message") chunks.push(Buffer.from(chunk));
    }
    const declared = request.headers?.["content-length"];
    function onEnd() {
      if (declared !== undefined && bytes !== Number(declared)) { refuse(400, "invalid extent"); return; }
      if (control?.outcome === "failure") { refuse(503, "scripted failure"); return; }
      if (control?.outcome === "hold") { holds.set(control.id, owned); return; }
      if (route === "im_message" && messages.length === MAX_HISTORY) { refuse(503, "message limit"); return; }
      let body;
      try { body = metadata?.body ?? success(route, chunks); } catch { refuse(400, "invalid body"); return; }
      respond(body, route === "unmatched" ? 404 : 200);
    }
    request.on("data", onData); request.once("end", onEnd);
    request.once("aborted", cancel); request.on("close", onRequestClose); request.on("error", cancel);
    response.on("close", onResponseClose); response.on("error", cancel);
    if (declared !== undefined && (typeof declared !== "string" || !/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) {
      refuse(400, "invalid extent");
    } else if (Number(declared) > MAX_BODY) { refuse(413, "body limit"); }
  }
  return {
    handler, requests, messages,
    readPendingHold(id) {
      if (typeof id !== "string" || id.length > 64) throw new Error("e2e_peer_invalid_hold_id");
      return holds.get(id)?.fact ?? null;
    },
    armNext(control) {
      requireOpen();
      if (!control || Object.keys(control).length !== 2 || !ROUTES.has(control.route) || !["failure", "hold"].includes(control.outcome))
        throw new Error("e2e_peer_invalid control");
      if (arms.has(control.route)) throw new Error("e2e_peer_already armed");
      const id = control.outcome === "hold" ? randomUUID() : undefined;
      arms.set(control.route, { outcome: control.outcome, id });
      return id;
    },
    release(id) {
      requireOpen();
      const owned = holds.get(id);
      if (!owned) throw new Error("e2e_peer_hold_not pending");
      owned.respond();
    },
    close() {
      requireOpen(); closed = true; arms.clear();
      for (const owned of pending) owned.cancel();
    },
  };
}
