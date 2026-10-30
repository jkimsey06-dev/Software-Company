import { readTwilioWebhookEnv } from "./env";
import type { RouteDeps } from "./routes";
import { createServiceClient, createSupabaseStore } from "./supabase-store";
import { createTwilioSender } from "./twilio-sender";
import type { Logger } from "./types";

const log: Logger = (event, fields = {}) => {
  console.log(JSON.stringify({ event, ...fields }));
};

let cached: RouteDeps | undefined;

export function getRouteDeps(): RouteDeps {
  if (!cached) {
    const env = readTwilioWebhookEnv();
    cached = {
      store: createSupabaseStore(
        createServiceClient(env.supabaseUrl, env.supabaseServiceRoleKey),
        log,
      ),
      sender: createTwilioSender(env.twilioAccountSid, env.twilioAuthToken),
      publicBaseUrl: env.publicBaseUrl,
      twilioAuthToken: env.twilioAuthToken,
      log,
    };
  }
  return cached;
}
