// Server-only configuration for the Twilio webhooks.
export interface TwilioWebhookEnv {
  twilioAccountSid: string;
  twilioAuthToken: string;
  publicBaseUrl: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
}

export function readTwilioWebhookEnv(env: NodeJS.ProcessEnv = process.env): TwilioWebhookEnv {
  const required = {
    twilioAccountSid: env.TWILIO_ACCOUNT_SID,
    twilioAuthToken: env.TWILIO_AUTH_TOKEN,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`Missing environment variables for Twilio webhooks: ${missing.join(", ")}`);
  }
  return required as TwilioWebhookEnv;
}
