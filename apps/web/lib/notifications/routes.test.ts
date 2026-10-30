import twilio from "twilio";
import { describe, expect, it, vi } from "vitest";
import { dialStatusRoute } from "../missed-call/routes";
import { BASE_URL, BUSINESS_NUMBER, CALLER, CALL_SID, FakeSender, FakeStore, recordingLogger } from "../missed-call/test-helpers";
import { cronRoute } from "./cron-route";
import { manualSchedule, notificationDeps } from "./test-helpers";

const SECRET = "s".repeat(40);
const cronRequest = (authorization?: string) =>
  new Request("http://internal.local/api/cron/notifications", {
    headers: authorization ? { authorization } : {},
  });

describe("cron route", () => {
  it.each([
    ["no header", undefined],
    ["wrong secret", `Bearer ${"x".repeat(40)}`],
    ["no Bearer prefix", SECRET],
    ["secret as a prefix", `Bearer ${SECRET}extra`],
  ])("rejects %s", async (_name, header) => {
    const { deps, store } = notificationDeps();
    const due = vi.spyOn(store, "due");
    const res = await cronRoute(() => SECRET, () => deps)(cronRequest(header));
    expect(res.status).toBe(401);
    expect(due).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "too-short"])("fails closed when CRON_SECRET is %j", async (secret) => {
    const { deps } = notificationDeps();
    const res = await cronRoute(() => secret, () => deps)(cronRequest(`Bearer ${secret}`));
    expect(res.status).toBe(401);
  });

  it("sends due notifications with the right secret", async () => {
    const { deps, store, email } = notificationDeps();
    await store.enqueue({
      tenantId: "t", kind: "new_lead", idempotencyKey: "k", leadId: null,
      recipientEmail: "owner@example.com", subject: "S", body: "B",
    });
    const res = await cronRoute(() => SECRET, () => deps)(cronRequest(`Bearer ${SECRET}`));
    expect(await res.json()).toEqual({ ok: true, processed: 1 });
    expect(email.sent).toHaveLength(1);
  });

  it("does nothing when email isn't configured", async () => {
    const res = await cronRoute(() => SECRET, () => null)(cronRequest(`Bearer ${SECRET}`));
    expect(await res.json()).toMatchObject({ processed: 0, disabled: true });
  });
});

describe("dial-status database failure", () => {
  it("alerts the operator after answering Twilio", async () => {
    const AUTH = "test-auth-token-not-real";
    const store = new FakeStore();
    store.failOn.add("setCallOutcome");
    const timer = manualSchedule();
    const alerts: string[] = [];
    const params = { CallSid: CALL_SID, From: CALLER, To: BUSINESS_NUMBER, DialCallStatus: "no-answer" };
    const req = new Request("http://internal.local/api/twilio/voice/status", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilio.getExpectedTwilioSignature(AUTH, `${BASE_URL}/api/twilio/voice/status`, params),
      },
      body: new URLSearchParams(params).toString(),
    });
    const res = await dialStatusRoute(() => ({
      store,
      sender: new FakeSender(),
      log: recordingLogger(),
      publicBaseUrl: BASE_URL,
      twilioAuthToken: AUTH,
      schedule: timer.schedule,
      opsAlert: async (event, fields) => {
        alerts.push(`${event}:${fields.callSid}`);
      },
    }))(req);
    expect(res.status).toBe(200);
    expect(alerts).toHaveLength(0); // not before the response
    await timer.runAll();
    expect(alerts).toEqual([`dial_status.error:${CALL_SID}`]);
  });
});
