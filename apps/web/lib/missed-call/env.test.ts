import { describe, expect, it } from "vitest";
import { assertPublicOrigin, readTwilioWebhookEnv } from "./env";

const env = {
  TWILIO_ACCOUNT_SID: "AC-test",
  TWILIO_AUTH_TOKEN: "token-test",
  PUBLIC_BASE_URL: "https://app.example.com",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-test",
} as unknown as NodeJS.ProcessEnv;

describe("readTwilioWebhookEnv", () => {
  it("reads a complete environment", () => {
    expect(readTwilioWebhookEnv(env).publicBaseUrl).toBe("https://app.example.com");
  });

  it("names missing variables without printing values", () => {
    expect(() => readTwilioWebhookEnv({ ...env, TWILIO_AUTH_TOKEN: "" })).toThrow(
      /TWILIO_AUTH_TOKEN|twilioAuthToken/,
    );
  });
});

describe("assertPublicOrigin", () => {
  it.each(["https://app.example.com", "https://app.example.com/", "http://localhost:3000"])(
    "accepts %s",
    (value) => expect(() => assertPublicOrigin(value)).not.toThrow(),
  );

  it.each([
    "http://app.example.com",
    "https://app.example.com/api",
    "https://app.example.com?x=1",
    "app.example.com",
    "",
  ])("rejects %j", (value) => expect(() => assertPublicOrigin(value)).toThrow());
});
