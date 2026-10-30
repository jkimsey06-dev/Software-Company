import type { OwnerNotifier } from "../missed-call/handle-call";
import { errorLabel } from "../missed-call/types";
import { sendNotification } from "./dispatch";
import type { ReplyNotifier } from "../inbound-sms/types";
import { renderCustomerReplyEmail, renderNewLeadEmail, renderTextbackFailedEmail } from "./templates";
import type { NotificationDeps } from "./types";

// Runs work after the webhook has answered Twilio (Next's `after()` in prod).
export type Schedule = (task: () => Promise<void>) => void;

// Queues and sends the owner email after the response, so a slow or failing
// database or email provider never keeps the caller waiting. If the immediate
// send fails, the cron retry picks the row up.
export function createOwnerNotifier(deps: NotificationDeps, schedule: Schedule): OwnerNotifier {
  return async (lead) => {
    const { tenantId, config, leadId } = lead;
    const { log } = deps;
    const to = config.escalationContact.email;
    if (!to) {
      log("notification.skipped", { tenantId, leadId, reason: "no_owner_email" });
      return;
    }

    schedule(async () => {
      let id: string | null;
      try {
        // One email per lead, however many times they call.
        const newLead = renderNewLeadEmail(config, lead);
        id = await deps.store.enqueue({
          tenantId,
          kind: "new_lead",
          idempotencyKey: `new-lead:${leadId}`,
          leadId,
          recipientEmail: to,
          subject: newLead.subject,
          body: newLead.body,
        });

        // A repeat caller whose text-back failed: the owner already has the
        // lead email, but needs to know this text didn't go out.
        const failed = lead.textback.kind === "failed" || lead.textback.kind === "unknown";
        if (!id && failed && lead.messageId) {
          const email = renderTextbackFailedEmail(config, lead);
          id = await deps.store.enqueue({
            tenantId,
            kind: "textback_failed",
            idempotencyKey: `textback-failed:${lead.messageId}`,
            leadId,
            recipientEmail: to,
            subject: email.subject,
            body: email.body,
          });
        }
      } catch (err) {
        const error = errorLabel(err);
        log("notification.enqueue_failed", { tenantId, leadId, error });
        await deps.opsAlert("notification.enqueue_failed", { tenantId, leadId, error });
        return;
      }

      if (id) {
        const notificationId = id;
        await sendNotification(notificationId, deps).catch((err) =>
          log("notification.dispatch_error", { notificationId, error: errorLabel(err) }),
        );
      }
    });
  };
}

// Forwards a customer's text to the owner, after the response. One email per
// Twilio message.
export function createReplyNotifier(deps: NotificationDeps, schedule: Schedule): ReplyNotifier {
  return (reply) => {
    const { tenantId, config, leadId, messageSid } = reply;
    const to = config.escalationContact.email;
    if (!to) {
      deps.log("notification.skipped", { tenantId, messageSid, reason: "no_owner_email" });
      return;
    }
    schedule(async () => {
      let id: string | null;
      try {
        const email = renderCustomerReplyEmail(config, reply);
        id = await deps.store.enqueue({
          tenantId,
          kind: "customer_reply",
          idempotencyKey: `customer-reply:${messageSid}`,
          leadId,
          recipientEmail: to,
          subject: email.subject,
          body: email.body,
        });
      } catch (err) {
        const error = errorLabel(err);
        deps.log("notification.enqueue_failed", { tenantId, messageSid, error });
        await deps.opsAlert("notification.enqueue_failed", { tenantId, messageSid, error });
        return;
      }
      if (id) {
        const notificationId = id;
        await sendNotification(notificationId, deps).catch((err) =>
          deps.log("notification.dispatch_error", { notificationId, error: errorLabel(err) }),
        );
      }
    });
  };
}
