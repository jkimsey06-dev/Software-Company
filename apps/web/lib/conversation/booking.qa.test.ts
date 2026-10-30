import { cleanAddress, parseSlotNumber } from "@sc/ai";
import { describe, expect, it } from "vitest";
import { BUSINESS_NUMBER, CALLER, TENANT_ID, FakeSender, recordingLogger, textingConfig } from "../missed-call/test-helpers";
import { SmsSendError } from "../missed-call/types";
import { CalendarUnavailableError } from "../calendar/google";
import { notificationDeps } from "../notifications/test-helpers";
import { handleCustomerMessage } from "./run-turn";
import { FakeCalendar, FakeConversationStore, FakeModel, understood } from "./test-helpers";

// QA: ways to break estimate booking. Fakes only: no Google, no Twilio, no Claude.

const START = new Date("2026-10-30T14:00:00Z"); // Fri 10:00 AM New York
const FRI_NOON = new Date("2026-10-30T16:00:00Z");
const MON_8 = new Date("2026-11-02T13:00:00Z");

function setup() {
  const store = new FakeConversationStore();
  store.ownedNumbers.set(BUSINESS_NUMBER, TENANT_ID);
  store.businessSaid(TENANT_ID, CALLER, "Hi, this is the AI assistant... Reply STOP to opt out");
  const model = new FakeModel();
  model.understandings.push(understood({ details: { serviceId: "ac-repair", area: "Cleveland", urgency: "soon" } }));
  const calendar = new FakeCalendar();
  const sender = new FakeSender();
  const n = notificationDeps();
  const clock = { now: START };
  const deps = {
    store,
    sender,
    modelFor: () => model,
    notifications: n.deps,
    log: recordingLogger(),
    leaseWaitMs: 0,
    now: () => clock.now,
    calendarFor: async () => ({ ok: true, client: calendar }) as const,
    markCalendarRevoked: async () => undefined,
  };
  let sid = 0;
  const send = (text: string, messageSid: string) =>
    handleCustomerMessage(
      { tenantId: TENANT_ID, config: textingConfig(), customerPhone: CALLER, businessNumber: BUSINESS_NUMBER, leadId: "lead-1", messageSid, body: text },
      deps,
    );
  const say = async (text: string) => {
    sid += 1;
    const messageSid = `SM${String(sid).padStart(32, "0")}`;
    store.customerSays(TENANT_ID, CALLER, text, messageSid);
    return send(text, messageSid);
  };
  const conv = () => store.conversations[0]!;
  const bodies = () => sender.sent.map((m) => m.body);
  return { store, model, calendar, sender, email: n.email, clock, say, send, conv, bodies };
}

describe("parseSlotNumber", () => {
  it.each(["2 more questions", "1 sec", "3pm", "3 pm", "1 min", "2 hours", "2?"])("%j is not a pick", (t) => {
    expect(parseSlotNumber(t, 3)).toBeNull();
  });
  // Misses fall back to the small model, so these cost a model call, not a wrong booking.
  it.each([["Option #2", 2], ["the 2nd one", 2], ["2️⃣", 2]] as const)("%j -> %s (doc says 'the 2nd one' works)", (t, n) => {
    expect(parseSlotNumber(t, 3)).toBe(n);
  });
});

describe("cleanAddress backstop", () => {
  it.each(["RR 2 Box 15", "123 Main St Apt 4B", "4521 Hwy 64, Cleveland TN", "N1234 County Rd 5"])("accepts %j", (a) => {
    expect(cleanAddress(a)).not.toBeNull();
  });
  it.each(["2 more questions", "I have 2 dogs", "call me at 423 555 0111", "Apt 4B"])("rejects non-address %j", (a) => {
    expect(cleanAddress(a)).toBeNull();
  });
  it("[product] rejects a PO box (no on-site estimate there)", () => {
    expect(cleanAddress("PO Box 15, Cleveland TN")).toBeNull();
  });
});

