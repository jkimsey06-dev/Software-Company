import type { ConversationModel, LeadDetails } from "@sc/ai";
import type { TenantConfig } from "@sc/shared";
import type { Logger, MessageUpdate, SmsSender } from "../missed-call/types";
import type { NotificationDeps } from "../notifications/types";

export type ConversationStatus = "active" | "handed_off" | "completed";

export interface Conversation {
  id: string;
  status: ConversationStatus;
  aiReplies: number;
  leadId: string | null;
  createdAt: Date;
  details: LeadDetails;
}

export interface ThreadMessage {
  from: "customer" | "business";
  text: string;
  at: Date;
  // Customer messages only.
  messageSid?: string;
  // A STOP/HELP/... keyword: never part of the AI conversation.
  keyword?: boolean;
  // Already has a recorded decision (conversation turn).
  handled?: boolean;
}

export type TurnAction =
  | "ask"
  | "complete"
  | "out_of_area"
  | "unlisted_service"
  | "emergency"
  | "handoff"
  | "fallback"
  | "turn_limit"
  | "skipped"
  | "merged"
  | "send_failed"
  | "opted_out"
  | "timed_out";

export interface TurnRecord {
  tenantId: string;
  conversationId: string;
  inboundMessageSid: string;
  action: TurnAction;
  reason?: string;
  safetyCategory?: string;
  model?: string;
  promptVersion?: string;
  inputTokens?: number;
  outputTokens?: number;
  outboundMessageId?: string | null;
}

export interface UnhandledMessage {
  tenantId: string;
  messageSid: string;
  fromPhone: string;
  body: string;
  leadId: string | null;
  createdAt: Date;
}

export interface ConversationStore {
  startConversation(tenantId: string, phone: string, leadId: string | null): Promise<Conversation>;
  // A token for exactly one holder, or null if someone else holds it.
  acquireLease(conversationId: string): Promise<string | null>;
  // Only releases if `token` still holds the lease.
  releaseLease(conversationId: string, token: string): Promise<void>;
  // Texts both ways with this customer since `since`, oldest first, with
  // customer messages marked as keyword / already handled.
  loadThread(tenantId: string, phone: string, since: Date): Promise<ThreadMessage[]>;
  // One row per inbound message; a repeat is ignored.
  recordTurns(turns: TurnRecord[]): Promise<void>;
  setStatus(conversationId: string, status: ConversationStatus, reason?: string): Promise<void>;
  setDetails(conversationId: string, details: LeadDetails): Promise<void>;
  incrementAiReplies(conversationId: string): Promise<void>;
  updateLeadDetails(tenantId: string, leadId: string, details: LeadDetails): Promise<void>;
  isOptedOut(tenantId: string, phone: string): Promise<boolean>;
  addOptOut(tenantId: string, phone: string): Promise<void>;
  tenantOwnsNumber(tenantId: string, phone: string): Promise<boolean>;
  // Inserts the outbound row if this key is new; null means it was already claimed.
  claimOutbound(message: {
    tenantId: string;
    idempotencyKey: string;
    leadId: string | null;
    toPhone: string;
    fromPhone: string;
    body: string;
    templateVersion: string;
  }): Promise<string | null>;
  markMessage(id: string, update: MessageUpdate): Promise<void>;
  findUnhandled(olderThanMinutes: number, limit: number): Promise<UnhandledMessage[]>;
}

export interface ConversationDeps {
  store: ConversationStore;
  sender: SmsSender;
  // Null when no model is configured: emergencies are still handled, and
  // everything else goes to the owner.
  modelFor: (config: TenantConfig) => ConversationModel | null;
  notifications: NotificationDeps | null;
  log: Logger;
  // How long to wait for another worker to finish this conversation before
  // handing the message to the owner instead.
  leaseWaitMs?: number;
}

export interface CustomerMessage {
  tenantId: string;
  config: TenantConfig;
  customerPhone: string;
  businessNumber: string;
  leadId: string | null;
  messageSid: string;
  body: string;
}
