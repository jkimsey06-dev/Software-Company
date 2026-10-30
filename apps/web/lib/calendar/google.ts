import { OAuth2Client } from "google-auth-library";
import type { BusyInterval } from "@sc/shared";

export const CALENDAR_SCOPES = [
  // When the owner is busy (no event details).
  "https://www.googleapis.com/auth/calendar.freebusy",
  // Create events on calendars the owner owns.
  "https://www.googleapis.com/auth/calendar.events.owned",
];

// The owner revoked access or the token is invalid: they must reconnect.
export class CalendarAuthError extends Error {
  constructor() {
    super("calendar access revoked or invalid");
    this.name = "CalendarAuthError";
  }
}

// Google unreachable or errored: try again later; don't book.
export class CalendarUnavailableError extends Error {
  constructor(readonly code: string) {
    super(`calendar unavailable (${code})`);
    this.name = "CalendarUnavailableError";
  }
}

export interface CalendarEvent {
  // Deterministic, so a retry finds the event instead of creating another.
  id: string;
  start: Date;
  end: Date;
  summary: string;
  description: string;
  location: string;
}

export interface CalendarClient {
  busy(from: Date, to: Date): Promise<BusyInterval[]>;
  // "created", or "exists" if an event with this id is already there.
  createEvent(event: CalendarEvent): Promise<"created" | "exists">;
}

export function oauthClient(clientId: string, clientSecret: string, redirectUri: string): OAuth2Client {
  return new OAuth2Client({ clientId, clientSecret, redirectUri });
}

function status(err: unknown): number | undefined {
  return (err as { response?: { status?: number }; status?: number }).response?.status ?? (err as { status?: number }).status;
}

function mapError(err: unknown): Error {
  const message = String((err as { message?: string }).message ?? "");
  if (message.includes("invalid_grant") || status(err) === 401) return new CalendarAuthError();
  return new CalendarUnavailableError(String(status(err) ?? "network"));
}

export function createGoogleCalendar(
  oauth: OAuth2Client,
  refreshToken: string,
  calendarId: string,
): CalendarClient {
  oauth.setCredentials({ refresh_token: refreshToken });
  const base = "https://www.googleapis.com/calendar/v3";
  return {
    async busy(from, to) {
      try {
        const res = await oauth.request<{ calendars: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> }>({
          url: `${base}/freeBusy`,
          method: "POST",
          data: { timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: calendarId }] },
          timeout: 8_000,
        });
        const cal = res.data.calendars?.[calendarId];
        if (!cal || cal.errors?.length) throw new CalendarUnavailableError("calendar_error");
        return (cal.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
      } catch (err) {
        throw err instanceof CalendarUnavailableError ? err : mapError(err);
      }
    },

    async createEvent(e) {
      try {
        await oauth.request({
          url: `${base}/calendars/${encodeURIComponent(calendarId)}/events`,
          method: "POST",
          data: {
            id: e.id,
            summary: e.summary,
            description: e.description,
            location: e.location,
            start: { dateTime: e.start.toISOString() },
            end: { dateTime: e.end.toISOString() },
          },
          timeout: 8_000,
        });
        return "created";
      } catch (err) {
        // Same id already exists: an earlier attempt booked it.
        if (status(err) === 409) return "exists";
        throw mapError(err);
      }
    },
  };
}

// Google event ids: 5-1024 chars of base32hex (0-9, a-v).
export function eventIdFor(conversationId: string, start: Date): string {
  return `sc${conversationId.replace(/-/g, "")}${start.getTime().toString(32)}`;
}
