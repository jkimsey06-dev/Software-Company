import twilio from "twilio";
import { z } from "zod";

// Twilio voice webhooks are a few KB. Anything bigger isn't from Twilio.
const MAX_BODY_BYTES = 64 * 1024;

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

  const declared = Number(request.headers.get("content-length"));
  if (declared > MAX_BODY_BYTES) return null;
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return null;

  // Null prototype: a key like "__proto__" is just a key.
  const params: Record<string, string> = Object.create(null);
  for (const [key, value] of new URLSearchParams(body)) {
    // Twilio never repeats a key; a repeat means the body was tampered with.
    if (Object.hasOwn(params, key)) return null;
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

// Messaging webhook. Body can be empty (a photo with no text). Twilio caps a
// message at 1600 characters, but emoji count double here, so allow more.
export const inboundSmsParams = z.object({
  MessageSid: z.string().regex(/^(SM|MM)[0-9a-f]{32}$/),
  From: from,
  To: e164,
  Body: z.string().max(5000).default(""),
  NumMedia: z.coerce.number().int().min(0).max(10).default(0),
  // Set by Advanced Opt-Out on keyword messages; unknown values are ignored.
  OptOutType: z.string().max(16).optional(),
});