describe("stale offers", () => {
  it("a pick made after the offered time has passed is not confirmed as that time", async () => {
    const s = setup();
    await s.say("AC repair in Cleveland, soon");
    s.clock.now = new Date("2026-11-03T15:00:00Z"); // Tue, days later
    await s.say("1"); // Fri, Oct 30, 12:00 PM: in the past
    expect(s.bodies().at(-1)).not.toContain("Fri, Oct 30, 12:00 PM it is");
  });

  it("never books a slot inside the 2-hour lead time", async () => {
    const s = setup();
    await s.say("AC repair in Cleveland, soon");
    await s.say("1"); // Fri 12:00 PM
    s.clock.now = new Date("2026-10-30T15:55:00Z"); // 11:55 AM
    s.model.addresses.push("123 Main St, Cleveland TN");
    await s.say("123 Main St, Cleveland TN");
    expect(s.calendar.events.map((e) => e.start.getTime())).not.toContain(FRI_NOON.getTime());
  });
});

describe("failures after the event is created", () => {
  it("database blip right after createEvent: the retry confirms the booking instead of offering new times", async () => {
    const s = setup();
    await s.say("AC repair in Cleveland, soon");
    await s.say("2");
    s.model.addresses.push("123 Main St, Cleveland TN");
    const real = s.store.claimOutbound.bind(s.store);
    let failed = false;
    s.store.claimOutbound = async (m) => {
      if (!failed) {
        failed = true;
        throw new Error("supabase 503");
      }
      return real(m);
    };
    s.store.customerSays(TENANT_ID, CALLER, "123 Main St, Cleveland TN", "SMretry");
    await expect(s.send("123 Main St, Cleveland TN", "SMretry")).rejects.toThrow();
    expect(s.calendar.events).toHaveLength(1);
    // Webhook/sweeper retries the same message.
    s.model.addresses.push("123 Main St, Cleveland TN");
    await s.send("123 Main St, Cleveland TN", "SMretry");
    expect(s.bodies().at(-1)).toMatch(/^You're booked/);
    expect(s.calendar.events).toHaveLength(1);
  });

  it("lead-address save fails after createEvent: owner is not told 'couldn't reach your calendar'", async () => {
    const s = setup();
    await s.say("AC repair in Cleveland, soon");
    await s.say("2");
    s.store.updateLeadAddress = async () => {
      throw new Error("supabase timeout");
    };
    s.model.addresses.push("123 Main St, Cleveland TN");
    await s.say("123 Main St, Cleveland TN");
    expect(s.calendar.events).toHaveLength(1);
    expect(s.email.sent.at(-1)?.text).not.toContain("couldn't reach your calendar");
    expect(s.bodies().at(-1)).not.toContain("reach out to find a time");
  });

  it("confirmation text fails (Twilio 5xx) after createEvent: owner email says it's on the calendar", async () => {
    const s = setup();
    await s.say("AC repair in Cleveland, soon");
    await s.say("2");
    s.sender.failWith = new SmsSendError("unknown", "500", "twilio down");
    s.model.addresses.push("123 Main St, Cleveland TN");
    await s.say("123 Main St, Cleveland TN");
    expect(s.calendar.events).toHaveLength(1);
    // The thread quotes "Mon, Nov 2, 8:00 AM it is", so check for the booking line itself.
    expect(s.email.sent.at(-1)?.text).toContain("on your calendar");
  });

  it("STOP lands while booking: owner email mentions the event we created", async () => {
    const s = setup();
    await s.say("AC repair in Cleveland, soon");
    await s.say("2");
    s.model.onClassify = () => void s.store.addOptOut(TENANT_ID, CALLER);
    s.model.addresses.push("123 Main St, Cleveland TN");
    await s.say("123 Main St, Cleveland TN");
    expect(s.bodies().some((b) => b.startsWith("You're booked"))).toBe(false);
    if (s.calendar.events.length) expect(s.email.sent.at(-1)?.text).toContain("on your calendar");
  });

  it("Google times out after actually creating the event: one event, owner not told it failed", async () => {
    const s = setup();
    await s.say("AC repair in Cleveland, soon");
    await s.say("2");
    const real = s.calendar.createEvent.bind(s.calendar);
    s.calendar.createEvent = async (e) => {
      await real(e);
      throw new CalendarUnavailableError("network");
    };
    s.model.addresses.push("123 Main St, Cleveland TN");
    await s.say("123 Main St, Cleveland TN");
    expect(s.calendar.events).toHaveLength(1);
    expect(s.email.sent.at(-1)?.text).not.toContain("couldn't reach your calendar");
  });
});

describe("conversation never gets stuck", () => {
  it("repeated unclear picks end in a handoff within the reply limit", async () => {
    const s = setup();
    await s.say("AC repair in Cleveland, soon");
    for (let i = 0; i < 8; i++) await s.say("hmm");
    expect(s.conv().status).toBe("handed_off");
    expect(s.sender.sent.length).toBeLessThanOrEqual(7);
  });

  it("after 'that time was taken', the address they already gave is not asked for again", async () => {
    const s = setup();
    await s.say("AC repair in Cleveland, soon");
    await s.say("2");
    s.calendar.busyBlocks.push({ start: MON_8, end: new Date(MON_8.getTime() + 3_600_000) });
    s.model.addresses.push("123 Main St, Cleveland TN");
    await s.say("123 Main St, Cleveland TN");
    expect(s.bodies().at(-1)).toMatch(/^Sorry, that time was just taken/);
    await s.say("1");
    expect(s.bodies().at(-1)).not.toContain("What's the street address");
  });

  it("second address round gets its own retry (the first round's 'didn't catch that' doesn't count)", async () => {
    const s = setup();
    await s.say("AC repair in Cleveland, soon");
    await s.say("1"); // Fri 12:00 PM
    await s.say("the blue house"); // asked again
    s.clock.now = new Date("2026-10-30T15:30:00Z"); // 11:30 AM: noon is too close now
    s.model.addresses.push("123 Main St, Cleveland TN");
    await s.say("123 Main St, Cleveland TN"); // expired -> new offer, address kept
    expect(s.bodies().at(-1)).toMatch(/^Sorry, those times are no longer available/);
    expect(s.conv().booking.address).toBe("123 Main St, Cleveland TN");
    s.store.conversations[0]!.booking.address = null; // as if no address had been given
    await s.say("1");
    await s.say("near the school"); // unclear: should be asked again, not handed off
    expect(s.conv().status).toBe("active");
    expect(s.bodies().at(-1)).toContain("didn't catch that");
  });
});

describe("safety, opt-out and duplicates mid-booking", () => {
  it("flooding while asking for the address: 911 text, no event", async () => {
    const s = setup();
    await s.say("AC repair in Cleveland, soon");
    await s.say("2");
    await s.say("water is flooding the basement now");
    expect(s.bodies().some((b) => b.includes("911"))).toBe(true);
    expect(s.calendar.events).toHaveLength(0);
    expect(s.conv().status).toBe("handed_off");
  });

  it("after STOP, a later '2' sends nothing and books nothing", async () => {
    const s = setup();
    await s.say("AC repair in Cleveland, soon");
    await s.store.addOptOut(TENANT_ID, CALLER);
    const before = s.sender.sent.length;
    expect(await s.say("2")).toBe(false);
    expect(s.sender.sent.length).toBe(before);
    expect(s.calendar.events).toHaveLength(0);
  });

  it("after a handoff, a late pick is forwarded to the owner, not booked", async () => {
    const s = setup();
    await s.say("AC repair in Cleveland, soon");
    s.model.categories.push("wants_human");
    await s.say("can someone call me");
    expect(await s.say("2")).toBe(false);
    expect(s.calendar.events).toHaveLength(0);
  });

  it("the address webhook delivered twice concurrently: one event, one confirmation", async () => {
    const s = setup();
    await s.say("AC repair in Cleveland, soon");
    await s.say("2");
    s.model.addresses.push("123 Main St, Cleveland TN", "123 Main St, Cleveland TN");
    s.store.customerSays(TENANT_ID, CALLER, "123 Main St, Cleveland TN", "SMdup");
    await Promise.all([s.send("123 Main St, Cleveland TN", "SMdup"), s.send("123 Main St, Cleveland TN", "SMdup")]);
    await s.send("123 Main St, Cleveland TN", "SMdup"); // minutes later
    expect(s.calendar.events).toHaveLength(1);
    expect(s.bodies().filter((b) => b.startsWith("You're booked"))).toHaveLength(1);
  });

  it("model returns an out-of-range pick: same options again, nothing booked", async () => {
    const s = setup();
    await s.say("AC repair in Cleveland, soon");
    s.model.slotChoices.push({ choice: 7, wantsOtherTime: false });
    await s.say("the seventh one");
    expect(s.conv().booking.stage).toBe("choosing_time");
    expect(s.bodies().at(-1)).toContain("Reply with the number");
  });
});
