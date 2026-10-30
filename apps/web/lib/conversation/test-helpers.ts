import {
  ModelUnavailableError,
  type ConversationModel,
  type LeadDetails,
  type SafetyCategory,
  type SlotChoice,
  type Turn,
  type Understanding,
} from "@sc/ai";
import type { MessageUpdate } from "../missed-call/types";
import type { BookingState, Conversation, ConversationStore, ThreadMessage, TurnRecord } from "./types";

interface Row extends Conversation {
  tenantId: string;
  phone: string;
  leaseToken: string | null;
  reason?: string;
}

// In-memory store with the same rules as the conversations tables and their
// functions: one active conversation per phone, one lease holder (released only
// with its token), one turn per inbound message, one outbound message per key,
// and failed sends drop out of the thread.
export class FakeConversationStore implements ConversationStore {
  conversations: Row[] = [];
  customer: { tenantId: string; phone: string; text: string; sid: string; keyword: boolean; at: Date }[] = [];
  seeded: { tenantId: string; phone: string; text: string; at: Date }[] = [];
  turns: TurnRecord[] = [];
  outbound: { id: string; key: string; tenantId: string; to: string; body: string; status: string; at: Date }[] = [];
  optedOut = new Set<string>();
  ownedNumbers = new Map<string, string>();
  leads = new Map<string, LeadDetails>();
  failReleaseOnce = false;
  failOn = new Set<string>();
  clock = Date.parse("2026-10-30T18:00:00Z");
  private tokens = 0;

  now() {
    this.clock += 1000;
    return new Date(this.clock);
  }
  private trip(name: string) {
    if (this.failOn.has(name)) throw new Error(`${name} unavailable`);
  }

  customerSays(tenantId: string, phone: string, text: string, sid: string, keyword = false) {
    this.customer.push({ tenantId, phone, text, sid, keyword, at: this.now() });
  }
  businessSaid(tenantId: string, phone: string, text: string) {
    this.seeded.push({ tenantId, phone, text, at: this.now() });
  }

  async startConversation(tenantId: string, phone: string, leadId: string | null) {
    this.trip("startConversation");
    const existing = this.conversations.filter((c) => c.tenantId === tenantId && c.phone === phone).at(-1);
    if (existing) return structuredClone(existing);
    const c: Row = {
      id: `conv-${this.conversations.length + 1}`,
      status: "active",
      aiReplies: 0,
      leadId,
      createdAt: this.now(),
      details: { serviceId: null, area: null, urgency: "unknown" },
      booking: { stage: "qualifying", offeredSlots: [], chosenSlot: null, offerRounds: 0, bookedEventId: null },
      tenantId,
      phone,
      leaseToken: null,
    };
    this.conversations.push(c);
    return structuredClone(c);
  }
  async acquireLease(id: string) {
    const c = this.get(id);
    if (c.leaseToken) return null;
    c.leaseToken = `token-${++this.tokens}`;
    return c.leaseToken;
  }
  async releaseLease(id: string, token: string) {
    if (this.failReleaseOnce) {
      this.failReleaseOnce = false;
      throw new Error("release timeout");
    }
    const c = this.get(id);
    if (c.leaseToken === token) c.leaseToken = null;
  }
  // Lets a test play "the lease expired".
  expireLease(id: string) {
    this.get(id).leaseToken = null;
  }
  async loadThread(tenantId: string, phone: string): Promise<ThreadMessage[]> {
    const handled = new Set(this.turns.filter((t) => t.tenantId === tenantId).map((t) => t.inboundMessageSid));
    const messages: ThreadMessage[] = [
      ...this.customer
        .filter((m) => m.tenantId === tenantId && m.phone === phone)
        .map((m) => ({ from: "customer" as const, text: m.text, at: m.at, messageSid: m.sid, keyword: m.keyword, handled: handled.has(m.sid) })),
      ...this.seeded.filter((m) => m.tenantId === tenantId && m.phone === phone).map((m) => ({ from: "business" as const, text: m.text, at: m.at })),
      ...this.outbound
        .filter((o) => o.tenantId === tenantId && o.to === phone && o.status !== "failed")
        .map((o) => ({ from: "business" as const, text: o.body, at: o.at })),
    ];
    return messages.sort((a, b) => a.at.getTime() - b.at.getTime());
  }
  async recordTurns(turns: TurnRecord[]) {
    for (const t of turns) {
      if (!this.turns.some((x) => x.conversationId === t.conversationId && x.inboundMessageSid === t.inboundMessageSid)) {
        this.turns.push(t);
      }
    }
  }
  async setStatus(id: string, status: Conversation["status"], reason?: string) {
    Object.assign(this.get(id), { status, reason });
  }
  async setDetails(id: string, details: LeadDetails) {
    this.get(id).details = { ...details };
  }
  addresses = new Map<string, string>();
  async setBooking(id: string, b: Partial<BookingState>) {
    const c = this.get(id);
    c.booking = { ...c.booking, ...b };
  }
  async updateLeadAddress(_tenantId: string, leadId: string, address: string) {
    this.addresses.set(leadId, address);
  }
  async incrementAiReplies(id: string) {
    this.get(id).aiReplies += 1;
  }
  async updateLeadDetails(_tenantId: string, leadId: string, d: LeadDetails) {
    const prev = this.leads.get(leadId) ?? { serviceId: null, area: null, urgency: "unknown" as const };
    this.leads.set(leadId, {
      serviceId: d.serviceId ?? prev.serviceId,
      area: d.area ?? prev.area,
      urgency: d.urgency !== "unknown" ? d.urgency : prev.urgency,
    });
  }
  async isOptedOut(tenantId: string, phone: string) {
    return this.optedOut.has(`${tenantId}:${phone}`);
  }
  async addOptOut(tenantId: string, phone: string) {
    this.optedOut.add(`${tenantId}:${phone}`);
  }
  async tenantOwnsNumber(tenantId: string, phone: string) {
    return this.ownedNumbers.get(phone) === tenantId;
  }
  async claimOutbound(m: { tenantId: string; idempotencyKey: string; toPhone: string; body: string }) {
    const key = `${m.tenantId}:${m.idempotencyKey}`;
    if (this.outbound.some((o) => o.key === key)) return null;
    const id = `out-${this.outbound.length + 1}`;
    this.outbound.push({ id, key, tenantId: m.tenantId, to: m.toPhone, body: m.body, status: "pending", at: this.now() });
    return id;
  }
  async markMessage(id: string, update: MessageUpdate) {
    const o = this.outbound.find((x) => x.id === id);
    if (o) o.status = update.status;
  }
  async findUnhandled() {
    const handled = new Set(this.turns.map((t) => t.inboundMessageSid));
    return this.customer
      .filter((m) => !m.keyword && m.text.trim() && !handled.has(m.sid))
      .map((m) => ({ tenantId: m.tenantId, messageSid: m.sid, fromPhone: m.phone, body: m.text, leadId: null, createdAt: m.at }));
  }
  get(id: string) {
    const c = this.conversations.find((x) => x.id === id);
    if (!c) throw new Error(`no conversation ${id}`);
    return c;
  }
}

