// Immutable external fixture metadata. No IO, application admission or mutable
// registration API; private indexes live only for this peer's lifetime.
import { Buffer } from "node:buffer";

const invalid = () => { throw new Error("e2e_peer_invalid_registry"); };
const identity = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const text = (value) => typeof value === "string" && value.trim().length > 0
  && Buffer.byteLength(value, "utf8") <= 4096
  && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
function shape(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => !keys.includes(key))) invalid();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) invalid();
  }
}
function freeze(value) {
  for (const nested of Object.values(value)) if (nested && typeof nested === "object") freeze(nested);
  return Object.freeze(value);
}
const unavailable = freeze({ route: "unmatched", status: 404, body: { code: 99, msg: "not scripted" } });
const badRequest = (route) => freeze({ route, status: 400, body: { code: 99, msg: "invalid request" } });
function answer(route, data) { return freeze({ route, status: 200, body: { code: 0, msg: "ok", data } }); }

export function createFeishuReservationRegistry({ reservations }) {
  if (!Array.isArray(reservations) || reservations.length < 1 || reservations.length > 16) invalid();
  const reserves = new Map(), organizers = new Map(), meetingNumbers = new Set(), meetingIds = new Set();
  for (let index = 0; index < reservations.length; index++) {
    const item = Object.getOwnPropertyDescriptor(reservations, String(index));
    if (!item?.enumerable || !Object.hasOwn(item, "value")) invalid();
    const r = item.value;
    shape(r, ["reserveId", "meeting", "organizer"]);
    shape(r.meeting, ["providerMeetingId", "meetingNo", "startSeconds", "title"]);
    shape(r.organizer, ["openId", "displayName"]);
    const { reserveId } = r, { providerMeetingId, meetingNo, startSeconds, title } = r.meeting,
      { openId, displayName } = r.organizer;
    if (!identity(reserveId) || !identity(providerMeetingId) || !identity(openId)
      || typeof meetingNo !== "string" || !/^[0-9]{9}$/.test(meetingNo)
      || !Number.isInteger(startSeconds) || startSeconds < 0 || startSeconds > 253402300799
      || !text(title) || !text(displayName)) invalid();
    if (reserves.has(reserveId) || meetingNumbers.has(meetingNo) || meetingIds.has(providerMeetingId)
      || (organizers.has(openId) && organizers.get(openId).body.data.user.name !== displayName)) invalid();
    // Every stored value is built from validated primitives, never caller objects.
    reserves.set(reserveId, Object.freeze({
      active: answer("reserve_active_meeting", { meeting: { id: providerMeetingId, meeting_no: meetingNo, start_time: String(startSeconds), topic: title } }),
      reserve: answer("reserve_get", { reserve: { id: reserveId, meeting_no: meetingNo, reserve_user_id: openId } }),
    }));
    organizers.set(openId, answer("contact_user_get", { user: { open_id: openId, name: displayName } }));
    meetingNumbers.add(meetingNo); meetingIds.add(providerMeetingId);
  }
  return Object.freeze({
    lookup({ method, url }) {
      const path = url.pathname.startsWith("/open-apis/") ? url.pathname.slice(10) : url.pathname;
      const reserve = /^\/vc\/v1\/reserves\/([A-Za-z0-9_-]{1,128})(\/get_active_meeting)?$/.exec(path);
      const contact = /^\/contact\/v3\/users\/([A-Za-z0-9_-]{1,128})$/.exec(path);
      let result;
      if (reserve) result = reserves.get(reserve[1])?.[reserve[2] ? "active" : "reserve"];
      else if (contact) result = organizers.get(contact[1]);
      else return /^\/(vc\/v1\/reserves|contact\/v3\/users)(\/|$)/.test(path) ? unavailable : null;
      if (!result) return unavailable;
      const expected = result.route === "reserve_active_meeting"
        ? [["user_id_type", "open_id"], ["with_participants", "false"]] : [["user_id_type", "open_id"]];
      if (method !== "GET" || url.searchParams.size !== expected.length
        || expected.some(([key, value]) => url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== value))
        return badRequest(result.route);
      return result;
    },
  });
}
