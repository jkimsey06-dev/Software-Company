import {
  ModelUnavailableError,
  type ConversationModel,
  type LeadDetails,
  type ModelReply,
  type SafetyCategory,
} from "@sc/ai";
import type { MessageUpdate } from "../missed-call/types";
import type { Conversation, ConversationStore, ThreadMessage, TurnRecord } from "./types";

// In-memory store with the same rules as the conversations tables and their
// functions (one active conversation per phone, one lease holder, one turn and
// one outbound message per key).
export class FakeConversationStore implements ConversationStore {
  conversations: (Conversation & { tenantId: string; phone: string; leaseHeld: boolean; reason?: string })[] = [];
  thread: (ThreadMessage & { tenantId: string; phone: string })[] = [];
  turns: TurnRecord[] = [];
  outbound: { id: string; key: string; to: string; body: string; status: string; version: string }[] = [];
  optedOut = new Set<string>();
  ownedNumbers = new Map<string, string>();
  leads = new Map<string, LeadDetails>();
  clock = Date.parse("2026-10-30T18:00:00Z");

  now() {
    this.clock += 1000;
    return new Date(this.clock);
  }

  customerSays(tenantId: string, phone: string, text: string, sid: string) {
    this.thread.push({ tenantId, phone, from: "customer", text, at: this.now(), messageSid: sid });
  }
  businessSaid(tenantId: string, phone: string, text: string) {
    this.thread.push({ tenantId, phone, from: "business", text, at: this.now() });
  }

  async startConversation(tenantId: string, phone: string, leadId: string | null) {
    const existing = this.conversations.filter((c) => c.tenantId === tenantId && c.phone === phone).at(-1);
    if (existing) return { ...existing };
    const c = { id: `conv-${this.conversations.length + 1}`, status: "active" as const, aiReplies: 0, leadId, createdAt: this.now(), tenantId, phone, leaseHeld: false };
    this.conversations.push(c);
    return { ...c };
  }
  async acquireLease(id: string) {
    const c = this.get(id);
    if (c.leaseHeld) return false;
    c.leaseHeld = true;
    return true;
  }
  async releaseLease(id: string) {
    this.get(id).leaseHeld = false;
  }
  async loadThread(tenantId: string, phone: string) {
    return this.thread
      .filter((m) => m.tenantId === tenantId && m.phone === phone)
      .map(({ from, text, at, messageSid }) => ({ from, text, at, messageSid }));
  }
  async recordTurn(t: TurnRecord) {
    if (this.turns.some((x) => x.conversationId === t.conversationId && x.inboundMessageSid === t.inboundMessageSid)) return false;
    this.turns.push(t);
    return true;
  }
  async setStatus(id: string, status: Conversation["status"], reason?: string) {
    Object.assign(this.get(id), { status, reason });
  }
  async incrementAiReplies(id: string) {
    this.get(id).aiReplies += 1;
  }
  async updateLeadDetails(_tenantId: string, leadId: string, d: LeadDetails) {
    this.leads.set(leadId, d);
  }
  async isOptedOut(tenantId: string, phone: string) {
    return this.optedOut.has(`${tenantId}:${phone}`);
  }
  async tenantOwnsNumber(tenantId: string, phone: string) {
    return this.ownedNumbers.get(phone) === tenantId;
  }
  async claimOutbound(m: { tenantId: string; idempotencyKey: string; toPhone: string; body: string; templateVersion: string }) {
    if (this.outbound.some((o) => o.key === `${m.tenantId}:${m.idempotencyKey}`)) return null;
    const id = `out-${this.outbound.length + 1}`;
    this.outbound.push({ id, key: `${m.tenantId}:${m.idempotencyKey}`, to: m.toPhone, body: m.body, status: "pending", version: m.templateVersion });
    // What we send becomes part of the thread, as in the real tables.
    const conv = this.conversations.find((c) => c.tenantId === m.tenantId && c.phone === m.toPhone);
    if (conv) this.thread.push({ tenantId: m.tenantId, phone: m.toPhone, from: "business", text: m.body, at: this.now() });
    return id;
  }
  async markMessage(id: string, update: MessageUpdate) {
    const o = this.outbound.find((x) => x.id === id);
    if (o) o.status = update.status;
  }
  get(id: string) {
    const c = this.conversations.find((x) => x.id === id);
    if (!c) throw new Error(`no conversation ${id}`);
    return c;
  }
}

const info = { model: "fake-model", promptVersion: "fake@v1", inputTokens: 10, outputTokens: 5 };

// A scripted model: queue what classify() and reply() should return or throw.
export class FakeModel implements ConversationModel {
  categories: (SafetyCategory | Error)[] = [];
  replies: (ModelReply | Error)[] = [];
  classifyCalls = 0;
  replyCalls = 0;
  lastLatest = "";

  async classify({ latest }: { latest: string }) {
    this.classifyCalls += 1;
    this.lastLatest = latest;
    const next = this.categories.shift() ?? "normal";
    if (next instanceof Error) throw next;
    return { category: next, info };
  }
  async reply() {
    this.replyCalls += 1;
    const next = this.replies.shift() ?? reply("Got it. What city is the job in?");
    if (next instanceof Error) throw next;
    return { result: next, info };
  }
}

export function reply(text: string, details: Partial<LeadDetails> = {}, needsHuman = false): ModelReply {
  return {
    reply: text,
    needsHuman,
    details: { serviceId: null, area: null, inServiceArea: null, urgency: "unknown", ...details },
  };
}

export const unavailable = (reason: ModelUnavailableError["reason"]) => new ModelUnavailableError(reason);
