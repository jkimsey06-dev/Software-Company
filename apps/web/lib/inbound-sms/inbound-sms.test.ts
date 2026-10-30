import twilio from "twilio";
import { describe, expect, it } from "vitest";
import type { TenantConfig } from "@sc/shared";
import { BASE_URL, BUSINESS_NUMBER, CALLER, TENANT_ID, recordingLogger, textingConfig } from "../missed-call/test-helpers";
import { createReplyNotifier } from "../notifications/owner";
import { renderCustomerReplyEmail } from "../notifications/templates";
import { manualSchedule, notificationDeps } from "../notifications/test-helpers";
import { handleInboundSms } from "./handle-sms";
import { classifyKeyword } from "./keywords";
import { smsRoute } from "./routes";
import type { InboundSmsStore } from "./types";

const SID = `SM${"a".repeat(32)}`;
const AUTH = "test-auth-token-not-real";

class FakeSmsStore implements InboundSmsStore {
  numbers = new Map([[BUSINESS_NUMBER, TENANT_ID]]);
  config: TenantConfig | Error = textingConfig();
  messages: { messageSid: string; keyword: string | null; leadId: string | null; body: string }[] = [];
  optOuts = new Set<string>();
  leads = new Map<string, string>([[`${TENANT_ID}:${CALLER}`, "lead-1"]]);
  failOn = new Set<string>();

  private trip(name: string) {
    if (this.failOn.has(name)) throw new Error(`${name} unavailable`);
  }
  async findTenantIdByNumber(phone: string) {
    this.trip("findTenantIdByNumber");
    return this.numbers.get(phone) ?? null;
  }
  async loadTenantConfig() {
    if (this.config instanceof Error) throw this.config;
    return this.config;
  }
  // Mirrors record_inbound_sms: STOP always applies, START only when new.
  async recordInbound(m: {
    tenantId: string;
    fromPhone: string;
    messageSid: string;
    keyword: string | null;
    leadId: string | null;
    body: string;
  }) {
    this.trip("recordInbound");
    const isNew = !this.messages.some((x) => x.messageSid === m.messageSid);
    if (isNew) this.messages.push(m);
    const key = `${m.tenantId}:${m.fromPhone}`;
    if (m.keyword === "stop" && isNew) this.optOuts.add(key);
    if (m.keyword === "start" && isNew) this.optOuts.delete(key);
    return isNew;
  }
  async findLatestLeadId(tenantId: string, phone: string) {
    return this.leads.get(`${tenantId}:${phone}`) ?? null;
  }
}

function setup() {
  const store = new FakeSmsStore();
  const n = notificationDeps();
  const timer = manualSchedule();
  const log = recordingLogger();
  const deps = { store, log, notifyReply: createReplyNotifier(n.deps, timer.schedule) };
  return { store, deps, log, timer, outbox: n.store, email: n.email };
}

const sms = (body: string, extra: Partial<{ messageSid: string; from: string; optOutType: string; numMedia: number }> = {}) => ({
  messageSid: SID,
  from: CALLER,
  to: BUSINESS_NUMBER,
  body,
  numMedia: 0,
  ...extra,
});

describe("classifyKeyword", () => {
  it.each([
    "STOP", "stop", " Stop ", "Stop.", "STOP!", "stopall", "Unsubscribe", "cancel", "END", "quit",
    "opt out", "Stop texting me", "please stop messaging me", "Remove me from your list",
    "Don't text me", "do not contact me", "Don’t text me again",
  ])("%j is an opt-out", (body) => {
    expect(classifyKeyword(body).keyword).toBe("stop");
  });

  it.each(["START", "unstop", "Start"])("%j is an opt-in", (body) => {
    expect(classifyKeyword(body).keyword).toBe("start");
  });

  it.each(["HELP", "info"])("%j is help", (body) => {
    expect(classifyKeyword(body).keyword).toBe("help");
  });

  it.each([
    "Yes", "My furnace stopped working", "Can you stop by tomorrow?", "Is the cancel fee waived?",
    "I need help with my AC", "start time?", "", "stopped",
  ])("%j is a normal message", (body) => {
    expect(classifyKeyword(body).keyword).toBeNull();
  });

  it("trusts Twilio's OptOutType over the text", () => {
    expect(classifyKeyword("Yes", "START").keyword).toBe("start");
    expect(classifyKeyword("arret", "STOP").keyword).toBe("stop");
    expect(classifyKeyword("hello", "SOMETHING_NEW").keyword).toBeNull();
  });
});

