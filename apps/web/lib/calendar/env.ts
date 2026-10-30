import { parseKey } from "./crypto";
import type { CalendarEnv } from "./access";

// Null when calendar booking isn't configured: the conversation then hands
// completed leads to the owner to schedule, as before.
export function readCalendarEnv(env: NodeJS.ProcessEnv = process.env): CalendarEnv | null {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, CALENDAR_TOKEN_KEY, CALENDAR_LINK_SECRET, PUBLIC_BASE_URL } = env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !CALENDAR_TOKEN_KEY || !CALENDAR_LINK_SECRET || !PUBLIC_BASE_URL) {
    return null;
  }
  if (CALENDAR_LINK_SECRET.length < 32) throw new Error("CALENDAR_LINK_SECRET must be at least 32 characters");
  return {
    googleClientId: GOOGLE_CLIENT_ID,
    googleClientSecret: GOOGLE_CLIENT_SECRET,
    tokenKey: parseKey(CALENDAR_TOKEN_KEY),
    linkSecret: CALENDAR_LINK_SECRET,
    redirectUri: new URL("/api/calendar/callback", PUBLIC_BASE_URL).toString(),
  };
}
