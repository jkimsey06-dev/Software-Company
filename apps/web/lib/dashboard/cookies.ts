import type { CookieOptions } from "@supabase/ssr";

const THIRTY_DAYS = 60 * 60 * 24 * 30;

// The dashboard never uses a Supabase client in the browser, so the session
// cookies can be HttpOnly (unreadable by page scripts), Secure in production,
// and shorter-lived than the library default.
export function sessionCookieOptions(options: CookieOptions | undefined): CookieOptions {
  return {
    ...options,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: Math.min(options?.maxAge ?? THIRTY_DAYS, THIRTY_DAYS),
  };
}
