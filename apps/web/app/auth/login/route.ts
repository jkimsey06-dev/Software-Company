import { createDashboardClient } from "../../../lib/dashboard/server";
import { parseEmail, sameOrigin } from "../../../lib/dashboard/auth-routes";

// POST /auth/login: emails a sign-in link to an existing owner. Sign-ups are
// off, and the answer is the same whether or not the address is known.
export async function POST(request: Request): Promise<Response> {
  const back = (q: string) => Response.redirect(new URL(`/login?${q}`, request.url), 303);
  if (!sameOrigin(request)) return new Response("Forbidden", { status: 403 });
  const email = parseEmail((await request.formData()).get("email"));
  if (!email) return back("error=bad_email");
  const db = await createDashboardClient();
  if (!db) return back("error=not_configured");
  const { error } = await db.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
  // Rate limits are worth telling people about; everything else looks the same.
  if (error?.status === 429) return back("error=slow_down");
  return back("sent=1");
}
