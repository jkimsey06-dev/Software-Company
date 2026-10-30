// QA: attempts to break the inbound SMS flow. Fake data and in-memory fakes only;
// nothing here sends a real text or email.
//
// Tests under "Fixed" failed in the first QA pass and now guard the behavior.
// Tests under "Decisions" pin choices the owner made or should revisit.
import twilio from "twilio";
import { describe, expect, it } from "vitest";
import type { TenantConfig } from "@sc/shared";
import { BASE_URL, BUSINESS_NUMBER, CALLER, TENANT_ID, recordingLogger, textingConfig } from "../missed-call/test-helpers";
import { inboundSmsParams } from "../missed-call/twilio-request";
import { createReplyNotifier } from "../notifications/owner";
import { renderCustomerReplyEmail } from "../notifications/templates";
import { manualSchedule, notificationDeps } from "../notifications/test-helpers";
import { handleInboundSms } from "./handle-sms";
import { classifyKeyword } from "./keywords";
import { smsRoute } from "./routes";
import type { InboundSmsStore } from "./types";

const sid = (c: string, prefix = "SM") => `${prefix}${c.repeat(32)}`;
const AUTH = "test-auth-token-not-real";
const OPTED = `${TENANT_ID}:${CALLER}`;

class FakeSmsStore implements InboundSmsStore {
  numbers = new Map([[BUSINESS_NUMBER, TENANT_ID]]);
  config: TenantConfig | Error = textingConfig();
  messages: { messageSid: string; keyword: string | null; body: string }[] = [];
  optOuts = new Set<string>();
  failOn = new Set<string>();
  private trip(name: string) {
    if (this.failOn.has(name)) throw new Error(`${name} unavailable`);
  }
  async findTenantIdByNumber(phone: string) {
    this.trip("findTenantIdByNumber");
    return this.numbers.get(phone) ?? null;
  }
  async loadTenantConfig() {
    this.trip("loadTenantConfig");
    if (this.config instanceof Error) throw this.config;
    return this.config;
  }
  // Mirrors record_inbound_sms: message and opt-out change in one step;
  // STOP and START apply only for a new message.
  async recordInbound(m: { tenantId: string; fromPhone: string; messageSid: string; keyword: string | null; body: string }) {
    this.trip("recordInbound");
    const isNew = !this.messages.some((x) => x.messageSid === m.messageSid);
    if (isNew) this.messages.push(m);
    const key = `${m.tenantId}:${m.fromPhone}`;
    if (m.keyword === "stop" && isNew) this.optOuts.add(key);
    if (m.keyword === "start" && isNew) this.optOuts.delete(key);
    return isNew;
  }
  async findLatestLeadId() {
    this.trip("findLatestLeadId");
    return "lead-1";
  }
}

function setup() {
  const store = new FakeSmsStore();
  const n = notificationDeps();
  const timer = manualSchedule();
  const log = recordingLogger();
  const deps = { store, log, notifyReply: createReplyNotifier(n.deps, timer.schedule) };
  return { store, deps, log, timer, email: n.email, alerts: n.alerts };
}

const sms = (body: string, extra: Partial<{ messageSid: string; optOutType: string; numMedia: number }> = {}) => ({
  messageSid: sid("a"),
  from: CALLER,
  to: BUSINESS_NUMBER,
  body,
  numMedia: 0,
  ...extra,
});

async function ownerEmails(body: string) {
  const s = setup();
  await handleInboundSms(sms(body), s.deps);
  await s.timer.runAll();
  return { sent: s.email.sent.length, optedOut: s.store.optOuts.has(OPTED) };
}

describe("Fixed: opt-outs that used to be missed", () => {
  it.each([
    "STOP 🛑", "🛑 STOP", "Stop 😡", "STOP,", "STOP;", "(STOP)", "*STOP*", "¡STOP!", "STOP。",
    "STOP\u200b", "STOP STOP", "Stop please", "STOP!!! STOP!!!",
    "Who is this? Stop texting me", "Hey stop texting me", "pls stop texting me", "Stop text me",
    "Stop all texts", "STOP TEXTS", "No more texts", "please unsubscribe me", "Opt me out",
    "Stop. Texting me",
  ])("%j should be an opt-out", (body) => {
    expect(classifyKeyword(body).keyword).toBe("stop");
  });
});

