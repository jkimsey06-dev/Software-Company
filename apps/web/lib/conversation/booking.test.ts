import { describe, expect, it } from "vitest";
import { BUSINESS_NUMBER, CALLER, TENANT_ID, FakeSender, recordingLogger, textingConfig } from "../missed-call/test-helpers";
import { CalendarAuthError, CalendarUnavailableError, eventIdFor } from "../calendar/google";
import { notificationDeps } from "../notifications/test-helpers";
import { handleCustomerMessage } from "./run-turn";
import { FakeCalendar, FakeConversationStore, FakeModel, understood } from "./test-helpers";

const NOW = new Date("2026-10-30T14:00:00Z"); // Fri 10:00 AM in New York
const OFFER =
  "Example Heating & Air can come out for an estimate at one of these times:\n1) Fri, Oct 30, 12:00 PM\n2) Mon, Nov 2, 8:00 AM\n3) Tue, Nov 3, 8:00 AM\nReply with the number, or tell us if none of these work.";
const COMPLETE = "Thanks! I've passed your details to Example Heating & Air. They'll reach out to set up a time.";

function setup(opts: { calendar?: "connected" | "none" | "revoked"; urgency?: "soon" | "emergency" } = {}) {
  const store = new FakeConversationStore();
  store.ownedNumbers.set(BUSINESS_NUMBER, TENANT_ID);
  store.businessSaid(TENANT_ID, CALLER, "Hi, this is the AI assistant... Reply STOP to opt out");
  const model = new FakeModel();
  model.understandings.push(understood({ details: { serviceId: "ac-repair", area: "Cleveland", urgency: opts.urgency ?? "soon" } }));
  const calendar = new FakeCalendar();
  const sender = new FakeSender();
  const n = notificationDeps();
  const revoked: string[] = [];
  const mode = opts.calendar ?? "connected";
  const deps = {
    store,
    sender,
    modelFor: () => model,
    notifications: n.deps,
    log: recordingLogger(),
    leaseWaitMs: 0,
    now: () => NOW,
    calendarFor: async () =>
      mode === "connected"
        ? ({ ok: true, client: calendar } as const)
        : ({ ok: false, reason: mode === "revoked" ? "revoked" : "not_connected" } as const),
    markCalendarRevoked: async (t: string) => void revoked.push(t),
  };
  let sid = 0;
  const say = async (text: string) => {
    sid += 1;
    const messageSid = `SM${String(sid).padStart(32, "0")}`;
    store.customerSays(TENANT_ID, CALLER, text, messageSid);
    return handleCustomerMessage(
      { tenantId: TENANT_ID, config: textingConfig(), customerPhone: CALLER, businessNumber: BUSINESS_NUMBER, leadId: "lead-1", messageSid, body: text },
      deps,
    );
  };
  return { store, model, calendar, sender, email: n.email, alerts: n.alerts, revoked, say, conv: () => store.conversations[0]! };
}

const bodies = (s: ReturnType<typeof setup>) => s.sender.sent.map((m) => m.body);