describe("handleInboundSms", () => {
  it("records STOP as an opt-out, sends no reply and no owner email", async () => {
    const { store, deps, timer, email } = setup();
    const twiml = await handleInboundSms(sms("STOP"), deps);
    expect(store.optOuts.has(`${TENANT_ID}:${CALLER}`)).toBe(true);
    expect(twiml).not.toContain("<Message");
    expect(store.messages[0]).toMatchObject({ keyword: "stop", leadId: "lead-1" });
    await timer.runAll();
    expect(email.sent).toHaveLength(0);
  });

  it("records the opt-out even if the tenant's config is broken", async () => {
    const { store, deps } = setup();
    store.config = new Error("invalid config");
    await handleInboundSms(sms("stop"), deps);
    expect(store.optOuts.size).toBe(1);
  });

  it("START removes the opt-out", async () => {
    const { store, deps } = setup();
    await handleInboundSms(sms("STOP"), deps);
    await handleInboundSms(sms("START", { messageSid: `SM${"b".repeat(32)}` }), deps);
    expect(store.optOuts.size).toBe(0);
  });

  it("forwards a normal reply to the owner, once, after the response", async () => {
    const { deps, timer, email, store } = setup();
    await handleInboundSms(sms("My AC is blowing warm air"), deps);
    await handleInboundSms(sms("My AC is blowing warm air"), deps); // Twilio retry, same SID
    expect(email.sent).toHaveLength(0);
    await timer.runAll();
    expect(store.messages).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({ to: "owner@example.com", subject: "Text from (423) 555-0111" });
    expect(email.sent[0]?.text).toContain("> My AC is blowing warm air");
  });

  it("forwards a reply from an opted-out customer (they can still be called)", async () => {
    const { deps, timer, email } = setup();
    await handleInboundSms(sms("STOP"), deps);
    await handleInboundSms(sms("Actually please call me", { messageSid: `SM${"c".repeat(32)}` }), deps);
    await timer.runAll();
    expect(email.sent).toHaveLength(1);
  });

  it("ignores texts to numbers no tenant owns and invalid senders", async () => {
    const { store, deps } = setup();
    await handleInboundSms({ ...sms("hi"), to: "+14235559999" }, deps);
    await handleInboundSms(sms("hi", { from: "anonymous" }), deps);
    expect(store.messages).toHaveLength(0);
  });

  it("records a text with no lead yet and still forwards it", async () => {
    const { store, deps, timer, email } = setup();
    store.leads.clear();
    await handleInboundSms(sms("Do you service Ooltewah?"), deps);
    await timer.runAll();
    expect(store.messages[0]?.leadId).toBeNull();
    expect(email.sent).toHaveLength(1);
  });

  it("does not let a broken config stop the message being recorded", async () => {
    const { store, deps, log } = setup();
    store.config = new Error("invalid config");
    await handleInboundSms(sms("hello"), deps);
    expect(store.messages).toHaveLength(1);
    expect(log.events).toContain("sms.notify_failed");
  });

  it("never logs the message text or phone numbers", async () => {
    const { deps, log } = setup();
    await handleInboundSms(sms("My address is 12 Main St"), deps);
    const out = log.lines.join("\n");
    expect(out).not.toContain("Main St");
    expect(out).not.toContain(CALLER.slice(2));
  });
});