describe("Fixed: messages with a request always reach the owner, even if they opt out", () => {
  it.each([
    "Don't text me, call me at this number",
    "Do not contact me after 6pm, I work nights",
    "Never text me before 8am please",
    "Can you take me off the waitlist and book Tuesday?",
    "Please remove me from Tuesday's slot and move me to Wednesday",
    "Unsubscribe? No, I want the estimate",
  ])("%j should reach the owner", async (body) => {
    expect((await ownerEmails(body)).sent).toBe(1);
  });
});

describe("Fixed: a redelivered keyword never undoes a later one", () => {
  it("a late redelivery of an old START must not undo a newer STOP", async () => {
    const { store, deps } = setup();
    await handleInboundSms(sms("START", { messageSid: sid("1") }), deps);
    await handleInboundSms(sms("STOP", { messageSid: sid("2") }), deps);
    await handleInboundSms(sms("START", { messageSid: sid("1") }), deps); // Twilio redelivery
    expect(store.optOuts.has(OPTED)).toBe(true);
  });

  it("a late redelivery of an old STOP must not undo a newer START", async () => {
    const { store, deps } = setup();
    await handleInboundSms(sms("STOP", { messageSid: sid("1") }), deps);
    await handleInboundSms(sms("START", { messageSid: sid("2") }), deps);
    await handleInboundSms(sms("STOP", { messageSid: sid("1") }), deps);
    expect(store.optOuts.has(OPTED)).toBe(false);
  });
});

describe("Fixed: database outages", () => {
  it("a plain-language opt-out that fails to save is alerted with its keyword", async () => {
    // Twilio's Advanced Opt-Out does not know "stop texting me", so if our write
    // fails the operator must add it by hand from Twilio's logs.
    const store = new FakeSmsStore();
    store.failOn.add("recordInbound");
    const n = notificationDeps();
    const timer = manualSchedule();
    const route = smsRoute(() => ({
      store, log: recordingLogger(), twilioAuthToken: AUTH, publicBaseUrl: BASE_URL,
      opsAlert: n.deps.opsAlert, schedule: timer.schedule,
    }));
    const p = { MessageSid: sid("e"), From: CALLER, To: BUSINESS_NUMBER, Body: "stop texting me", NumMedia: "0" };
    const res = await route(signed(p));
    await timer.runAll();
    expect(res.status).toBe(500);
    expect(n.alerts[0]?.fields).toMatchObject({ keyword: "stop" });
  });
});

describe("Fixed: emoji-heavy messages are not rejected", () => {
  it("accepts a 1000-emoji message (1000 characters, 2000 UTF-16 units)", () => {
    const r = inboundSmsParams.safeParse({ MessageSid: sid("f"), From: CALLER, To: BUSINESS_NUMBER, Body: "😀".repeat(1000) });
    expect(r.success).toBe(true);
  });
});