const info = { model: "fake-model", promptVersion: "fake@v1", inputTokens: 10, outputTokens: 5 };

export function understood(o: Partial<Omit<Understanding, "details">> & { details?: Partial<LeadDetails> } = {}): Understanding {
  return {
    faqId: null,
    askedOtherQuestion: false,
    unlistedService: false,
    needsHuman: false,
    ...o,
    details: { serviceId: null, area: null, urgency: "unknown", ...o.details },
  };
}

// A scripted model: queue what classify() and understand() return or throw.
export class FakeModel implements ConversationModel {
  categories: (SafetyCategory | Error)[] = [];
  understandings: (Understanding | Error)[] = [];
  slotChoices: (SlotChoice | Error)[] = [];
  addresses: (string | null | Error)[] = [];
  chooseSlotCalls = 0;
  extractAddressCalls = 0;
  classifyCalls = 0;
  understandCalls = 0;
  lastLatest = "";
  knownSeen: LeadDetails[] = [];
  onClassify: (() => void) | null = null;

  async classify({ latest }: { history: Turn[]; latest: string }) {
    this.classifyCalls += 1;
    this.lastLatest = latest;
    this.onClassify?.();
    const next = this.categories.shift() ?? "normal";
    if (next instanceof Error) throw next;
    return { category: next, info };
  }
  async understand({ known }: { history: Turn[]; latest: string; known: LeadDetails }) {
    this.understandCalls += 1;
    this.knownSeen.push(known);
    const next = this.understandings.shift() ?? understood();
    if (next instanceof Error) throw next;
    return { result: next, info };
  }
  async chooseSlot() {
    this.chooseSlotCalls += 1;
    const next = this.slotChoices.shift() ?? { choice: null, wantsOtherTime: false };
    if (next instanceof Error) throw next;
    return { result: next, info };
  }
  async extractAddress() {
    this.extractAddressCalls += 1;
    const next = this.addresses.length ? this.addresses.shift() : null;
    if (next instanceof Error) throw next;
    return { address: next ?? null, info };
  }
}

export const unavailable = (reason: ModelUnavailableError["reason"]) => new ModelUnavailableError(reason);

// A fake Google Calendar: busy blocks you set, events it records, and
// failures you can switch on.
export class FakeCalendar {
  busyBlocks: { start: Date; end: Date }[] = [];
  events: { id: string; start: Date; summary: string; location: string; description: string }[] = [];
  fail: Error | null = null;
  busyCalls = 0;
  // Called on each busy() so a test can book a slot "meanwhile".
  onBusy: ((call: number) => void) | null = null;

  async busy(from: Date, to: Date) {
    this.busyCalls += 1;
    this.onBusy?.(this.busyCalls);
    if (this.fail) throw this.fail;
    return this.busyBlocks.filter((b) => b.start < to && from < b.end);
  }
  async createEvent(e: { id: string; start: Date; summary: string; location: string; description: string }) {
    if (this.fail) throw this.fail;
    if (this.events.some((x) => x.id === e.id)) return "exists" as const;
    this.events.push(e);
    return "created" as const;
  }
}
