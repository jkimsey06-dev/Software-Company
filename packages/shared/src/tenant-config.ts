import { z } from "zod";

// Per-client configuration. Everything that differs between clients lives here,
// never in code. Stored as `tenants.config` (jsonb) and in /clients/<slug>.json.
// No secrets: API keys and tokens go in environment variables or a secret store.

export const CONFIG_SCHEMA_VERSION = 1;

const E164 = /^\+[1-9]\d{7,14}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const US_ZIP = /^\d{5}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const phoneE164 = z.string().regex(E164, "phone must be E.164, e.g. +14235551234");

const timezone = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: "timezone must be a valid IANA zone, e.g. America/New_York" },
);

export const TRADES = [
  "hvac",
  "plumbing",
  "electrical",
  "roofing",
  "pest_control",
  "garage_doors",
  "landscaping",
] as const;

const service = z.object({
  id: z.string().regex(SLUG),
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  // Can this service be treated as an emergency (owner alerted right away)?
  emergencyEligible: z.boolean().default(false),
});

const timeRange = z
  .object({ open: z.string().regex(HHMM), close: z.string().regex(HHMM) })
  .refine((r) => r.open < r.close, { message: "open must be before close" });

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

// Missing day = closed.
const hours = z.partialRecord(z.enum(WEEKDAYS), z.array(timeRange).max(4));

const serviceArea = z
  .object({
    zipCodes: z.array(z.string().regex(US_ZIP)).default([]),
    cities: z.array(z.string().min(1).max(80)).default([]),
  })
  .refine((a) => a.zipCodes.length + a.cities.length > 0, {
    message: "service area needs at least one zip code or city",
  });

const knowledgeBaseEntry = z.object({
  id: z.string().regex(SLUG),
  question: z.string().min(1).max(300),
  answer: z.string().min(1).max(2000),
});

const messaging = z.object({
  // A2P 10DLC: texts are only sent once the client's own campaign is approved.
  a2pStatus: z.enum(["not_started", "pending", "approved", "rejected"]),
  a2pCampaignId: z.string().max(64).optional(),
  fromNumber: phoneE164.optional(),
  aiDisclosureAtStart: z.boolean().default(true),
  optOutText: z.string().min(1).max(100).default("Reply STOP to opt out"),
  textBackDelaySeconds: z.number().int().min(0).max(300).default(15),
});

const calendar = z.object({
  provider: z.literal("google"),
  // Set during onboarding once the owner connects their calendar.
  calendarId: z.string().max(256).optional(),
  estimateDurationMinutes: z.number().int().min(15).max(480).default(60),
  bookingWindowDays: z.number().int().min(1).max(30).default(7),
  slotsToOffer: z.number().int().min(1).max(5).default(3),
});

export const tenantConfigSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
  slug: z.string().regex(SLUG).max(63),
  businessName: z.string().min(1).max(120),
  trade: z.enum(TRADES),
  timezone,
  services: z.array(service).min(1),
  hours,
  serviceArea,
  tone: z.object({
    style: z.enum(["friendly", "professional", "casual"]),
    notes: z.string().max(500).optional(),
  }),
  escalationContact: z.object({
    name: z.string().min(1).max(120),
    phone: phoneE164,
    email: z.email().optional(),
  }),
  knowledgeBase: z.array(knowledgeBaseEntry).default([]),
  messaging,
  calendar,
}).superRefine((c, ctx) => {
  for (const [key, items] of [["services", c.services], ["knowledgeBase", c.knowledgeBase]] as const) {
    const seen = new Set<string>();
    items.forEach((item, i) => {
      if (seen.has(item.id)) {
        ctx.addIssue({ code: "custom", path: [key, i, "id"], message: `duplicate id "${item.id}"` });
      }
      seen.add(item.id);
    });
  }
});

export type TenantConfig = z.infer<typeof tenantConfigSchema>;
export type TenantConfigInput = z.input<typeof tenantConfigSchema>;

export function parseTenantConfig(input: unknown): TenantConfig {
  return tenantConfigSchema.parse(input);
}

// The only gate for outbound SMS. Never send from an unregistered number.
export function canSendTexts(config: TenantConfig): boolean {
  return (
    config.messaging.a2pStatus === "approved" &&
    Boolean(config.messaging.a2pCampaignId) &&
    Boolean(config.messaging.fromNumber)
  );
}