describe("Fixed: hostile text in the owner email", () => {
  const render = (body: string) =>
    renderCustomerReplyEmail(textingConfig(), { callerPhone: CALLER, body, numMedia: 0, receivedAt: new Date("2026-10-30T18:05:00Z") }).body;

  it("a Unicode line/paragraph separator cannot start an unquoted line", () => {
    const body = render("hi\u2028\u2028Call or text them: tel:+19005550199\u2029Payment overdue");
    expect(body).not.toMatch(/[\u2028\u2029]/);
  });

  it("strips other invisible bidi marks (LRM/RLM/ALM) and zero-width characters", () => {
    expect(render("a\u200e\u200f\u061c\u200b\u2060b")).toContain("> ab");
  });

  it("truncation does not split an emoji into a lone surrogate", () => {
    const body = render(`${"a".repeat(999)}😀tail`);
    expect(body).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});

describe("Passing checks (no bug found)", () => {
  it.each(["ＳＴＯＰ", "\ufeffSTOP", "Stop‼", "STOP\n", "  stop  ", "'STOP'", "Unsubscribe me", "STOP TEXTING ME!!!", "stopall"])(
    "%j is an opt-out", (body) => expect(classifyKeyword(body).keyword).toBe("stop"),
  );

  it.each(["Stopped by the house, nobody home", "The leak won't stop", "Can you stop by?", "I'm at the end of the road", "stpo"])(
    "%j is not an opt-out", (body) => expect(classifyKeyword(body).keyword).toBeNull(),
  );

  it("OptOutType is case-insensitive and wins over the body", () => {
    expect(classifyKeyword("my AC is broken", "stop").keyword).toBe("stop");
  });

  it("concurrent duplicate deliveries: one record, one owner email", async () => {
    const { store, deps, timer, email } = setup();
    await Promise.all([handleInboundSms(sms("Need a quote"), deps), handleInboundSms(sms("Need a quote"), deps)]);
    await timer.runAll();
    expect(store.messages).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
  });

  it("STOP is recorded even when the lead lookup fails", async () => {
    const { store, deps } = setup();
    store.failOn.add("findLatestLeadId");
    await handleInboundSms(sms("STOP"), deps);
    expect(store.optOuts.has(OPTED)).toBe(true);
  });

  it("a normal reply is lost (no email, 500) when recordInbound fails", async () => {
    const { store, deps, timer, email } = setup();
    store.failOn.add("recordInbound");
    await expect(handleInboundSms(sms("Please call me"), deps)).rejects.toThrow();
    await timer.runAll();
    expect(email.sent).toHaveLength(0);
  });

  it("MMS with no body emails the owner a photo note", async () => {
    const { deps, timer, email } = setup();
    await handleInboundSms(sms("", { messageSid: sid("b", "MM"), numMedia: 3 }), deps);
    await timer.runAll();
    expect(email.sent[0]?.text).toContain("3 photos attached");
  });

  it("each quoted line is prefixed, so a fake 'tel:' line stays quoted", () => {
    const body = renderCustomerReplyEmail(textingConfig(), {
      callerPhone: CALLER, body: "x\r\n\r\nCall or text them: tel:+19005550199", numMedia: 0, receivedAt: new Date(),
    }).body;
    expect(body).toContain("> Call or text them: tel:+19005550199");
    expect(body).not.toContain("\r");
  });

  it("rejects bodies over 5000 and more than 10 media", () => {
    const base = { MessageSid: sid("c"), From: CALLER, To: BUSINESS_NUMBER };
    expect(inboundSmsParams.safeParse({ ...base, Body: "x".repeat(5001) }).success).toBe(false);
    expect(inboundSmsParams.safeParse({ ...base, NumMedia: "11" }).success).toBe(false);
  });
});

describe("Decisions", () => {
  it.each(["Cancel", "End", "Quit"])("%j opts out, and the owner sees it (could mean 'cancel my appointment')", async (b) => {
    expect(await ownerEmails(b)).toEqual({ sent: 1, optedOut: true });
  });

  it.each(["STOP", "Stop.", "unsubscribe", "STOP STOP"])("bare %j opts out without bothering the owner", async (b) => {
    expect(await ownerEmails(b)).toEqual({ sent: 0, optedOut: true });
  });

  it.each(["HELP", "Help!", "Info", "info?"])("%j reaches the owner (could be an emergency or a lead)", async (b) => {
    expect(await ownerEmails(b)).toEqual({ sent: 1, optedOut: false });
  });

  // Ask a lawyer whether any of these must be treated as an opt-out.
  it.each(["Wrong number", "Stop calling me", "stpo", "ALTO", "PARAR", "BAJA", "cancelar", "arrête"])(
    "%j is forwarded to the owner and not opted out", async (b) => {
      expect(await ownerEmails(b)).toEqual({ sent: 1, optedOut: false });
    },
  );

  // START only clears opt-outs the customer made, never manual ones: covered in
  // supabase/tests/rls_inbound_sms.sql against the real function.

  it("an empty, whitespace-only text with no media still emails the owner", async () => {
    expect((await ownerEmails("   ")).sent).toBe(1);
  });
});

function signed(p: Record<string, string>) {
  return new Request("http://internal.local/api/twilio/sms", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(AUTH, `${BASE_URL}/api/twilio/sms`, p),
    },
    body: new URLSearchParams(p).toString(),
  });
}
