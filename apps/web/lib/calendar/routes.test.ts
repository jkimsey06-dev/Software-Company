import { randomBytes } from "node:crypto";
import type { OAuth2Client } from "google-auth-library";
import { describe, expect, it } from "vitest";
import { recordingLogger } from "../missed-call/test-helpers";
import { decryptToken } from "./crypto";
import { CALENDAR_SCOPES } from "./google";
import { createLinkToken } from "./link";
import { callbackRoute, connectRoute } from "./routes";
import type { CalendarStore } from "./store";

const TENANT = "10000000-0000-4000-8000-000000000001";
const SECRET = "s".repeat(40);

function setup(tokens: { refresh_token?: string; scope?: string } = { refresh_token: "1//rt", scope: CALENDAR_SCOPES.join(" ") }) {
  const saved: { tenantId: string; calendarId: string; enc: string }[] = [];
  const nonces = new Set<string>();
  const alerts: string[] = [];
  const existing: { current: Awaited<ReturnType<CalendarStore["getConnection"]>> } = { current: null };
  const store: CalendarStore = {
    getConnection: async () => existing.current,
    saveConnection: async (tenantId, calendarId, enc) => void saved.push({ tenantId, calendarId, enc }),
    markRevoked: async () => undefined,
    useLinkNonce: async (nonce) => (nonces.has(nonce) ? false : (nonces.add(nonce), true)),
  };
  const authUrls: Record<string, unknown>[] = [];
  const oauth = {
    generateAuthUrl: (o: Record<string, unknown>) => (authUrls.push(o), "https://accounts.google.com/o/oauth2/v2/auth?x=1"),
    getToken: async () => ({ tokens }),
  } as unknown as OAuth2Client;
  const key = randomBytes(32);
  const deps = {
    env: { googleClientId: "id", googleClientSecret: "secret", tokenKey: key, linkSecret: SECRET, redirectUri: "https://app.example.com/api/calendar/callback" },
    store,
    oauth: () => oauth,
    log: recordingLogger(),
    opsAlert: async (event: string) => void alerts.push(event),
  };
  return { deps, saved, authUrls, key, alerts, existing };
}

const connect = (token: string) => new Request(`https://app.example.com/api/calendar/connect?token=${encodeURIComponent(token)}`);
const callback = (state: string, extra = "&code=abc") => new Request(`https://app.example.com/api/calendar/callback?state=${encodeURIComponent(state)}${extra}`);

describe("connect", () => {
  it("sends a valid link to Google's consent screen with offline access and only our scopes", async () => {
    const s = setup();
    const token = createLinkToken(TENANT, SECRET);
    const res = await connectRoute(() => s.deps)(connect(token));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(s.authUrls[0]).toMatchObject({ access_type: "offline", prompt: "consent", scope: CALENDAR_SCOPES, state: token });
  });

  it.each(["", "garbage", createLinkToken(TENANT, "x".repeat(40))])("rejects a bad link %#", async (token) => {
    const s = setup();
    expect((await connectRoute(() => s.deps)(connect(token))).status).toBe(400);
  });

  it("says so when calendar isn't configured", async () => {
    const s = setup();
    expect((await connectRoute(() => ({ ...s.deps, env: null }))(connect("x"))).status).toBe(503);
  });
});

describe("callback", () => {
  it("stores the refresh token encrypted for that tenant, once", async () => {
    const s = setup();
    const token = createLinkToken(TENANT, SECRET);
    const res = await callbackRoute(() => s.deps)(callback(token));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Your calendar is connected");
    expect(s.saved).toHaveLength(1);
    expect(s.saved[0]).toMatchObject({ tenantId: TENANT, calendarId: "primary" });
    expect(s.saved[0]!.enc).not.toContain("1//rt");
    expect(decryptToken(s.saved[0]!.enc, s.key, TENANT)).toBe("1//rt");

    // The same link can't be used again.
    expect((await callbackRoute(() => s.deps)(callback(token))).status).toBe(400);
    expect(s.saved).toHaveLength(1);
  });

  it("refuses a tampered or expired state", async () => {
    const s = setup();
    const expired = createLinkToken(TENANT, SECRET, Date.now() - 8 * 24 * 3_600_000);
    expect((await callbackRoute(() => s.deps)(callback(expired))).status).toBe(400);
    expect((await callbackRoute(() => s.deps)(callback("forged.state"))).status).toBe(400);
    expect(s.saved).toHaveLength(0);
  });

  it.each([
    ["no refresh token", { scope: CALENDAR_SCOPES.join(" ") }],
    ["a missing permission", { refresh_token: "1//rt", scope: CALENDAR_SCOPES[0] }],
  ])("doesn't save with %s", async (_name, tokens) => {
    const s = setup(tokens);
    const res = await callbackRoute(() => s.deps)(callback(createLinkToken(TENANT, SECRET)));
    expect(res.status).toBe(400);
    expect(s.saved).toHaveLength(0);
  });

  it("an owner who cancels on Google's screen can use the link again", async () => {
    const s = setup();
    const token = createLinkToken(TENANT, SECRET);
    expect((await callbackRoute(() => s.deps)(callback(token, "&error=access_denied"))).status).toBe(200);
    expect((await callbackRoute(() => s.deps)(callback(token))).status).toBe(200);
    expect(s.saved).toHaveLength(1);
  });

  it("a link issued before the current connection can't replace it", async () => {
    const s = setup();
    const old = createLinkToken(TENANT, SECRET, Date.now() - 3_600_000);
    s.existing.current = { calendarId: "primary", refreshTokenEnc: "v1.x", status: "connected", connectedAt: new Date(Date.now() - 60_000) };
    expect((await callbackRoute(() => s.deps)(callback(old))).status).toBe(400);
    expect(s.saved).toHaveLength(0);
  });

  it("a newer link replaces a connection, and ops is told", async () => {
    const s = setup();
    s.existing.current = { calendarId: "primary", refreshTokenEnc: "v1.x", status: "connected", connectedAt: new Date(Date.now() - 3_600_000) };
    expect((await callbackRoute(() => s.deps)(callback(createLinkToken(TENANT, SECRET)))).status).toBe(200);
    expect(s.saved).toHaveLength(1);
    expect(s.alerts).toEqual(["calendar.connection_replaced"]);
  });

  it("a database error while spending the link shows an error page", async () => {
    const s = setup();
    s.deps.store.useLinkNonce = async () => {
      throw new Error("supabase down");
    };
    expect((await callbackRoute(() => s.deps)(callback(createLinkToken(TENANT, SECRET)))).status).toBe(500);
  });

  it("never logs or shows the token", async () => {
    const s = setup();
    const res = await callbackRoute(() => s.deps)(callback(createLinkToken(TENANT, SECRET)));
    expect(await res.text()).not.toContain("1//rt");
    expect(s.deps.log.lines.join()).not.toContain("1//rt");
  });
});
