import twilio from "twilio";
import { describe, expect, it } from "vitest";
import { dialStatusRoute, voiceRoute, type RouteDeps } from "./routes";
import {
  BASE_URL,
  BUSINESS_NUMBER,
  CALLER,
  CALL_SID,
  FakeSender,
  FakeStore,
  recordingLogger,
} from "./test-helpers";

const AUTH_TOKEN = "test-auth-token-not-real";

function setup() {
  const store = new FakeStore();
  const sender = new FakeSender();
  const deps: RouteDeps = {
    store,
    sender,
    log: recordingLogger(),
    publicBaseUrl: BASE_URL,
    twilioAuthToken: AUTH_TOKEN,
  };
  return { store, sender, deps };
}

function twilioRequest(
  path: string,
  params: Record<string, string>,
  opts: { signature?: string | null; signedUrl?: string; requestHost?: string } = {},
) {
  const signedUrl = opts.signedUrl ?? `${BASE_URL}${path}`;
  const signature =
    opts.signature === undefined
      ? twilio.getExpectedTwilioSignature(AUTH_TOKEN, signedUrl, params)
      : opts.signature;
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (signature !== null) headers["x-twilio-signature"] = signature;
  // Vercel may hand the function an internal host; the signature check must
  // use the configured public URL instead.
  return new Request(`${opts.requestHost ?? "http://internal.local"}${path}`, {
    method: "POST",
    headers,
    body: new URLSearchParams(params).toString(),
  });
}

const VOICE = "/api/twilio/voice";
const STATUS = "/api/twilio/voice/status";
const callParams = { CallSid: CALL_SID, From: CALLER, To: BUSINESS_NUMBER, AccountSid: "AC123" };
const statusParams = { ...callParams, DialCallStatus: "no-answer" };

describe("Twilio webhook routes", () => {
  it("answers a signed voice webhook with TwiML", async () => {
    const { deps } = setup();
    const res = await voiceRoute(() => deps)(twilioRequest(VOICE, callParams));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/xml");
    expect(await res.text()).toContain("<Dial");
  });

  it("texts back on a signed missed-call status webhook", async () => {
    const { deps, sender } = setup();
    const res = await dialStatusRoute(() => deps)(twilioRequest(STATUS, statusParams));
    expect(res.status).toBe(200);
    expect(sender.sent).toHaveLength(1);
  });

  it("rejects a request with no signature and touches nothing", async () => {
    const { deps, store, sender } = setup();
    const res = await dialStatusRoute(() => deps)(twilioRequest(STATUS, statusParams, { signature: null }));
    expect(res.status).toBe(403);
    expect(store.calls.size).toBe(0);
    expect(sender.sent).toHaveLength(0);
  });

  it("rejects a forged signature", async () => {
    const { deps, sender } = setup();
    const forged = twilio.getExpectedTwilioSignature("wrong-token", `${BASE_URL}${STATUS}`, statusParams);
    const res = await dialStatusRoute(() => deps)(twilioRequest(STATUS, statusParams, { signature: forged }));
    expect(res.status).toBe(403);
    expect(sender.sent).toHaveLength(0);
  });

  it("rejects a signature made for a different URL", async () => {
    const { deps } = setup();
    const res = await voiceRoute(() => deps)(
      twilioRequest(VOICE, callParams, { signedUrl: "https://attacker.example/api/twilio/voice" }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects params changed after signing", async () => {
    const { deps, sender } = setup();
    const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${BASE_URL}${STATUS}`, {
      ...statusParams,
      DialCallStatus: "completed",
    });
    const res = await dialStatusRoute(() => deps)(twilioRequest(STATUS, statusParams, { signature }));
    expect(res.status).toBe(403);
    expect(sender.sent).toHaveLength(0);
  });

  it("does not trust the request's Host header", async () => {
    const { deps } = setup();
    // Signed for the attacker's host, sent with the attacker's host: still rejected.
    const res = await voiceRoute(() => deps)(
      twilioRequest(VOICE, callParams, {
        signedUrl: `https://attacker.example${VOICE}`,
        requestHost: "https://attacker.example",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 for malformed params even when signed", async () => {
    const { deps, store } = setup();
    const res = await voiceRoute(() => deps)(
      twilioRequest(VOICE, { ...callParams, CallSid: "not-a-sid" }),
    );
    expect(res.status).toBe(400);
    expect(store.calls.size).toBe(0);
  });

  it("rejects non-form bodies", async () => {
    const { deps } = setup();
    const req = new Request(`http://internal.local${VOICE}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-twilio-signature": "x" },
      body: JSON.stringify(callParams),
    });
    expect((await voiceRoute(() => deps)(req)).status).toBe(403);
  });

  it("hangs up cleanly if the database fails during a missed call", async () => {
    const { deps, store, sender } = setup();
    store.failOn.add("setCallOutcome");
    const res = await dialStatusRoute(() => deps)(twilioRequest(STATUS, statusParams));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<Hangup/>");
    expect(sender.sent).toHaveLength(0);
  });
});