describe("booking an estimate from the owner's calendar", () => {
  it("offers times, takes a pick, asks for the address, then books and confirms", async () => {
    const s = setup();
    await s.say("AC repair in Cleveland, soon");
    expect(bodies(s)).toEqual([OFFER]);
    expect(s.conv().booking.stage).toBe("choosing_time");
    expect(s.email.sent).toHaveLength(0);

    await s.say("2");
    expect(s.model.chooseSlotCalls).toBe(0); // a plain number never needs a model
    expect(bodies(s).at(-1)).toBe("Great, Mon, Nov 2, 8:00 AM it is. What's the street address for the estimate?");
    expect(s.conv().booking).toMatchObject({ stage: "asking_address", chosenSlot: new Date("2026-11-02T13:00:00Z") });

    s.model.addresses.push("123 Main St, Cleveland TN 37311");
    await s.say("123 Main St, Cleveland TN 37311");
    expect(bodies(s).at(-1)).toBe(
      "You're booked for an estimate on Mon, Nov 2, 8:00 AM. Example Heating & Air may call to confirm or adjust. Reply STOP to opt out.",
    );
    expect(s.calendar.events).toHaveLength(1);
    expect(s.calendar.events[0]).toMatchObject({
      id: eventIdFor(s.conv().id, new Date("2026-11-02T13:00:00Z")),
      start: new Date("2026-11-02T13:00:00Z"),
      summary: "Estimate: AC repair - (423) 555-0111",
      location: "123 Main St, Cleveland TN 37311",
    });
    expect(s.conv()).toMatchObject({ status: "completed", reason: "booked" });
    expect(s.store.addresses.get("lead-1")).toBe("123 Main St, Cleveland TN 37311");
    expect(s.email.sent).toHaveLength(1);
    expect(s.email.sent[0]?.subject).toBe("Estimate booked: (423) 555-0111");
    expect(s.email.sent[0]?.text).toContain("booked an estimate for Mon, Nov 2, 8:00 AM");
    expect(s.email.sent[0]?.text).toContain("Address (as they wrote it): 123 Main St, Cleveland TN 37311");
  });

  it("reads a worded pick with the small model", async () => {
    const s = setup();
    await s.say("AC repair in Cleveland, soon");
    s.model.slotChoices.push({ choice: 3, wantsOtherTime: false });
    await s.say("the tuesday one");
    expect(bodies(s).at(-1)).toContain("Tue, Nov 3, 8:00 AM it is");
  });

  it("an unclear pick gets the same options again", async () => {
    const s = setup();
    await s.say("AC repair in Cleveland, soon");
    await s.say("hmm");
    expect(bodies(s)).toEqual([OFFER, OFFER]);
  });

  it("'none of these work' hands off to the owner to find a time", async () => {
    const s = setup();
    await s.say("AC repair in Cleveland, soon");
    s.model.slotChoices.push({ choice: null, wantsOtherTime: true });
    await s.say("none of those work for me");
    expect(bodies(s).at(-1)).toBe("No problem. I'll have the team at Example Heating & Air reach out to find a time that works.");
    expect(s.conv()).toMatchObject({ status: "handed_off", reason: "wants_other_time" });
    expect(s.email.sent[0]?.text).toContain("None of the offered times worked");
  });

  it("asks once more for an unclear address, then hands off", async () => {
    const s = setup();
    await s.say("AC repair in Cleveland, soon");
    await s.say("1");
    await s.say("the blue house");
    expect(bodies(s).at(-1)).toContain("house number and street");
    await s.say("by the church");
    expect(s.conv()).toMatchObject({ status: "handed_off", reason: "no_address" });
    expect(s.calendar.events).toHaveLength(0);
  });

  it("if the picked time was taken meanwhile, offers other times, then hands off if it happens again", async () => {
    const s = setup();
    await s.say("AC repair in Cleveland, soon");
    await s.say("2");
    // Someone booked Monday 8 AM since we offered it.
    s.calendar.busyBlocks.push({ start: new Date("2026-11-02T13:00:00Z"), end: new Date("2026-11-02T14:00:00Z") });
    s.model.addresses.push("123 Main St");
    await s.say("123 Main St");
    const retry = bodies(s).at(-1)!;
    expect(retry).toMatch(/^Sorry, that time was just taken\. Here are some other times:/);
    expect(retry).not.toContain("Mon, Nov 2, 8:00 AM");
    expect(s.conv().booking).toMatchObject({ stage: "choosing_time", offerRounds: 2 });
    expect(s.calendar.events).toHaveLength(0);

    await s.say("1");
    s.calendar.busyBlocks.push({ start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-12-01T00:00:00Z") });
    s.model.addresses.push("123 Main St");
    await s.say("123 Main St");
    expect(s.conv()).toMatchObject({ status: "handed_off", reason: "slot_taken" });
  });

  it("booking twice for the same time creates one event", async () => {
    const s = setup();
    await s.say("AC repair in Cleveland, soon");
    await s.say("2");
    s.calendar.events.push({ id: eventIdFor(s.conv().id, new Date("2026-11-02T13:00:00Z")), start: new Date(), summary: "", location: "", description: "" });
    s.model.addresses.push("123 Main St");
    await s.say("123 Main St");
    expect(s.calendar.events).toHaveLength(1);
    expect(s.conv().reason).toBe("booked");
  });
});

describe("when the calendar can't be used", () => {
  it("no calendar connected: hands the lead to the owner as before", async () => {
    const s = setup({ calendar: "none" });
    await s.say("AC repair in Cleveland, soon");
    expect(bodies(s)).toEqual([COMPLETE]);
    expect(s.email.sent[0]?.subject).toBe("Lead ready: (423) 555-0111");
  });

  it("an emergency job is never put on the calendar", async () => {
    const s = setup({ urgency: "emergency" });
    await s.say("AC repair in Cleveland, it's urgent");
    expect(bodies(s)).toEqual([COMPLETE]);
    expect(s.calendar.busyCalls).toBe(0);
  });

  it("a full calendar hands the lead to the owner", async () => {
    const s = setup();
    s.calendar.busyBlocks.push({ start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-12-01T00:00:00Z") });
    await s.say("AC repair in Cleveland, soon");
    expect(bodies(s)).toEqual([COMPLETE]);
  });

  it("Google down when offering: hands the lead to the owner", async () => {
    const s = setup();
    s.calendar.fail = new CalendarUnavailableError("503");
    await s.say("AC repair in Cleveland, soon");
    expect(bodies(s)).toEqual([COMPLETE]);
  });

  it("access revoked: marks it, alerts ops, and hands the lead to the owner", async () => {
    const s = setup();
    s.calendar.fail = new CalendarAuthError();
    await s.say("AC repair in Cleveland, soon");
    expect(bodies(s)).toEqual([COMPLETE]);
    expect(s.revoked).toEqual([TENANT_ID]);
    expect(s.alerts.map((a) => a.event)).toContain("calendar.revoked");
  });

  it("Google down at booking: no confirmation is sent, owner asked to call", async () => {
    const s = setup();
    await s.say("AC repair in Cleveland, soon");
    await s.say("2");
    s.calendar.fail = new CalendarUnavailableError("503");
    s.model.addresses.push("123 Main St");
    await s.say("123 Main St");
    expect(bodies(s).some((b) => b.startsWith("You're booked"))).toBe(false);
    expect(s.conv()).toMatchObject({ status: "handed_off", reason: "calendar_unavailable" });
    expect(s.email.sent[0]?.text).toContain("couldn't reach your calendar");
  });
});

describe("safety still comes first while booking", () => {
  it("an emergency while choosing a time gets the 911 text", async () => {
    const s = setup();
    await s.say("AC repair in Cleveland, soon");
    await s.say("wait, I smell gas now");
    expect(bodies(s).at(-2)).toContain("call 911");
    expect(s.conv().status).toBe("handed_off");
  });

  it("asking for a person while picking a time hands off", async () => {
    const s = setup();
    await s.say("AC repair in Cleveland, soon");
    s.model.categories.push("wants_human");
    await s.say("can someone just call me");
    expect(s.conv()).toMatchObject({ status: "handed_off", reason: "wants_human" });
  });
});
