import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { sessionCookieOptions } from "./lib/dashboard/cookies";
import { readSupabasePublicEnv } from "./lib/dashboard/env";

// Keeps the owner's Supabase session fresh on dashboard pages (refreshed
// tokens are written back as cookies). Access decisions are made by each page.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const env = readSupabasePublicEnv();
  if (!env) return response;
  const db = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, sessionCookieOptions(options));
      },
    },
  });
  await db.auth.getUser();
  return response;
}

export const config = { matcher: ["/dashboard/:path*"] };
