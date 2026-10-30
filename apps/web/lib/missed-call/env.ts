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
  const valid = required as TwilioWebhookEnv;
  assertPublicOrigin(valid.publicBaseUrl);
  return valid;
}

// Twilio signs the exact URL it calls. A base URL with a path or the wrong
// scheme silently breaks every signature check, so fail loudly at startup.
export function assertPublicOrigin(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_BASE_URL is not a valid URL");
  }
  const localHttp = url.protocol === "http:" && url.hostname === "localhost";
  if ((url.protocol !== "https:" && !localHttp) || url.origin !== value.replace(/\/$/, "")) {
    throw new Error("PUBLIC_BASE_URL must be an https origin like https://app.example.com");
  }
}
