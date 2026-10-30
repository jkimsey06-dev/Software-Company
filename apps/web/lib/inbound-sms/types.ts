import type { TenantConfig } from "@sc/shared";
import type { Logger } from "../missed-call/types";
import type { Keyword } from "./keywords";

export interface InboundSms {
  messageSid: string;
  from: string;
  to: string;
  body: string;
  numMedia: number;
  optOutType?: string;
}

export interface InboundSmsStore {
  // Tenant id only, without reading config, so STOP works even if a tenant's
  // config is broken.
  findTenantIdByNumber(phone: string): Promise<string | null>;
  // Throws if the tenant's config is invalid.
  loadTenantConfig(tenantId: string): Promise<TenantConfig>;
  // Returns false if this MessageSid was already recorded.
  recordInbound(message: {
    tenantId: string;
    messageSid: string;
    fromPhone: string;
    toPhone: string;
    body: string;
    keyword: Keyword | null;
    leadId: string | null;
  }): Promise<boolean>;
  addOptOut(tenantId: string, phone: string): Promise<void>;
  removeOptOut(tenantId: string, phone: string): Promise<void>;
  findLatestLeadId(tenantId: string, phone: string): Promise<string | null>;
}

// Tells the owner a customer texted. Queues work for after the response.
export type ReplyNotifier = (reply: {
  tenantId: string;
  config: TenantConfig;
  leadId: string | null;
  messageSid: string;
  callerPhone: string;
  body: string;
  numMedia: number;
  receivedAt: Date;
}) => void;

export interface SmsDeps {
  store: InboundSmsStore;
  log: Logger;
  notifyReply?: ReplyNotifier;
}
