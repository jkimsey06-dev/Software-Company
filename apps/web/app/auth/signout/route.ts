import { sameOrigin } from "../../../lib/dashboard/auth-routes";
import { createDashboardClient } from "../../../lib/dashboard/server";

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return new Response("Forbidden", { status: 403 });
  const db = await createDashboardClient();
  await db?.auth.signOut();
  return Response.redirect(new URL("/login", request.url), 303);
}
