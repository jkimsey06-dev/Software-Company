import { formatSlot } from "@sc/shared";

export const LEAD_STATUSES = ["new", "contacted", "booked", "won", "lost", "spam"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

const STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  booked: "Booked",
  won: "Won",
  lost: "Lost",
  spam: "Spam",
};

const URGENCY_LABELS: Record<string, string> = {
  emergency: "Emergency",
  soon: "Soon",
  flexible: "Flexible",
  unknown: "Not asked yet",
};

export const PAGE_SIZE = 25;
const DEFAULT_TIMEZONE = "America/New_York";

export const statusLabel = (s: string) => STATUS_LABELS[s as LeadStatus] ?? s;
export const urgencyLabel = (u: string) => URGENCY_LABELS[u] ?? u;

// Only exact status names are accepted from the URL.
export function parseStatusFilter(value: string | string[] | undefined): LeadStatus | null {
  const v = Array.isArray(value) ? value[0] : value;
  return LEAD_STATUSES.find((s) => s === v) ?? null;
}

export function parsePage(value: string | string[] | undefined): number {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v || !/^[0-9]{1,4}$/.test(v)) return 1;
  return Math.max(1, Number(v));
}

// Tenant config is validated before it's stored, but the dashboard reads it
// defensively: a bad value must not break the page.
export function tenantTimezone(config: unknown): string {
  const tz = (config as { timezone?: unknown } | null)?.timezone;
  if (typeof tz !== "string") return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

export function serviceName(config: unknown, serviceId: string | null): string {
  if (!serviceId) return "Not given yet";
  const services = (config as { services?: unknown } | null)?.services;
  if (Array.isArray(services)) {
    for (const s of services) {
      const item = s as { id?: unknown; name?: unknown };
      if (item.id === serviceId && typeof item.name === "string") return item.name;
    }
  }
  return serviceId;
}

// "Oct 30, 2:15 PM", in the business's time zone.
export function formatWhen(iso: string | Date, timezone: string): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

export function formatEstimate(iso: string, timezone: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : formatSlot(d, timezone);
}

// Only a valid phone number becomes a tel: link.
export function telHref(phone: string): string | null {
  return /^\+[1-9][0-9]{7,14}$/.test(phone) ? `tel:${phone}` : null;
}
