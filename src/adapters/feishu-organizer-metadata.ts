import { Client, Domain } from "@larksuiteoapi/node-sdk";
import type { RedactedSecret } from "../config.ts";
import { boundedInviteString, inviteSecondsToUtc, validateFeishuScope, type FeishuScope } from "../ports/feishu-ingress.ts";
import type { FeishuOrganizerLookup, MetadataBlockedReason, OrganizerReferenceEntry, OrganizerResolution } from "../ports/feishu.ts";
import { validateOrganizerReferenceKeys } from "../ports/feishu.ts";
import { FeishuHttpError, redactedFeishuLogger, type FeishuSdkHttp } from "./feishu-sdk-http.ts";

export function createFeishuOrganizerMetadata(options: FeishuScope & {
  readonly appSecret: RedactedSecret; readonly http: FeishuSdkHttp;
  readonly references: readonly OrganizerReferenceEntry[]; readonly log?: (code:string)=>void;
}): FeishuOrganizerLookup {
  validateFeishuScope(options);
  if (options.references.length > 256) throw new Error("invalid_feishu_references");
  const keys = new Set<string>();
  for (const entry of options.references) {
    validateOrganizerReferenceKeys(entry.reference);
    validateFeishuScope(entry); boundedInviteString(entry.meetingNo);
    const key = JSON.stringify([entry.region,entry.tenantKey,entry.appId,entry.meetingNo]);
    if (keys.has(key)) throw new Error("invalid_feishu_references"); keys.add(key);
    if (entry.reference.kind === "reservation") boundedInviteString(entry.reference.reserveId);
    else if (entry.reference.kind === "calendar_event") {
      boundedInviteString(entry.reference.calendarId); boundedInviteString(entry.reference.eventId);
      boundedInviteString(entry.reference.occurrenceId,2048); boundedInviteString(entry.reference.providerMeetingId);
      boundedInviteString(entry.reference.occurrenceStartedAt);
      if (entry.reference.vcOrganizerOpenId !== undefined) boundedInviteString(entry.reference.vcOrganizerOpenId);
    } else throw new Error("invalid_feishu_references");
  }
  const references = structuredClone(options.references);
  const client = new Client({appId:options.appId,appSecret:options.appSecret.reveal(),domain:options.region === "feishu" ? Domain.Feishu:Domain.Lark,
    httpInstance:options.http.instance,logger:redactedFeishuLogger(options.log)});
  const blocked = (reason: MetadataBlockedReason,retryable=false): OrganizerResolution => ({status:"blocked",reason,retryable});
  return { async resolve(invite,signal) {
    if (invite.region !== options.region || invite.tenantKey !== options.tenantKey || invite.appId !== options.appId) return blocked("reference_invalid");
    const reference = references.find((entry)=>entry.region===invite.region && entry.tenantKey===invite.tenantKey && entry.appId===invite.appId && entry.meetingNo===invite.meetingNo)?.reference;
    if (!reference) return blocked("reference_missing");
    try { return await options.http.withSignal(signal,async()=>{
      signal.throwIfAborted();
      let id: string | undefined, displayName: string | undefined;
      if (reference.kind === "reservation") {
        const active = await client.vc.v1.reserve.getActiveMeeting({path:{reserve_id:reference.reserveId},params:{with_participants:false,user_id_type:"open_id"}});
        if (active.code !== 0) return blocked("metadata_unavailable");
        const meeting = active.data?.meeting;
        if (!meeting?.id || !meeting.start_time) return blocked("inactive_meeting",true);
        if (meeting.id !== invite.providerMeetingId || meeting.meeting_no !== invite.meetingNo || inviteSecondsToUtc(meeting.start_time) !== invite.occurrenceStartedAt) return blocked("occurrence_mismatch",true);
        signal.throwIfAborted();
        const reservation = await client.vc.v1.reserve.get({path:{reserve_id:reference.reserveId},params:{user_id_type:"open_id"}});
        if (reservation.code !== 0) return blocked("metadata_unavailable");
        const reserve = reservation.data?.reserve;
        if (reserve?.id !== reference.reserveId || reserve.meeting_no !== invite.meetingNo) return blocked("reference_invalid");
        id = reserve.reserve_user_id;
        if (!id) return blocked("identity_invalid"); boundedInviteString(id);
        signal.throwIfAborted();
        const contact = await client.contact.v3.user.get({path:{user_id:id},params:{user_id_type:"open_id"}});
        if (contact.code !== 0) return blocked("permission_denied");
        if (contact.data?.user?.open_id !== id) return blocked("identity_invalid");
        displayName = contact.data.user.name;
      } else {
        if (reference.occurrenceId !== invite.occurrenceId || reference.providerMeetingId !== invite.providerMeetingId || reference.occurrenceStartedAt !== invite.occurrenceStartedAt) return blocked("reference_invalid");
        const response = await client.calendar.v4.calendarEvent.get({path:{calendar_id:reference.calendarId,event_id:reference.eventId},params:{user_id_type:"open_id"}});
        if (response.code !== 0) return blocked("permission_denied");
        const event = response.data?.event;
        // The reference already binds the exact occurrence; a recurring series or instance carries its own organizer.
        if (event?.event_id !== reference.eventId || event.status === "cancelled") return blocked("reference_invalid");
        if (event.vchat?.vc_info && (event.vchat.vc_info.unique_id !== invite.providerMeetingId || event.vchat.vc_info.meeting_no !== invite.meetingNo)) return blocked("reference_invalid");
        id = event.event_organizer?.user_id; displayName = event.event_organizer?.display_name;
        if (reference.vcOrganizerOpenId !== undefined && reference.vcOrganizerOpenId !== id) return blocked("identity_invalid");
      }
      if (!id) return blocked("identity_invalid"); boundedInviteString(id);
      if (!displayName?.trim()) return blocked("display_missing"); boundedInviteString(displayName,4096);
      signal.throwIfAborted();
      return {status:"resolved",organizer:{region:invite.region,tenantKey:invite.tenantKey,appId:invite.appId,idType:"open_id",id,displayName,source:reference.kind},reference};
    }); } catch(error) {
      if (signal.aborted) return blocked("cancelled",true);
      if (error instanceof FeishuHttpError) {
        if (error.status === 401 || error.status === 403) return blocked("permission_denied");
        if (error.message === "feishu_http_timeout") return blocked("timeout",true);
        return blocked("metadata_unavailable",error.status === null || error.status === 429 || error.status >= 500);
      }
      return blocked("identity_invalid");
    }
  } };
}
