import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findEstimateSlots, formatSlot, zonedToUtc } from "./scheduling";
import { parseTenantConfig } from "./tenant-config";

const base = JSON.parse(readFileSync(new URL("../../../clients/example-hvac.json", import.meta.url), "utf8"));
const config = (o: Record<string, unknown> = {}) => parseTenantConfig({ ...base, ...o });
const NY = "America/New_York";
const labels = (slots: Date[], tz = NY) => slots.map((s) => formatSlot(s, tz));

describe("zonedToUtc", () => {
  it("converts wall-clock time in the zone, across DST", () => {
    expect(zonedToUtc(2026, 10, 30, 9, 0, NY).toISOString()).toBe("2026-10-30T13:00:00.000Z"); // EDT
    expect(zonedToUtc(2026, 11, 2, 9, 0, NY).toISOString()).toBe("2026-11-02T14:00:00.000Z"); // EST
    expect(zonedToUtc(2027, 3, 15, 9, 0, NY).toISOString()).toBe("2027-03-15T13:00:00.000Z"); // EDT again
  });

  it("resolves the repeated fall-back hour to its first occurrence", () => {
    expect(zonedToUtc(2026, 11, 1, 1, 30, NY).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });
});

describe("findEstimateSlots", () => {
  // Friday Oct 30 2026, 10:00 AM in New York.
  const now = new Date("2026-10-30T14:00:00Z");

  it("offers the first free slot on each of the next business days, inside hours", () => {
    const slots = findEstimateSlots(config(), { now, busy: [] });
    // Fri: earliest is now + 2h (noon); Sat/Sun closed; then Mon, Tue.
    expect(labels(slots)).toEqual(["Fri, Oct 30, 12:00 PM", "Mon, Nov 2, 8:00 AM", "Tue, Nov 3, 8:00 AM"]);
  });

  it("uses the standard-time offset after the DST change", () => {
    const [, monday] = findEstimateSlots(config(), { now, busy: [] });
    expect(monday?.toISOString()).toBe("2026-11-02T13:00:00.000Z");
  });

  it("skips busy time plus the buffer around it", () => {
    const busy = [{ start: new Date("2026-11-02T13:00:00Z"), end: new Date("2026-11-02T15:00:00Z") }]; // Mon 8-10 AM EST
    const slots = findEstimateSlots(config(), { now, busy, count: 5 });
    expect(labels(slots)).toContain("Mon, Nov 2, 10:30 AM");
    expect(labels(slots)).not.toContain("Mon, Nov 2, 8:00 AM");
    expect(labels(slots)).not.toContain("Mon, Nov 2, 10:00 AM");
  });

  it("never offers a slot that runs past closing time", () => {
    const late = new Date("2026-10-30T20:30:00Z"); // Fri 4:30 PM
    const [first] = findEstimateSlots(config(), { now: late, busy: [], minLeadMinutes: 0 });
    expect(formatSlot(first!, NY)).toBe("Mon, Nov 2, 8:00 AM");
  });

  it("returns nothing when the calendar is full", () => {
    const busy = [{ start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-12-01T00:00:00Z") }];
    expect(findEstimateSlots(config(), { now, busy })).toEqual([]);
  });

  it("returns nothing when the business has no hours", () => {
    expect(findEstimateSlots(config({ hours: {} }), { now, busy: [] })).toEqual([]);
  });

  it("takes a later slot on the same day, not the next half hour, when days run short", () => {
    const c = config({ calendar: { provider: "google", bookingWindowDays: 1 } });
    const slots = findEstimateSlots(c, { now: new Date("2026-11-02T12:00:00Z"), busy: [], count: 3 });
    expect(labels(slots)).toEqual(["Mon, Nov 2, 9:00 AM", "Mon, Nov 2, 12:00 PM", "Tue, Nov 3, 8:00 AM"]);
  });

  it("handles the spring-forward gap without inventing or skipping hours", () => {
    const sunday = config({
      hours: { sun: [{ open: "01:00", close: "05:00" }] },
      calendar: { provider: "google", estimateDurationMinutes: 30, bookingWindowDays: 1 },
    });
    // Sunday Mar 14 2027: 2:00-2:59 AM doesn't exist in New York.
    const slots = findEstimateSlots(sunday, { now: new Date("2027-03-13T12:00:00Z"), busy: [], count: 20, minLeadMinutes: 0 });
    const times = labels(slots);
    expect(times.some((t) => t.includes(" 2:00 AM") || t.includes(" 2:30 AM"))).toBe(false);
    expect(times).toContain("Sun, Mar 14, 1:00 AM");
  });

  it("works in another time zone", () => {
    const chicago = config({ timezone: "America/Chicago" });
    const [first] = findEstimateSlots(chicago, { now: new Date("2026-11-02T12:00:00Z"), busy: [], minLeadMinutes: 0 });
    expect(formatSlot(first!, "America/Chicago")).toBe("Mon, Nov 2, 8:00 AM");
    expect(first?.toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });
});
