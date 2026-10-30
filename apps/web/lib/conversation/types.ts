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
}

export interface ThreadMessage {
  from: "customer" | "business";
  text: string;
  at: Date;
  // Customer messages only.
  messageSid?: string;
}

export type TurnAction =
  | "ai_reply"
  | "emergency"
  | "handoff"
  | "complete"
  | "fallback"
  | "ai_disclosure"
  | "turn_limit"
  | "skipped";

export interface TurnRecord {
  tenantId: string;
  conversationId: string;
  inboundMessageSid: string;
  action: TurnAction;
  safetyCategory?: string;
  model?: string;
  promptVersion?: string;
  guardViolations?: string[];
  inputTokens?: number;
  outputTokens?: number;
  outboundMessageId?: string | null;
}

export interface ConversationStore {
  startConversation(tenantId: string, phone: string, leadId: string | null): Promise<Conversation>;
  acquireLease(conversationId: string): Promise<boolean>;
  releaseLease(conversationId: string): Promise<void>;
  // Texts both ways with this customer since `since`, oldest first.
  loadThread(tenantId: string, phone: string, since: Date): Promise<ThreadMessage[]>;
  // Returns false if this inbound message already has a turn.
  recordTurn(turn: TurnRecord): Promise<boolean>;
  setStatus(conversationId: string, status: ConversationStatus, reason?: string): Promise<void>;
  incrementAiReplies(conversationId: string): Promise<void>;
  updateLeadDetails(tenantId: string, leadId: string, details: LeadDetails): Promise<void>;
  isOptedOut(tenantId: string, phone: string): Promise<boolean>;
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
}

export interface ConversationDeps {
  store: ConversationStore;
  sender: SmsSender;
  modelFor: (config: TenantConfig) => ConversationModel;
  notifications: NotificationDeps | null;
  log: Logger;
}

export interface CustomerMessage {
  tenantId: string;
  config: TenantConfig;
  customerPhone: string;
  businessNumber: string;
  leadId: string | null;
  messageSid: string;
}
