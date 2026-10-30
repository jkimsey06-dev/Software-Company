import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Signed, single-use, expiring link that lets a client's owner connect their
// Google Calendar without an account in our app. We print it for the operator
// to send; nothing here sends anything. Single use is enforced at callback
// time by recording the nonce.

const DEFAULT_TTL_MS = 7 * 24 * 3_600_000;

interface Payload {
  t: string; // tenant id
  e: number; // expires at, ms
  n: string; // nonce
  i: number; // issued at, ms
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function createLinkToken(tenantId: string, secret: string, now = Date.now(), ttlMs = DEFAULT_TTL_MS): string {
  if (secret.length < 32) throw new Error("CALENDAR_LINK_SECRET must be at least 32 characters");
  const body = Buffer.from(JSON.stringify({ t: tenantId, e: now + ttlMs, n: randomBytes(16).toString("base64url"), i: now } satisfies Payload)).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

export function verifyLinkToken(
  token: string | null,
  secret: string | undefined,
  now = Date.now(),
): { tenantId: string; nonce: string; issuedAt: number } | null {
  if (!token || !secret || secret.length < 32 || token.length > 1000) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = Buffer.from(sign(body, secret));
  const actual = Buffer.from(mac);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.t !== "string" || typeof payload.n !== "string" || typeof payload.e !== "number" || typeof payload.i !== "number") return null;
  if (!/^[0-9a-f-]{36}$/.test(payload.t) || payload.e < now || payload.i > now) return null;
  return { tenantId: payload.t, nonce: payload.n, issuedAt: payload.i };
}
