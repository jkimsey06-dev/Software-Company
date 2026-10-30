import type { TenantConfig } from "@sc/shared";

export type CallOutcome = "answered" | "missed";

export interface TenantForNumber {
  tenantId: string;
  config: TenantConfig;
}

export interface NewOutboundMessage {
  tenantId: string;
  idempotencyKey: string;
  leadId: string;
  toPhone: string;
  fromPhone: string;
  body: string;
  templateVersion: string;
}

export type MessageUpdate =
  | { status: "sent"; providerSid: string }
  | { status: "failed" | "unknown"; errorCode: string };

// Persistence used by the missed-call flow. The Supabase implementation runs
// with the service role, server-side only.
export interface MissedCallStore {
  findTenantByNumber(phone: string): Promise<TenantForNumber | null>;
  // Records the call if this CallSid is new; a repeat is a no-op.
  recordInboundCall(call: {
    tenantId: string;
    callSid: string;
    fromPhone: string | null;
    toPhone: string;
  }): Promise<void>;
  // Sets the outcome only if none is set yet, and returns the outcome now
  // stored. The first webhook decides; later ones can't flip it.
  setCallOutcome(call: {
    tenantId: string;
    callSid: string;
    fromPhone: string | null;
    toPhone: string;
    outcome: CallOutcome;
    dialStatus: string;
  }): Promise<CallOutcome>;
  // Reuses the caller's open lead from the last 24 hours, otherwise creates one.
  findOrCreateMissedCallLead(tenantId: string, phone: string): Promise<string>;
  linkCallToLead(tenantId: string, callSid: string, leadId: string): Promise<void>;
  isOptedOut(tenantId: string, phone: string): Promise<boolean>;
  // True if a text-back to this phone was sent (or may have been) since the given time.
  hasRecentTextback(tenantId: string, phone: string, since: Date): Promise<boolean>;
  addOptOut(tenantId: string, phone: string, source: "carrier"): Promise<void>;
  // Inserts the message row if its idempotency key is new. Returns the row id,
  // or null if another request already claimed it (never send in that case).
  claimOutboundMessage(message: NewOutboundMessage): Promise<string | null>;
  markMessage(id: string, update: MessageUpdate): Promise<void>;
}

export class SmsSendError extends Error {
  constructor(
    // rejected: the provider definitely did not accept it.
    // unknown: it may or may not have been sent (timeout, 5xx, network).
    readonly kind: "rejected" | "unknown",
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SmsSendError";
  }
}

export interface SmsSender {
  // Throws SmsSendError on failure.
  send(message: { from: string; to: string; body: string }): Promise<{ sid: string }>;
}

// A short, PII-free description of an error for logs.
export function errorLabel(err: unknown): string {
  if (err instanceof Error && "code" in err && typeof err.code === "string") {
    return `${err.name}:${err.code}`;
  }
  return err instanceof Error ? err.name : "unknown";
}

// Structured log events. Never pass phone numbers or message bodies.
export type Logger = (event: string, fields?: Record<string, string | number | boolean>) => void;
