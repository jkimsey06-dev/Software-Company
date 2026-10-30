import { errorLabel } from "../missed-call/types";
import { EmailSendError, type NotificationDeps } from "./types";

// Delay before attempt n+1 after attempt n fails. After the last, give up.
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

// Sends one queued notification if this caller wins the claim. Safe to call
// any number of times, from any number of places, for the same id.
export async function sendNotification(id: string, deps: NotificationDeps): Promise<void> {
  const { store, log } = deps;
  const claimed = await store.claim(id);
  if (!claimed) return;

  try {
    const { id: providerId } = await deps.email.send({
      to: claimed.recipientEmail,
      subject: claimed.subject,
      text: claimed.body,
      // Same key on every attempt: the provider drops a repeat of a sent email.
      idempotencyKey: `notification:${claimed.id}`,
    });
    await store.markSent(id, providerId);
    log("notification.sent", { tenantId: claimed.tenantId, notificationId: id });
  } catch (err) {
    const code = err instanceof EmailSendError ? err.code : errorLabel(err);
    const retryable = !(err instanceof EmailSendError) || err.retryable;
    const delay = retryable ? RETRY_DELAYS_MS[claimed.attempts - 1] : undefined;
    const retryAt = delay === undefined ? null : new Date(Date.now() + delay);
    await store.markFailed(id, code, retryAt);
    log("notification.failed", {
      tenantId: claimed.tenantId,
      notificationId: id,
      code,
      attempt: claimed.attempts,
      willRetry: retryAt !== null,
    });
    if (!retryAt) {
      await deps.opsAlert("notification.dead", {
        tenantId: claimed.tenantId,
        notificationId: id,
        code,
      });
    }
  }
}

// Cron entry point: retry everything that's due.
export async function sendDueNotifications(deps: NotificationDeps, limit = 50): Promise<number> {
  const ids = await deps.store.due(limit);
  for (const id of ids) {
    try {
      await sendNotification(id, deps);
    } catch (err) {
      deps.log("notification.dispatch_error", { notificationId: id, error: errorLabel(err) });
    }
  }
  return ids.length;
}
