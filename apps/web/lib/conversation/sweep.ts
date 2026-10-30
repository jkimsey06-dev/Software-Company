import type { TenantConfig } from "@sc/shared";
import { errorLabel } from "../missed-call/types";
import { sendNotification } from "../notifications/dispatch";
import { renderCustomerReplyEmail } from "../notifications/templates";
import type { NotificationDeps } from "../notifications/types";
import type { ConversationStore } from "./types";

// A worker killed mid-turn (timeout, crash) can leave a customer text with no
// reply and no owner email. The cron forwards those to the owner, so nothing
// is silently lost. Same key as the normal forward, so never twice.
export async function forwardUnhandledMessages(
  store: ConversationStore,
  loadConfig: (tenantId: string) => Promise<TenantConfig>,
  notifications: NotificationDeps,
): Promise<number> {
  const messages = await store.findUnhandled(3, 50);
  let forwarded = 0;
  for (const m of messages) {
    try {
      const config = await loadConfig(m.tenantId);
      const to = config.escalationContact.email;
      if (!to) continue;
      const email = renderCustomerReplyEmail(config, {
        callerPhone: m.fromPhone,
        body: m.body,
        numMedia: 0,
        receivedAt: m.createdAt,
      });
      const id = await notifications.store.enqueue({
        tenantId: m.tenantId,
        kind: "customer_reply",
        idempotencyKey: `customer-reply:${m.messageSid}`,
        leadId: m.leadId,
        recipientEmail: to,
        subject: email.subject,
        body: email.body,
      });
      if (id) {
        forwarded += 1;
        await sendNotification(id, notifications);
      }
    } catch (err) {
      notifications.log("conversation.sweep_failed", { tenantId: m.tenantId, messageSid: m.messageSid, error: errorLabel(err) });
    }
  }
  if (forwarded > 0) await notifications.opsAlert("conversation.unhandled_forwarded", { count: String(forwarded) });
  return forwarded;
}
