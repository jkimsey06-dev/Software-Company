import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findEstimateSlots, formatSlot, zonedToUtc } from "./scheduling";
import { parseTenantConfig } from "./tenant-config";

// QA: edge cases for the estimate slot finder. Pure, no I/O.
const base = JSON.parse(readFileSync(new URL("../../../clients/example-hvac.json", import.meta.url), "utf8"));
const config = (o: Record<string, unknown> = {}) => parseTenantConfig({ ...base, ...o });
const cal = (o: Record<string, unknown>) => ({ provider: "google", ...o });
const NY = "America/New_York";
const labels = (slots: Date[], tz = NY) => slots.map((s) => formatSlot(s, tz));
const weekdays = (open: string, close: string) =>
  Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((d) => [d, [{ open, close }]]));

describe("DST", () => {
  it("fall back (Nov 1 2026): Monday after uses EST, Friday before uses EDT", () => {
    const slots = findEstimateSlots(config(), { now: new Date("2026-10-30T11:00:00Z"), busy: [], count: 2, minLeadMinutes: 0 });
    expect(slots.map((s) => s.toISOString())).toEqual(["2026-10-30T12:00:00.000Z", "2026-11-02T13:00:00.000Z"]);
  });

  it("zonedToUtc on fall-back day: wall times after the repeated hour map to standard time", () => {
    // 3:00 AM EST on Nov 1 2026 is 08:00Z; LA 8:00 AM PST is 16:00Z.
    expect(zonedToUtc(2026, 11, 1, 3, 0, NY).toISOString()).toBe("2026-11-01T08:00:00.000Z");
    expect(zonedToUtc(2026, 11, 1, 8, 0, "America/Los_Angeles").toISOString()).toBe("2026-11-01T16:00:00.000Z");
  });

  it("fall-back Sunday: a business open 8 AM in Los Angeles is offered 8 AM", () => {
    const c = config({ timezone: "America/Los_Angeles", hours: { sun: [{ open: "08:00", close: "12:00" }] }, calendar: cal({ bookingWindowDays: 1 }) });
    const [first] = findEstimateSlots(c, { now: new Date("2026-10-31T20:00:00Z"), busy: [], minLeadMinutes: 0 });
    expect(first && formatSlot(first, "America/Los_Angeles")).toBe("Sun, Nov 1, 8:00 AM");
  });

  it("spring forward (Mar 14 2027): Monday 8 AM is EDT (12:00Z)", () => {
    const [, monday] = findEstimateSlots(config(), { now: new Date("2027-03-12T14:00:00Z"), busy: [], count: 2 });
    expect(monday?.toISOString()).toBe("2027-03-15T12:00:00.000Z");
  });

  it("zonedToUtc repeated hour in Chicago resolves to first occurrence (CDT)", () => {
    expect(zonedToUtc(2026, 11, 1, 1, 30, "America/Chicago").toISOString()).toBe("2026-11-01T06:30:00.000Z");
  });
});

describe("busy blocks", () => {
  const now = new Date("2026-10-30T14:00:00Z"); // Fri 10 AM NY

  it("a block spanning midnight (Sun 10 PM - Mon 9 AM) pushes Monday to 9:30 AM", () => {
    const busy = [{ start: new Date("2026-11-02T03:00:00Z"), end: new Date("2026-11-02T14:00:00Z") }];
    const slots = findEstimateSlots(config(), { now, busy, count: 5 });
    expect(labels(slots).find((l) => l.startsWith("Mon"))).toBe("Mon, Nov 2, 9:30 AM");
  });

  it("an all-day event (local midnight to midnight) removes the whole day", () => {
    const busy = [{ start: new Date("2026-11-02T05:00:00Z"), end: new Date("2026-11-03T05:00:00Z") }];
    const slots = findEstimateSlots(config(), { now, busy, count: 5 });
    expect(labels(slots).some((l) => l.startsWith("Mon"))).toBe(false);
  });

  it("buffer edge: busy 8-9 AM offers 9:30, never 9:00", () => {
    const busy = [{ start: new Date("2026-11-02T13:00:00Z"), end: new Date("2026-11-02T14:00:00Z") }];
    const c = config({ calendar: cal({ bookingWindowDays: 3 }) });
    const slots = findEstimateSlots(c, { now: new Date("2026-11-02T05:00:00Z"), busy, count: 1, minLeadMinutes: 0 });
    expect(labels(slots)).toEqual(["Mon, Nov 2, 9:30 AM"]);
  });
});

