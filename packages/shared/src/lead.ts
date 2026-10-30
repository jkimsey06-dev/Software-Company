// Mirrors the enums in supabase/migrations. Change both together.
export const LEAD_URGENCIES = ["emergency", "soon", "flexible", "unknown"] as const;
export type LeadUrgency = (typeof LEAD_URGENCIES)[number];

export const LEAD_STATUSES = ["new", "contacted", "booked", "won", "lost", "spam"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_SOURCES = ["missed_call", "web_form", "manual"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];