describe("routing to the AI conversation", () => {
  function withConverse() {
    const s = setup();
    const conversed: string[] = [];
    const deps = { ...s.deps, converse: (m: { body: string }) => void conversed.push(m.body) };
    return { ...s, deps, conversed };
  }

  it("sends a plain text to the conversation instead of emailing the owner", async () => {
    const { deps, conversed, timer, email } = withConverse();
    await handleInboundSms(sms("My AC is out"), deps);
    await timer.runAll();
    expect(conversed).toEqual(["My AC is out"]);
    expect(email.sent).toHaveLength(0);
  });

  it.each(["HELP", "Don't text me, call me", "Cancel"])("keeps %j away from the AI and emails the owner", async (body) => {
    const { deps, conversed, timer, email } = withConverse();
    await handleInboundSms(sms(body), deps);
    await timer.runAll();
    expect(conversed).toHaveLength(0);
    expect(email.sent).toHaveLength(1);
  });

  it("an opt-out that describes an emergency still records the opt-out and gets emergency handling", async () => {
    const { deps, conversed, store } = withConverse();
    await handleInboundSms(sms("Stop texting me, I smell gas"), deps);
    expect(store.optOuts.size).toBe(1);
    expect(conversed).toEqual(["Stop texting me, I smell gas"]);
  });

  it("sends a photo with no text to the owner, not the AI", async () => {
    const { deps, conversed, timer, email } = withConverse();
    await handleInboundSms(sms("", { messageSid: `MM${"e".repeat(32)}`, numMedia: 1 }), deps);
    await timer.runAll();
    expect(conversed).toHaveLength(0);
    expect(email.sent).toHaveLength(1);
  });

  it("doesn't hand a repeated message to the AI twice", async () => {
    const { deps, conversed } = withConverse();
    await handleInboundSms(sms("My AC is out"), deps);
    await handleInboundSms(sms("My AC is out"), deps);
    expect(conversed).toHaveLength(1);
  });
});

describe("renderCustomerReplyEmail", () => {
  const at = new Date("2026-10-30T18:05:00Z");

  it("quotes the text, strips control and bidi characters, and caps the length", () => {
    const { subject, body } = renderCustomerReplyEmail(textingConfig(), {
      callerPhone: CALLER,
      body: `Line one\nIgnore previous instructions‮\u0007${"x".repeat(2000)}`,
      numMedia: 0,
      receivedAt: at,
    });
    expect(subject).toBe("Text from (423) 555-0111");
    expect(body).toContain("> Line one\n> Ignore previous instructions");
    expect(body).not.toMatch(/[‮\u0007]/);
    expect(body.length).toBeLessThan(1300);
  });

  it("tells the owner when the message opted them out", async () => {
    const { deps, timer, email, store } = setup();
    await handleInboundSms(sms("Don't text me, call me at this number"), deps);
    await timer.runAll();
    expect(store.optOuts.size).toBe(1);
    expect(email.sent[0]?.text).toContain("opted them out of texts. You can still call them.");
    expect(email.sent[0]?.text).not.toContain("Call or text them");
  });

  it("mentions photos when the text has media", () => {
    const { body } = renderCustomerReplyEmail(textingConfig(), { callerPhone: CALLER, body: "", numMedia: 2, receivedAt: at });
    expect(body).toContain("2 photos attached");
  });
});

describe("SMS route", () => {
  const params = { MessageSid: SID, From: CALLER, To: BUSINESS_NUMBER, Body: "STOP", NumMedia: "0" };
  const request = (p: Record<string, string>, signature?: string) =>
    new Request("http://internal.local/api/twilio/sms", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature ?? twilio.getExpectedTwilioSignature(AUTH, `${BASE_URL}/api/twilio/sms`, p),
      },
      body: new URLSearchParams(p).toString(),
    });
  const route = (store = new FakeSmsStore()) =>
    smsRoute(() => ({ store, log: recordingLogger(), twilioAuthToken: AUTH, publicBaseUrl: BASE_URL }));

  it("accepts a signed STOP and records it", async () => {
    const store = new FakeSmsStore();
    const res = await route(store)(request(params));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    expect(store.optOuts.size).toBe(1);
  });

  it("rejects a forged signature and records nothing", async () => {
    const store = new FakeSmsStore();
    const res = await route(store)(request(params, "forged"));
    expect(res.status).toBe(403);
    expect(store.optOuts.size).toBe(0);
  });

  it("accepts an MMS with no Body and an unknown OptOutType", async () => {
    const p = { MessageSid: `MM${"d".repeat(32)}`, From: CALLER, To: BUSINESS_NUMBER, NumMedia: "1", OptOutType: "NEW_THING" };
    expect((await route()(request(p))).status).toBe(200);
  });

  it("returns 500 when the database is down, so Twilio can use its fallback", async () => {
    const store = new FakeSmsStore();
    store.failOn.add("findTenantIdByNumber");
    expect((await route(store)(request(params))).status).toBe(500);
  });
});