describe("hours shapes", () => {
  const now = new Date("2026-11-02T05:00:00Z"); // Mon 0:00 NY

  it("multiple ranges: lunch gap is respected", () => {
    const c = config({ hours: { mon: [{ open: "08:00", close: "12:00" }, { open: "13:00", close: "17:00" }] }, calendar: cal({ bookingWindowDays: 1 }) });
    const busy = [{ start: new Date("2026-11-02T13:00:00Z"), end: new Date("2026-11-02T16:30:00Z") }]; // 8-11:30
    const [first] = findEstimateSlots(c, { now, busy, count: 1, minLeadMinutes: 0 });
    expect(formatSlot(first!, NY)).toBe("Mon, Nov 2, 1:00 PM");
  });

  it("multiple ranges listed out of order still offer the earliest free time", () => {
    const c = config({ hours: { mon: [{ open: "13:00", close: "17:00" }, { open: "08:00", close: "12:00" }] }, calendar: cal({ bookingWindowDays: 1 }) });
    const [first] = findEstimateSlots(c, { now, busy: [], count: 1, minLeadMinutes: 0 });
    expect(formatSlot(first!, NY)).toBe("Mon, Nov 2, 8:00 AM");
  });

  it("close not on the step: never runs past close", () => {
    const c = config({ hours: { mon: [{ open: "08:15", close: "16:45" }] }, calendar: cal({ bookingWindowDays: 1 }) });
    const slots = findEstimateSlots(c, { now, busy: [], count: 5, minLeadMinutes: 0 });
    expect(labels(slots)[0]).toBe("Mon, Nov 2, 8:15 AM");
    for (const s of slots) expect(s.getTime() + 3_600_000).toBeLessThanOrEqual(Date.parse("2026-11-02T21:45:00Z"));
  });

  it("a range shorter than the estimate gives nothing", () => {
    const c = config({ hours: { mon: [{ open: "08:00", close: "08:30" }] }, calendar: cal({ bookingWindowDays: 1 }) });
    expect(findEstimateSlots(c, { now, busy: [], minLeadMinutes: 0 })).toEqual([]);
  });
});

describe("lead time, window, count", () => {
  it("lead time crossing days and a weekend: Fri 4:30 PM + 16h lands Mon 8 AM", () => {
    const [first] = findEstimateSlots(config(), { now: new Date("2026-10-30T20:30:00Z"), busy: [], minLeadMinutes: 960 });
    expect(formatSlot(first!, NY)).toBe("Mon, Nov 2, 8:00 AM");
  });

  it("now on a closed day (Sunday) offers Monday first", () => {
    const [first] = findEstimateSlots(config(), { now: new Date("2026-11-01T17:00:00Z"), busy: [] });
    expect(formatSlot(first!, NY)).toBe("Mon, Nov 2, 8:00 AM");
  });

  it("bookingWindowDays 30 never offers past the window; slotsToOffer 5 gives 5", () => {
    const now = new Date("2026-10-30T14:00:00Z");
    const c = config({ calendar: cal({ bookingWindowDays: 30, slotsToOffer: 5 }) });
    const slots = findEstimateSlots(c, { now, busy: [] });
    expect(slots).toHaveLength(5);
    for (const s of slots) expect(s.getTime()).toBeLessThan(now.getTime() + 31 * 86_400_000);
    const busy = [{ start: new Date("2026-10-30T00:00:00Z"), end: new Date("2026-11-27T00:00:00Z") }];
    const late = findEstimateSlots(c, { now, busy });
    expect(late.length).toBeGreaterThan(0);
    for (const s of late) expect(s.getTime()).toBeLessThan(now.getTime() + 31 * 86_400_000);
  });

  it("slotsToOffer 1 gives exactly the earliest slot", () => {
    const slots = findEstimateSlots(config({ calendar: cal({ slotsToOffer: 1 }) }), { now: new Date("2026-10-30T14:00:00Z"), busy: [] });
    expect(labels(slots)).toEqual(["Fri, Oct 30, 12:00 PM"]);
  });

  // Product: bookingWindowDays counts calendar days, so a Saturday text with a
  // 1-day window has nothing to offer (Sat + Sun closed). Documents current behavior.
  it("[product] window 1 from Saturday offers nothing", () => {
    const c = config({ calendar: cal({ bookingWindowDays: 1 }) });
    expect(findEstimateSlots(c, { now: new Date("2026-10-31T14:00:00Z"), busy: [] })).toEqual([]);
  });

  it("an invalid busy date from the calendar never makes time look free", () => {
    const busy = [{ start: new Date("garbage"), end: new Date("garbage") }];
    // Fail closed: an unparseable busy block should not be ignored silently.
    const slots = findEstimateSlots(config(), { now: new Date("2026-10-30T14:00:00Z"), busy });
    expect(slots).toEqual([]);
  });
});

describe("other zones", () => {
  it("America/Phoenix (no DST): 8 AM MST is 15:00Z both before and after the US change", () => {
    const c = config({ timezone: "America/Phoenix" });
    const slots = findEstimateSlots(c, { now: new Date("2026-10-30T05:00:00Z"), busy: [], count: 2, minLeadMinutes: 0 });
    expect(slots.map((s) => s.toISOString())).toEqual(["2026-10-30T15:00:00.000Z", "2026-11-02T15:00:00.000Z"]);
  });

  it("Pacific/Honolulu: Monday 8 PM local (Tuesday UTC) treats today as Monday", () => {
    const c = config({ timezone: "Pacific/Honolulu" });
    const [first] = findEstimateSlots(c, { now: new Date("2026-11-03T06:00:00Z"), busy: [] });
    expect(formatSlot(first!, "Pacific/Honolulu")).toBe("Tue, Nov 3, 8:00 AM");
    expect(first?.toISOString()).toBe("2026-11-03T18:00:00.000Z");
  });

  it("Asia/Kolkata (+5:30) half-hour offset", () => {
    const c = config({ timezone: "Asia/Kolkata", hours: weekdays("09:00", "17:00") });
    const [first] = findEstimateSlots(c, { now: new Date("2026-11-02T00:00:00Z"), busy: [], minLeadMinutes: 0 });
    expect(first?.toISOString()).toBe("2026-11-02T03:30:00.000Z");
  });
});
