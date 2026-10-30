import { readFileSync } from "node:fs";
import { parseTenantConfig, type TenantConfig } from "@sc/shared";
import {
  SmsSendError,
  type CallOutcome,
  type Logger,
  type MessageUpdate,
  type MissedCallStore,
  type NewOutboundMessage,
  type SmsSender,
} from "./types";

export const TENANT_ID = "10000000-0000-0000-0000-000000000001";
export const BUSINESS_NUMBER = "+14235550150";
export const OWNER_PHONE = "+14235550100";
export const CALLER = "+14235550111";
export const CALL_SID = `CA${"a".repeat(32)}`;
export const BASE_URL = "https://app.example.com";

const example = JSON.parse(
  readFileSync(new URL("../../../../clients/example-hvac.json", import.meta.url), "utf8"),
);

export function textingConfig(overrides: Record<string, unknown> = {}): TenantConfig {
  return parseTenantConfig({
    ...example,
    messaging: {
      a2pStatus: "approved",
      a2pCampaignId: "CXTEST",
      fromNumber: BUSINESS_NUMBER,
    },
    ...overrides,
  });
}

interface CallRow {
  tenantId: string;
  fromPhone: string | null;
  outcome: CallOutcome | null;
  leadId: string | null;
}

// In-memory stand-in for the Supabase store, with the same uniqueness rules
// as the database (call_sid unique, idempotency key unique per tenant).
export class FakeStore implements MissedCallStore {
  tenants = new Map<string, { tenantId: string; config: TenantConfig }>();
  calls = new Map<string, CallRow>();
  leads: { id: string; tenantId: string; phone: string }[] = [];
  optOuts = new Set<string>();
  messages = new Map<string, NewOutboundMessage & { id: string; status: string; detail?: string }>();
  failOn = new Set<keyof MissedCallStore>();

  constructor(config: TenantConfig = textingConfig()) {
    this.tenants.set(BUSINESS_NUMBER, { tenantId: TENANT_ID, config });
  }

  private maybeFail(method: keyof MissedCallStore) {
    if (this.failOn.has(method)) throw new Error(`${method} unavailable`);
  }

  async findTenantByNumber(phone: string) {
    this.maybeFail("findTenantByNumber");
    return this.tenants.get(phone) ?? null;
  }

  async recordInboundCall(call: { tenantId: string; callSid: string; fromPhone: string | null }) {
    this.maybeFail("recordInboundCall");
    if (!this.calls.has(call.callSid)) {
      this.calls.set(call.callSid, { ...call, outcome: null, leadId: null });
    }
  }

  async setCallOutcome(call: {
    tenantId: string;
    callSid: string;
    fromPhone: string | null;
    outcome: CallOutcome;
  }) {
    this.maybeFail("setCallOutcome");
    const existing = this.calls.get(call.callSid);
    if (!existing) {
      this.calls.set(call.callSid, { ...call, leadId: null });
      return call.outcome;
    }
    existing.outcome ??= call.outcome;
    return existing.outcome;
  }

  async findOrCreateMissedCallLead(tenantId: string, phone: string) {
    this.maybeFail("findOrCreateMissedCallLead");
    const lead = this.leads.find((l) => l.tenantId === tenantId && l.phone === phone);
    if (lead) return lead.id;
    const id = `lead-${this.leads.length + 1}`;
    this.leads.push({ id, tenantId, phone });
    return id;
  }

  async linkCallToLead(_tenantId: string, callSid: string, leadId: string) {
    const call = this.calls.get(callSid);
    if (call) call.leadId = leadId;
  }

  async isOptedOut(tenantId: string, phone: string) {
    this.maybeFail("isOptedOut");
    return this.optOuts.has(`${tenantId}:${phone}`);
  }

  // Ignores the time window: every message in a test counts as recent.
  async hasRecentTextback(tenantId: string, phone: string) {
    this.maybeFail("hasRecentTextback");
    return [...this.messages.values()].some(
      (m) =>
        m.tenantId === tenantId &&
        m.toPhone === phone &&
        m.idempotencyKey.startsWith("missed-call-textback:") &&
        m.status !== "failed",
    );
  }

  async addOptOut(tenantId: string, phone: string) {
    this.optOuts.add(`${tenantId}:${phone}`);
  }

  async claimOutboundMessage(message: NewOutboundMessage) {
    this.maybeFail("claimOutboundMessage");
    const key = `${message.tenantId}:${message.idempotencyKey}`;
    if (this.messages.has(key)) return null;
    const id = `msg-${this.messages.size + 1}`;
    this.messages.set(key, { ...message, id, status: "pending" });
    return id;
  }

  async markMessage(id: string, update: MessageUpdate) {
    for (const message of this.messages.values()) {
      if (message.id === id) {
        message.status = update.status;
        message.detail = update.status === "sent" ? update.providerSid : update.errorCode;
      }
    }
  }

  message() {
    return [...this.messages.values()][0];
  }
}

export class FakeSender implements SmsSender {
  sent: { from: string; to: string; body: string }[] = [];
  failWith: SmsSendError | Error | null = null;

  async send(message: { from: string; to: string; body: string }) {
    if (this.failWith) throw this.failWith;
    this.sent.push(message);
    return { sid: `SM${"0".repeat(31)}${this.sent.length}` };
  }
}

export function recordingLogger(): Logger & { events: string[]; lines: string[] } {
  const events: string[] = [];
  const lines: string[] = [];
  const log = ((event: string, fields = {}) => {
    events.push(event);
    lines.push(JSON.stringify({ event, ...fields }));
  }) as Logger & { events: string[]; lines: string[] };
  log.events = events;
  log.lines = lines;
  return log;
}
