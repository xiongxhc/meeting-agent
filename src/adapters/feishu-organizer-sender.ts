import { Client, Domain } from "@larksuiteoapi/node-sdk";
import type { RedactedSecret } from "../config.ts";
import { boundedInviteString, validateFeishuScope, type FeishuScope } from "../ports/feishu-ingress.ts";
import type { FeishuMessageSender } from "../ports/feishu.ts";
import { FeishuHttpError, redactedFeishuLogger, type FeishuSdkHttp } from "./feishu-sdk-http.ts";

/** A send outcome the notification worker classifies. `ambiguous` is the only
 * kind that becomes the worker's durable `uncertain`: the request may have
 * reached Feishu, so the durable UUID (not a new one) is what a later attempt
 * replays inside the one-hour dedup window. */
class NotificationSendError extends Error {
  readonly deliveryKind?: "ambiguous";
  constructor(code: "notification_send_rejected" | "notification_send_failed" | "notification_send_timeout", ambiguous = false) {
    super(code);
    if (ambiguous) this.deliveryKind = "ambiguous";
  }
}

/** The organizer DM sender. The tenant access token is acquired, cached and
 * attached by the SDK's own token manager over the shared `http` seam; Meeting
 * never reads, stores or logs it, and never retries (the worker owns retries,
 * the attempt journal and the dedup window). */
export function createFeishuOrganizerSender(options: FeishuScope & {
  readonly appSecret: RedactedSecret; readonly http: FeishuSdkHttp; readonly log?: (code: string) => void;
}): FeishuMessageSender {
  validateFeishuScope(options);
  const log = options.log ?? ((): void => {});
  const client = new Client({ appId: options.appId, appSecret: options.appSecret.reveal(),
    domain: options.region === "feishu" ? Domain.Feishu : Domain.Lark,
    httpInstance: options.http.instance, logger: redactedFeishuLogger(options.log) });
  return { async sendText({ receiveId, text, uuid, timeoutMs }) {
    boundedInviteString(receiveId); boundedInviteString(uuid);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("invalid_notification_timeout");
    const deadline = AbortSignal.timeout(timeoutMs);
    try {
      const response = await options.http.withSignal(deadline, () => client.im.v1.message.create({
        params: { receive_id_type: "open_id" },
        data: { receive_id: receiveId, msg_type: "text", content: JSON.stringify({ text }), uuid },
      }));
      const messageId = response.data?.message_id;
      if (response.code !== 0 || typeof messageId !== "string" || messageId.length === 0) {
        log("notification_send_rejected");
        throw new NotificationSendError("notification_send_rejected");
      }
      return { messageId };
    } catch (error) {
      if (error instanceof NotificationSendError) throw error;
      // An unanswered request is ambiguous whichever budget expired first:
      // the adapter's exact `timeoutMs` or the seam's own transport budget.
      if (deadline.aborted || (error instanceof FeishuHttpError && error.message === "feishu_http_timeout")) {
        log("notification_send_timeout");
        throw new NotificationSendError("notification_send_timeout", true);
      }
      log("notification_send_failed");
      throw new NotificationSendError("notification_send_failed");
    }
  } };
}
