import twilio from "twilio";
import { z } from "zod";

// Verifies X-Twilio-Signature against the public URL Twilio called, then returns
// the form params. Returns null if the request is not provably from Twilio.
export async function readVerifiedTwilioForm(
  request: Request,
  authToken: string,
  publicBaseUrl: string,
): Promise<Record<string, string> | null> {
  const signature = request.headers.get("x-twilio-signature");
  if (!signature) return null;
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
    return null;
  }

  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form) {
    if (typeof value !== "string") return null;
    params[key] = value;
  }

  // Use the configured public URL, not the Host header, which the caller controls.
  const { pathname, search } = new URL(request.url);
  const signedUrl = new URL(pathname + search, publicBaseUrl).toString();
  return twilio.validateRequest(authToken, signature, signedUrl, params) ? params : null;
}

const callSid = z.string().regex(/^CA[0-9a-f]{32}$/);
const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/);
// From can be "anonymous", "restricted" etc. when caller ID is withheld.
const from = z.string().max(32);

export const inboundCallParams = z.object({
  CallSid: callSid,
  To: e164,
  From: from,
});

export const dialStatusParams = inboundCallParams.extend({
  DialCallStatus: z.string().min(1).max(32),
});
