import type { OAuth2Client } from "google-auth-library";
import { errorLabel, type Logger } from "../missed-call/types";
import type { CalendarEnv } from "./access";
import { encryptToken } from "./crypto";
import { CALENDAR_SCOPES } from "./google";
import { verifyLinkToken } from "./link";
import type { CalendarStore } from "./store";

export interface CalendarRouteDeps {
  env: CalendarEnv | null;
  store: CalendarStore;
  oauth: () => OAuth2Client;
  log: Logger;
}

function page(status: number, title: string, text: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.4rem">${title}</h1><p>${text}</p></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

const INVALID = () =>
  page(400, "This link doesn't work", "It may have expired or already been used. Ask the person who sent it for a new one.");

// GET /api/calendar/connect?token=...  Sends the owner to Google's consent screen.
export function connectRoute(getDeps: () => CalendarRouteDeps) {
  return async (request: Request): Promise<Response> => {
    const deps = getDeps();
    if (!deps.env) return page(503, "Calendar connection isn't set up", "Please try again later.");
    const token = new URL(request.url).searchParams.get("token");
    if (!verifyLinkToken(token, deps.env.linkSecret)) return INVALID();
    const url = deps.oauth().generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: CALENDAR_SCOPES,
      include_granted_scopes: false,
      state: token as string,
    });
    return new Response(null, { status: 302, headers: { location: url, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  };
}

// GET /api/calendar/callback?code=...&state=...  Google sends the owner back here.
export function callbackRoute(getDeps: () => CalendarRouteDeps) {
  return async (request: Request): Promise<Response> => {
    const deps = getDeps();
    if (!deps.env) return page(503, "Calendar connection isn't set up", "Please try again later.");
    const params = new URL(request.url).searchParams;
    const link = verifyLinkToken(params.get("state"), deps.env.linkSecret);
    if (!link) return INVALID();
    if (params.get("error")) {
      return page(200, "Calendar not connected", "No changes were made. You can use the same link again to connect.");
    }
    const code = params.get("code");
    if (!code || code.length > 2000) return INVALID();

    // Single use: the link is spent once Google sends the owner back with a code.
    if (!(await deps.store.useLinkNonce(link.nonce, link.tenantId))) return INVALID();

    try {
      const oauth = deps.oauth();
      const { tokens } = await oauth.getToken(code);
      const granted = (tokens.scope ?? "").split(" ");
      if (!tokens.refresh_token || !CALENDAR_SCOPES.every((s) => granted.includes(s))) {
        deps.log("calendar.connect_incomplete", { tenantId: link.tenantId });
        return page(400, "Calendar not connected", "Please allow both calendar permissions. Ask for a new link to try again.");
      }
      await deps.store.saveConnection(link.tenantId, "primary", encryptToken(tokens.refresh_token, deps.env.tokenKey, link.tenantId));
      deps.log("calendar.connected", { tenantId: link.tenantId });
      return page(200, "Your calendar is connected", "Customers who text in can now pick a time for an estimate, and it'll show up on your calendar. You can close this page.");
    } catch (err) {
      deps.log("calendar.connect_failed", { tenantId: link.tenantId, error: errorLabel(err) });
      return page(500, "Something went wrong", "Your calendar wasn't connected. Ask for a new link to try again.");
    }
  };
}
