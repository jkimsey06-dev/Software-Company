import type { OwnerNotifier } from "../missed-call/handle-call";
import { errorLabel } from "../missed-call/types";
import { sendNotification } from "./dispatch";
import { renderNewLeadEmail, renderTextbackFailedEmail } from "./templates";
import type { NotificationDeps } from "./types";

// Runs work after the webhook has answered Twilio (Next's `after()` in prod).
export type Schedule = (task: () => Promise<void>) => void;

// Queues the owner email, then sends it after the response. If the immediate
// send fails or never runs, the cron retry picks the row up.
export function createOwnerNotifier(deps: NotificationDeps, schedule: Schedule): OwnerNotifier {
  return async (lead) => {
    const { tenantId, config, leadId, log } = { ...lead, log: deps.log };
    const to = config.escalationContact.email;
    if (!to) {
      log("notification.skipped", { tenantId, leadId, reason: "no_owner_email" });
      return;
    }

    try {
      // One email per lead, however many times they call.
      const newLead = renderNewLeadEmail(config, lead);
      let id = await deps.store.enqueue({
        tenantId,
        kind: "new_lead",
        idempotencyKey: `new-lead:${leadId}`,
        leadId,
        recipientEmail: to,
        subject: newLead.subject,
        body: newLead.body,
      });

      // A repeat caller whose text-back failed: the owner already has the lead
      // email, but needs to know this text didn't go out.
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

      if (id) {
        const notificationId = id;
        schedule(() =>
          sendNotification(notificationId, deps).catch((err) =>
            log("notification.dispatch_error", { notificationId, error: errorLabel(err) }),
          ),
        );
      }
    } catch (err) {
      // Never break the call flow over a notification; ops hears about it.
      log("notification.enqueue_failed", { tenantId, leadId, error: errorLabel(err) });
      await deps.opsAlert("notification.enqueue_failed", { tenantId, leadId, error: errorLabel(err) });
    }
  };
}
