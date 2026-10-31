import { parseTokenHash } from "../../../lib/dashboard/auth-routes";
import { createDashboardClient } from "../../../lib/dashboard/server";

const HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" };

function page(status: number, body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Sign in</title></head><body style="font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;line-height:1.5">${body}</body></html>`,
    { status, headers: HEADERS },
  );
}

// GET /auth/confirm?token_hash=...  The emailed link lands here. It only shows
// a button: mail scanners that open links would otherwise use up the
// one-time token before the owner does.
export async function GET(request: Request): Promise<Response> {
  const token = parseTokenHash(new URL(request.url).searchParams.get("token_hash"));
  if (!token) return page(400, `<h1>This link doesn't work</h1><p><a href="/login">Request a new one</a>.</p>`);
  return page(
    200,
    `<h1>Sign in</h1><form method="post" action="/auth/confirm"><input type="hidden" name="token_hash" value="${token}"><button type="submit" style="font-size:1rem;padding:.6rem 1.2rem">Continue to your dashboard</button></form>`,
  );
}

// POST /auth/confirm  Exchanges the token for a session (set as cookies).
export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const raw = form.get("token_hash");
  const token = parseTokenHash(typeof raw === "string" ? raw : null);
  const fail = () => Response.redirect(new URL("/login?error=link_expired", request.url), 303);
  if (!token) return fail();
  const db = await createDashboardClient();
  if (!db) return fail();
  const { error } = await db.auth.verifyOtp({ token_hash: token, type: "email" });
  if (error) return fail();
  return Response.redirect(new URL("/dashboard", request.url), 303);
}
