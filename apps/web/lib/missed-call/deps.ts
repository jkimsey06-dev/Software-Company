import { after } from "next/server";
import { createNotificationStore } from "../notifications/supabase-store";
import { readNotificationEnv } from "../notifications/env";
import { createOpsAlert } from "../notifications/ops-alert";
import { createInboundSmsStore } from "../inbound-sms/supabase-store";
import type { SmsRouteDeps } from "../inbound-sms/routes";
import { createOwnerNotifier, createReplyNotifier, type Schedule } from "../notifications/owner";
import { createResendSender } from "../notifications/resend-sender";
import type { NotificationDeps } from "../notifications/types";
import { readTwilioWebhookEnv } from "./env";
import type { RouteDeps } from "./routes";
import { createServiceClient, createSupabaseStore } from "./supabase-store";
import { createTwilioSender } from "./twilio-sender";
import type { Logger } from "./types";

const log: Logger = (event, fields = {}) => {
  console.log(JSON.stringify({ event, ...fields }));
};

// Runs after the response is sent; the platform keeps the function alive for it.
const schedule: Schedule = (task) => after(task);

let cachedRoute: RouteDeps | undefined;
let cachedSms: SmsRouteDeps | undefined;
let cachedNotifications: NotificationDeps | null | undefined;

export function getNotificationDeps(): NotificationDeps | null {
  if (cachedNotifications === undefined) {
    const env = readNotificationEnv();
    if (!env) {
      log("notifications.disabled", { reason: "RESEND_API_KEY or NOTIFICATIONS_FROM_EMAIL not set" });
      cachedNotifications = null;
    } else {
      const twilioEnv = readTwilioWebhookEnv();
      const email = createResendSender(env.resendApiKey, env.fromEmail);
      cachedNotifications = {
        store: createNotificationStore(
          createServiceClient(twilioEnv.supabaseUrl, twilioEnv.supabaseServiceRoleKey),
        ),
        email,
        opsAlert: createOpsAlert(email, env.opsAlertEmail, log),
        log,
      };
    }
  }
  return cachedNotifications;
}

export function getRouteDeps(): RouteDeps {
  if (!cachedRoute) {
    const env = readTwilioWebhookEnv();
    const notifications = getNotificationDeps();
    cachedRoute = {
      store: createSupabaseStore(
        createServiceClient(env.supabaseUrl, env.supabaseServiceRoleKey),
        log,
      ),
      sender: createTwilioSender(env.twilioAccountSid, env.twilioAuthToken),
      publicBaseUrl: env.publicBaseUrl,
      twilioAuthToken: env.twilioAuthToken,
      log,
      notifyOwner: notifications ? createOwnerNotifier(notifications, schedule) : undefined,
      opsAlert: notifications?.opsAlert ?? createOpsAlert(null, undefined, log),
      schedule,
    };
  }
  return cachedRoute;
}

export function getSmsRouteDeps(): SmsRouteDeps {
  if (!cachedSms) {
    const env = readTwilioWebhookEnv();
    const notifications = getNotificationDeps();
    cachedSms = {
      store: createInboundSmsStore(
        createServiceClient(env.supabaseUrl, env.supabaseServiceRoleKey),
        log,
      ),
      log,
      twilioAuthToken: env.twilioAuthToken,
      publicBaseUrl: env.publicBaseUrl,
      notifyReply: notifications ? createReplyNotifier(notifications, schedule) : undefined,
      opsAlert: notifications?.opsAlert ?? createOpsAlert(null, undefined, log),
      schedule,
    };
  }
  return cachedSms;
}
