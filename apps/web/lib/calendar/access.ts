import type { TenantConfig } from "@sc/shared";
import type { CalendarAccess } from "../conversation/types";
import { errorLabel, type Logger } from "../missed-call/types";
import { sendNotification } from "../notifications/dispatch";
import type { NotificationDeps } from "../notifications/types";
import { decryptToken } from "./crypto";
import { createGoogleCalendar, oauthClient } from "./google";
import type { CalendarStore } from "./store";

export interface CalendarEnv {
  googleClientId: string;
  googleClientSecret: string;
  tokenKey: Buffer;
  linkSecret: string;
  redirectUri: string;
}

// Returns a tenant's calendar client, or why it can't be used.
export function createCalendarAccess(store: CalendarStore, env: CalendarEnv, log: Logger) {
  return async (tenantId: string): Promise<CalendarAccess> => {
    try {
      const conn = await store.getConnection(tenantId);
      if (!conn) return { ok: false, reason: "not_connected" };
      if (conn.status === "revoked") return { ok: false, reason: "revoked" };
      const refreshToken = decryptToken(conn.refreshTokenEnc, env.tokenKey, tenantId);
      const oauth = oauthClient(env.googleClientId, env.googleClientSecret, env.redirectUri);
      return { ok: true, client: createGoogleCalendar(oauth, refreshToken, conn.calendarId) };
    } catch (err) {
      log("calendar.access_failed", { tenantId, error: errorLabel(err) });
      return { ok: false, reason: "unavailable" };
    }
  };
}

// Google says access is gone: stop using it and ask the owner (once a day) to reconnect.
export function createRevokedHandler(
  store: CalendarStore,
  loadConfig: (tenantId: string) => Promise<TenantConfig>,
  notifications: NotificationDeps | null,
  now: () => Date = () => new Date(),
) {
  return async (tenantId: string): Promise<void> => {
    await store.markRevoked(tenantId);
    const config = await loadConfig(tenantId);
    const to = config.escalationContact.email;
    if (!notifications || !to) return;
    const day = now().toISOString().slice(0, 10);
    const id = await notifications.store.enqueue({
      tenantId,
      kind: "calendar_reconnect",
      idempotencyKey: `calendar-reconnect:${day}`,
      leadId: null,
      recipientEmail: to,
      subject: "Your calendar needs to be reconnected",
      body: [
        `The text assistant for ${config.businessName} can't reach your Google Calendar anymore, so it can't offer estimate times.`,
        "",
        "Customers are still being texted back, and you're still getting their details by email.",
        "",
        "Reply to the person who set this up for you, and they'll send a new link to reconnect.",
      ].join("\n"),
    });
    if (id) await sendNotification(id, notifications);
  };
}
