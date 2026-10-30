import type { TenantConfig, Weekday } from "./tenant-config";

// Estimate slots from business hours, minus busy time on the owner's calendar.
// Pure: no I/O, no clock. All times are UTC Date objects; business hours are
// read in the tenant's time zone (DST-safe).

export interface BusyInterval {
  start: Date;
  end: Date;
}

export interface SlotOptions {
  now: Date;
  busy: BusyInterval[];
  // Earliest a slot may start, from now.
  minLeadMinutes?: number;
  // Kept free before and after each busy block.
  bufferMinutes?: number;
  // Slot starts are aligned to this.
  stepMinutes?: number;
  // How many to return; defaults to config.calendar.slotsToOffer.
  count?: number;
}

const WEEKDAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parts(date: Date, timeZone: string) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const get = (type: string) => p.find((x) => x.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: get("weekday").toLowerCase().slice(0, 3) as Weekday,
  };
}

// Minutes the zone is ahead of UTC at this instant.
function offsetMinutes(date: Date, timeZone: string): number {
  const p = parts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60_000);
}

// The UTC instant for a wall-clock time in a zone. Times that don't exist
// (spring-forward gap) resolve to the later offset; repeated times (fall-back)
// resolve to the first occurrence.
export function zonedToUtc(
  y: number,
  m: number,
  d: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  // The offset can only be one of the two in effect 12h either side.
  const offsets = [...new Set([-12, 12].map((h) => offsetMinutes(new Date(guess + h * 3_600_000), timeZone)))];
  const candidates = offsets.map((o) => guess - o * 60_000).sort((a, b) => a - b);
  const matches = candidates.filter((c) => {
    const p = parts(new Date(c), timeZone);
    return p.year === y && p.month === m && p.day === d && p.hour === hour && p.minute === minute;
  });
  // Repeated time: the first occurrence. Missing time (gap): the later instant.
  return new Date(matches[0] ?? candidates[candidates.length - 1]!);
}

function hhmm(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function overlaps(a: BusyInterval, b: BusyInterval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function findEstimateSlots(config: TenantConfig, opts: SlotOptions): Date[] {
  const tz = config.timezone;
  const duration = config.calendar.estimateDurationMinutes;
  const count = opts.count ?? config.calendar.slotsToOffer;
  const step = opts.stepMinutes ?? 30;
  const buffer = (opts.bufferMinutes ?? 30) * 60_000;
  const earliest = opts.now.getTime() + (opts.minLeadMinutes ?? 120) * 60_000;
  // An unreadable busy block makes every time look busy: fail closed.
  if (opts.busy.some((b) => Number.isNaN(b.start.getTime()) || Number.isNaN(b.end.getTime()))) return [];
  const busy = opts.busy.map((b) => ({ start: new Date(b.start.getTime() - buffer), end: new Date(b.end.getTime() + buffer) }));

  // Free slots per day, in order.
  const byDay: Date[][] = [];
  const today = parts(opts.now, tz);
  for (let i = 0; i <= config.calendar.bookingWindowDays; i++) {
    // Noon UTC on the local date avoids DST edges when stepping days.
    const dayNoon = new Date(Date.UTC(today.year, today.month - 1, today.day + i, 12));
    const local = parts(dayNoon, "UTC");
    const weekday = WEEKDAYS[dayNoon.getUTCDay()] as Weekday;
    const ranges = [...(config.hours[weekday] ?? [])].sort((a, b) => hhmm(a.open) - hhmm(b.open));
    const slots: Date[] = [];
    for (const range of ranges) {
      for (let t = hhmm(range.open); t + duration <= hhmm(range.close); t += step) {
        const start = zonedToUtc(local.year, local.month, local.day, Math.floor(t / 60), t % 60, tz);
        // Skip wall-clock times that don't exist (spring-forward gap).
        const back = parts(start, tz);
        if (back.hour * 60 + back.minute !== t) continue;
        if (start.getTime() < earliest || slots.some((x) => x.getTime() === start.getTime())) continue;
        const slot = { start, end: new Date(start.getTime() + duration * 60_000) };
        if (busy.some((b) => overlaps(slot, b))) continue;
        slots.push(start);
      }
    }
    if (slots.length) byDay.push(slots.sort((a, b) => a.getTime() - b.getTime()));
  }

  // Spread across days: the first free slot of each day; if more are needed,
  // a later one on the same days (at least 3 hours after the last pick).
  const picked: Date[] = [];
  const lastPick = new Map<number, number>();
  for (let round = 0; picked.length < count && round < 4; round++) {
    byDay.forEach((day, i) => {
      if (picked.length >= count) return;
      const after = lastPick.get(i);
      const slot = after === undefined ? day[0] : day.find((s) => s.getTime() >= after + 3 * 3_600_000);
      if (!slot) return;
      picked.push(slot);
      lastPick.set(i, slot.getTime());
    });
  }
  return picked.sort((a, b) => a.getTime() - b.getTime());
}

// "Tue, Nov 3, 9:00 AM" in the tenant's zone.
export function formatSlot(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
