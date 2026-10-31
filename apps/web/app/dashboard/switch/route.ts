import { cookies } from "next/headers";
import { sameOrigin } from "../../../lib/dashboard/auth-routes";
import { TENANT_COOKIE } from "../../../lib/dashboard/tenant";
import { createDashboardClient, listMemberships } from "../../../lib/dashboard/server";

// POST /dashboard/switch: pick which business to look at. Only businesses the
// user belongs to are accepted.
export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return new Response("Forbidden", { status: 403 });
  const home = Response.redirect(new URL("/dashboard", request.url), 303);
  const db = await createDashboardClient();
  const user = db ? (await db.auth.getUser()).data.user : null;
  if (!db || !user) return home;
  const id = (await request.formData()).get("tenant");
  const memberships = await listMemberships(db, user.id);
  if (typeof id === "string" && memberships.some((m) => m.tenantId === id)) {
    (await cookies()).set(TENANT_COOKIE, id, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  }
  return home;
}
