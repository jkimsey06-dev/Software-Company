import { after } from "next/server";
import { createNotificationStore } from "../notifications/supabase-store";
import { readNotificationEnv } from "../notifications/env";
import { createOpsAlert } from "../notifications/ops-alert";
import { createClaudeConversationModel } from "@sc/ai";
import { handleCustomerMessage } from "../conversation/run-turn";
import { createConversationStore } from "../conversation/supabase-store";
import { createInboundSmsStore } from "../inbound-sms/supabase-store";
import type { Converse } from "../inbound-sms/types";
import { errorLabel } from "./types";
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
    const db = createServiceClient(env.supabaseUrl, env.supabaseServiceRoleKey);
    const notifications = getNotificationDeps();
    const smsStore = createInboundSmsStore(db, log);
    const notifyReply = notifications ? createReplyNotifier(notifications, schedule) : undefined;
    const opsAlert = notifications?.opsAlert ?? createOpsAlert(null, undefined, log);

    // The AI conversation runs only when ANTHROPIC_API_KEY is set; otherwise
    // every customer text goes to the owner, as before.
    const converse: Converse | undefined = process.env.ANTHROPIC_API_KEY
      ? (message) =>
          schedule(async () => {
            let handled = false;
            let config;
            try {
              config = await smsStore.loadTenantConfig(message.tenantId);
              handled = await handleCustomerMessage(
                { ...message, config },
                {
                  store: createConversationStore(db),
                  sender: createTwilioSender(env.twilioAccountSid, env.twilioAuthToken),
                  modelFor: (c) => createClaudeConversationModel(c),
                  notifications,
                  log,
                },
              );
            } catch (err) {
              const error = errorLabel(err);
              log("conversation.error", { tenantId: message.tenantId, messageSid: message.messageSid, error });
              await opsAlert("conversation.error", { tenantId: message.tenantId, messageSid: message.messageSid, error });
            }
            // The AI didn't take it (or failed): the owner sees the text.
            if (!handled && config && notifyReply) {
              notifyReply({ ...message, config, callerPhone: message.customerPhone, optedOut: false });
            }
          })
      : undefined;

    cachedSms = {
      store: smsStore,
      log,
      twilioAuthToken: env.twilioAuthToken,
      publicBaseUrl: env.publicBaseUrl,
      notifyReply,
      converse,
      opsAlert,
      schedule,
    };
  }
  return cachedSms;
}
