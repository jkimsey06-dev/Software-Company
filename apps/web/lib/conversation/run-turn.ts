import {
  CONVERSATION_TEMPLATES_V1,
  ModelUnavailableError,
  asksIfAi,
  inServiceArea,
  looksLikeEmergency,
  renderFixedMessageV1,
  type FixedMessage,
  type LeadDetails,
  type ModelCallInfo,
  type Question,
  type Turn,
} from "@sc/ai";
import { canSendTexts, type TenantConfig } from "@sc/shared";
import { SmsSendError, errorLabel } from "../missed-call/types";
import { sendNotification } from "../notifications/dispatch";
import {
  renderConversationUpdateEmail,
  renderOwnerEmergencySms,
  type ConversationOutcome,
} from "../notifications/templates";
import { planAddressAndBook, planChoice, planOffer, planResumeBooking, type BookingPlan } from "./booking";
import type {
  Conversation,
  ConversationDeps,
  CustomerMessage,
  ThreadMessage,
  TurnAction,
  TurnRecord,
} from "./types";

// Questions we send per conversation before a person takes over.
export const MAX_AI_REPLIES = 6;
const HISTORY_LIMIT = 20;
// Passes per lease: messages that arrive while we work are answered too.
const MAX_PASSES = 3;
const DEFAULT_LEASE_WAIT_MS = 20_000;
const NANP = /^\+1[2-9]\d{9}$/;
const TWILIO_UNSUBSCRIBED = "21610";
const DISCLOSURE_START = "Yes, I'm an AI assistant";
const ADDRESS_AGAIN_START = "Sorry, I didn't catch that. What's the street address";
const ADDRESS_ASK = /^Great, .+ it is\. What's the street address/;

type Outcome =
  | { action: "ask"; message: FixedMessage; details: LeadDetails; info?: ModelCallInfo; category?: string }
  | {
      action: "complete" | "out_of_area" | "unlisted_service" | "handoff" | "fallback" | "turn_limit";
      reason: string;
      details?: LeadDetails;
      info?: ModelCallInfo;
      category?: string;
    }
  | { action: "skipped"; reason: string; category: string; info?: ModelCallInfo }
  | { action: "emergency"; category: string }
  | { action: "booking"; plan: BookingPlan; details?: LeadDetails; info?: ModelCallInfo; category?: string };

// Called after the SMS webhook has answered Twilio. Returns true when this
// message was handled (answered, or the owner was told); false means the
// caller must forward it to the owner.
export async function handleCustomerMessage(msg: CustomerMessage, deps: ConversationDeps): Promise<boolean> {
  const { store, log } = deps;
  const { tenantId, config, customerPhone: phone } = msg;

  // Emergencies first, in every state: no model, no eligibility rules, even
  // after a handoff. Texts only go where texting is allowed.
  if (looksLikeEmergency(msg.body)) {
    const conversation = await store.startConversation(tenantId, phone, msg.leadId);
    await handleEmergency(msg, conversation, [msg.messageSid], "emergency_keywords", deps);
    return true;
  }

  if (!(await canTextCustomer(msg, deps))) return false;
  const model = deps.modelFor(config);
  if (!model) return false;

  const conversation = await store.startConversation(tenantId, phone, msg.leadId);
  if (conversation.status !== "active") {
    log("conversation.not_active", { tenantId, conversationId: conversation.id, status: conversation.status });
    return false;
  }

  let processed = false;
  for (let round = 0; round < 2; round++) {
    const token = await acquireWithWait(conversation.id, round === 0 ? (deps.leaseWaitMs ?? DEFAULT_LEASE_WAIT_MS) : 0, deps);
    // Still busy after waiting: hand this message to the owner rather than
    // risk it going unanswered. (The holder may also answer it.)
    if (!token) return processed;
    try {
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        processed = true;
        if (await takeTurn(msg, conversation.id, deps)) break;
      }
    } finally {
      await releaseWithRetry(conversation.id, token, deps);
    }
    // A message that landed after our last pass but before the release.
    if (pendingFrom(await store.loadThread(tenantId, phone, since(conversation))).pending.length === 0) break;
  }
  return true;
}

async function canTextCustomer(msg: CustomerMessage, deps: ConversationDeps): Promise<boolean> {
  const { config, customerPhone: phone, tenantId } = msg;
  if (!canSendTexts(config)) return false;
  const sendFrom = config.messaging.fromNumber as string;
  if (!NANP.test(phone)) return false;
  if ([msg.businessNumber, sendFrom, config.calls.forwardToNumber].includes(phone)) return false;
  if (!(await deps.store.tenantOwnsNumber(tenantId, sendFrom))) return false;
  return !(await deps.store.isOptedOut(tenantId, phone));
}

async function acquireWithWait(id: string, waitMs: number, deps: ConversationDeps): Promise<string | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const token = await deps.store.acquireLease(id);
    if (token || Date.now() >= deadline) return token;
    await new Promise((r) => setTimeout(r, Math.min(2_000, Math.max(0, deadline - Date.now()))));
  }
}

async function releaseWithRetry(id: string, token: string, deps: ConversationDeps): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try {
      await deps.store.releaseLease(id, token);
      return;
    } catch (err) {
      deps.log("conversation.release_failed", { conversationId: id, attempt: i + 1, error: errorLabel(err) });
    }
  }
  // The lease expires on its own; a waiting message goes to the owner meanwhile.
}

function since(conversation: Conversation): Date {
  // Include the missed-call text-back that started the thread.
  return new Date(conversation.createdAt.getTime() - 24 * 3_600_000);
}

// Customer texts with no recorded decision yet. Keywords and photo-only
// messages never belong to the AI conversation.
function pendingFrom(thread: ThreadMessage[]) {
  const pending = thread.filter((m) => m.from === "customer" && !m.handled && !m.keyword && m.text.trim() && m.messageSid);
  const history: Turn[] = thread
    .filter((m) => !pending.includes(m))
    .slice(-HISTORY_LIMIT)
    .map((m) => ({ from: m.from, text: m.text }));
  return { pending, history };
}

function nextQuestion(config: TenantConfig, d: LeadDetails): Question | null {
  if (!d.serviceId) return "service";
  if (!d.area || inServiceArea(config, d.area) === null) return "area";
  if (d.urgency === "unknown") return "urgency";
  return null;
}

async function decide(
  msg: CustomerMessage,
  askedAddressAgain: boolean,
  latest: string,
  history: Turn[],
  conversation: Conversation,
  config: TenantConfig,
  model: NonNullable<ReturnType<ConversationDeps["modelFor"]>>,
  disclosedAlready: boolean,
  deps: ConversationDeps,
  ctx: Record<string, string>,
): Promise<Outcome> {
  const unavailable = (step: string, err: unknown): Outcome => {
    const reason = err instanceof ModelUnavailableError ? err.reason : "api_error";
    deps.log("conversation.model_unavailable", { ...ctx, step, reason });
    return { action: "fallback", reason: `${step}_${reason}` };
  };

  // Safety comes before any fixed reply, including "are you a bot?".
  let category: string;
  try {
    ({ category } = await model.classify({ history, latest }));
  } catch (err) {
    return unavailable("classifier", err);
  }
  if (category === "emergency") return { action: "emergency", category };
  if (category === "upset" || category === "wants_human") return { action: "handoff", reason: category, category };
  if (category === "wrong_number" || category === "spam") return { action: "skipped", reason: category, category };
  if (conversation.aiReplies >= MAX_AI_REPLIES) return { action: "turn_limit", reason: "turn_limit", category };

  // Booking stages: the customer is picking a time or giving the address.
  const stage = conversation.booking.stage;
  if (stage !== "qualifying") {
    try {
      const plan =
        stage === "choosing_time"
          ? await planChoice(msg, conversation, latest, model, deps)
          : stage === "asking_address"
            ? await planAddressAndBook(msg, conversation, latest, askedAddressAgain, model, deps)
            : await planResumeBooking(msg, conversation, deps);
      return { action: "booking", plan, info: plan.info, category };
    } catch (err) {
      return { ...unavailable("booking", err), category } as Outcome;
    }
  }

  let understood;
  try {
    understood = await model.understand({ history, latest, known: conversation.details });
  } catch (err) {
    return { ...unavailable("reply", err), category } as Outcome;
  }
  const { result: u, info } = understood;
  const known = conversation.details;
  const details: LeadDetails = {
    serviceId: u.details.serviceId ?? known.serviceId,
    area: u.details.area ?? known.area,
    urgency: u.details.urgency !== "unknown" ? u.details.urgency : known.urgency,
  };

  if (u.needsHuman) return { action: "handoff", reason: "needs_human", details, info, category };
  if (u.unlistedService) return { action: "unlisted_service", reason: "unlisted_service", details, info, category };
  if (details.area && inServiceArea(config, details.area) === false) {
    return { action: "out_of_area", reason: "out_of_area", details, info, category };
  }

  const question = nextQuestion(config, details);
  if (!question) {
    // All details known: offer times from the owner's calendar when we can.
    const plan = await planOffer(msg, { ...conversation, details }, deps);
    return { action: "booking", plan, details, info, category };
  }
  const prefix =
    asksIfAi(latest) && !disclosedAlready
      ? ("ai_disclosure" as const)
      : u.faqId
        ? { faqId: u.faqId }
        : u.askedOtherQuestion
          ? ("other_question" as const)
          : undefined;
  return { action: "ask", message: { kind: "ask", question, prefix }, details, info, category };
}

// One decision and at most one text for everything the customer sent since
// our last decision. Returns true when there's nothing more to do.
async function takeTurn(msg: CustomerMessage, conversationId: string, deps: ConversationDeps): Promise<boolean> {
  const { store, log } = deps;
  const { tenantId, config, customerPhone: phone } = msg;

  const conversation = await store.startConversation(tenantId, phone, msg.leadId);
  if (conversation.id !== conversationId || conversation.status !== "active") return true;

  const thread = await store.loadThread(tenantId, phone, since(conversation));
  const { pending, history } = pendingFrom(thread);
  const newest = pending.at(-1);
  if (!newest?.messageSid) return true;
  const sids = pending.map((m) => m.messageSid as string);
  const latest = pending.map((m) => m.text).join("\n");
  const ctx = { tenantId, conversationId, messageSid: newest.messageSid };

  // An emergency can arrive while we work on another message.
  if (looksLikeEmergency(latest)) {
    await handleEmergency(msg, conversation, sids, "emergency_keywords", deps);
    return true;
  }

  const model = deps.modelFor(config);
  if (!model) return true;
  const disclosed = thread.some((m) => m.from === "business" && m.text.startsWith(DISCLOSURE_START));
  // "Didn't catch that" since the latest address question (each pick gets one retry).
  let askedAgain = false;
  for (const m of thread) {
    if (m.from !== "business") continue;
    if (ADDRESS_ASK.test(m.text)) askedAgain = false;
    else if (m.text.startsWith(ADDRESS_AGAIN_START)) askedAgain = true;
  }
  const outcome = await decide(msg, askedAgain, latest, history, conversation, config, model, disclosed, deps, ctx);
  const info = "info" in outcome ? outcome.info : undefined;
  const turns = (action: TurnAction, reason?: string, outboundMessageId?: string | null): TurnRecord[] =>
    sids.map((sid) => ({
      tenantId,
      conversationId,
      inboundMessageSid: sid,
      action: sid === newest.messageSid ? action : "merged",
      reason,
      safetyCategory: outcome.category,
      model: info?.model,
      promptVersion: info?.promptVersion,
      inputTokens: info?.inputTokens,
      outputTokens: info?.outputTokens,
      outboundMessageId: sid === newest.messageSid ? outboundMessageId : null,
    }));

  if (outcome.action === "emergency") {
    await handleEmergency(msg, conversation, sids, outcome.category, deps);
    return true;
  }

  const details = "details" in outcome ? outcome.details : undefined;
  if (details) {
    await store.setDetails(conversationId, details);
    if (msg.leadId) {
      await store.updateLeadDetails(tenantId, msg.leadId, details).catch((err) =>
        log("conversation.lead_update_failed", { ...ctx, error: errorLabel(err) }),
      );
    }
  }

  const message: FixedMessage | null =
    outcome.action === "ask"
      ? outcome.message
      : outcome.action === "booking"
        ? outcome.plan.message
        : outcome.action === "skipped"
        ? null
        : { kind: outcome.action === "complete" ? "complete" : outcome.action === "turn_limit" ? "turn_limit" : outcome.action === "out_of_area" ? "out_of_area" : outcome.action === "unlisted_service" ? "unlisted_service" : outcome.action === "handoff" ? "handoff" : "fallback" };

  // The event is on their calendar: if we can't confirm it, the owner must know.
  const onCalendar = outcome.action === "booking" ? outcome.plan.onCalendar : undefined;
  let outboundId: string | null = null;
  if (message) {
    // Last checks before texting: they may have just replied STOP, or an
    // emergency may have handed the conversation off.
    if (await store.isOptedOut(tenantId, phone)) {
      await finish(msg, conversation, "handed_off", "opted_out", details, deps, undefined, onCalendar);
      await store.recordTurns(turns("opted_out", "opted_out"));
      return true;
    }
    const now = await store.startConversation(tenantId, phone, msg.leadId);
    if (now.id !== conversationId || now.status !== "active") {
      // Handed off meanwhile (an emergency): still tell the owner about the event.
      if (onCalendar) await emailOwner(msg, conversation, "needs_you", "booked_unconfirmed", details ?? conversation.details, `conversation-update:${conversation.id}:booked_unconfirmed`, deps, onCalendar);
      return true;
    }

    const sent = await sendText(msg, `conversation-reply:${newest.messageSid}`, phone, renderFixedMessageV1(message, config), deps);
    outboundId = sent.id;
    if (!sent.delivered) {
      await finish(msg, conversation, "handed_off", "send_failed", details, deps, undefined, onCalendar);
      await store.recordTurns(turns("send_failed", sent.code, outboundId));
      return true;
    }
  }

  if (outcome.action === "booking") {
    const { plan } = outcome;
    await plan.apply?.();
    if (plan.terminal) {
      const t = plan.terminal;
      await finish(msg, conversation, t.status, t.reason, details ?? conversation.details, deps, t.outcome, t.booking);
      await store.recordTurns(turns(plan.action, plan.reason, outboundId));
    } else {
      await store.recordTurns(turns(plan.action, plan.reason, outboundId));
      await store.incrementAiReplies(conversationId);
    }
    log("conversation.turn", { ...ctx, action: plan.action, category: outcome.category ?? "none", merged: sids.length - 1 });
    return Boolean(plan.terminal);
  }

  if (outcome.action === "ask") {
    await store.recordTurns(turns("ask", undefined, outboundId));
    await store.incrementAiReplies(conversationId);
    log("conversation.turn", { ...ctx, action: "ask", category: outcome.category ?? "none", merged: sids.length - 1 });
    return false; // look for messages that arrived meanwhile
  }
  // The owner email is queued before the turn is recorded: if it can't be,
  // the message stays unhandled and is forwarded instead (never lost).
  await finish(msg, conversation, outcome.action === "complete" ? "completed" : "handed_off", outcome.reason, details, deps);
  await store.recordTurns(turns(outcome.action, outcome.reason, outboundId));
  log("conversation.turn", { ...ctx, action: outcome.action, category: outcome.category ?? "none", merged: sids.length - 1 });
  return true;
}

async function finish(
  msg: CustomerMessage,
  conversation: Conversation,
  status: "completed" | "handed_off",
  reason: string,
  details: LeadDetails | undefined,
  deps: ConversationDeps,
  outcome: ConversationOutcome = status === "completed" ? "complete" : "needs_you",
  booking?: { slot: string; address: string },
): Promise<void> {
  await deps.store.setStatus(conversation.id, status, reason);
  await emailOwner(msg, conversation, outcome, reason, details, `conversation-update:${conversation.id}:${outcome}`, deps, booking);
}

// Claim, send, record: the same never-twice pattern as the text-back.
async function sendText(
  msg: CustomerMessage,
  key: string,
  to: string,
  body: string,
  deps: ConversationDeps,
): Promise<{ id: string | null; delivered: boolean; code?: string }> {
  const { store, log, sender } = deps;
  const { tenantId, config } = msg;
  const from = config.messaging.fromNumber as string;
  const id = await store.claimOutbound({
    tenantId,
    idempotencyKey: key,
    leadId: msg.leadId,
    toPhone: to,
    fromPhone: from,
    body,
    templateVersion: CONVERSATION_TEMPLATES_V1,
  });
  // Already sent by an earlier attempt: don't send again, don't fail the turn.
  if (!id) return { id: null, delivered: true };
  try {
    const { sid } = await sender.send({ from, to, body });
    await store.markMessage(id, { status: "sent", providerSid: sid }).catch((err) =>
      log("conversation.mark_sent_failed", { tenantId, messageId: id, providerSid: sid, error: errorLabel(err) }),
    );
    return { id, delivered: true };
  } catch (err) {
    const e = err instanceof SmsSendError ? err : new SmsSendError("unknown", "unexpected", "send failed");
    log("conversation.send_failed", { tenantId, messageId: id, kind: e.kind, code: e.code });
    if (e.code === TWILIO_UNSUBSCRIBED) await store.addOptOut(tenantId, to).catch(() => undefined);
    await store.markMessage(id, { status: e.kind === "rejected" ? "failed" : "unknown", errorCode: e.code }).catch(() => undefined);
    return { id, delivered: false, code: e.code };
  }
}

async function handleEmergency(
  msg: CustomerMessage,
  conversation: Conversation,
  sids: string[],
  category: string,
  deps: ConversationDeps,
): Promise<void> {
  const { store, log, notifications } = deps;
  const { tenantId, config } = msg;
  const sid = sids.at(-1) as string;
  const textingOk = canSendTexts(config) && (await store.tenantOwnsNumber(tenantId, config.messaging.fromNumber as string));

  // 911 text to the customer, wherever texting them is allowed.
  let outboundId: string | null = null;
  if (await canTextCustomer(msg, deps)) {
    // Once per conversation: a second "gas!!" text doesn't send a second copy.
    const sent = await sendText(msg, `emergency-reply:${conversation.id}`, msg.customerPhone, renderFixedMessageV1({ kind: "emergency" }, config), deps);
    outboundId = sent.id;
  }

  // Owner's phone, from the tenant's number. No customer words in it.
  const ownerPhone = config.escalationContact.phone;
  if (textingOk && !(await store.isOptedOut(tenantId, ownerPhone))) {
    const sent = await sendText(
      msg,
      `emergency-alert:${conversation.id}`,
      ownerPhone,
      renderOwnerEmergencySms(config, { callerPhone: msg.customerPhone }),
      deps,
    );
    if (!sent.delivered) {
      await notifications?.opsAlert("conversation.owner_alert_failed", { tenantId, messageSid: sid });
    }
  }

  if (conversation.status !== "handed_off") await store.setStatus(conversation.id, "handed_off", "emergency");
  // Every emergency text reaches the owner's inbox; queued before the turn is
  // recorded so a failure leaves the message to be forwarded.
  await emailOwner(msg, conversation, "emergency", category, conversation.details, `emergency:${sid}`, deps);
  await store.recordTurns(
    sids.map((s) => ({
      tenantId,
      conversationId: conversation.id,
      inboundMessageSid: s,
      action: s === sid ? ("emergency" as const) : ("merged" as const),
      reason: "emergency",
      safetyCategory: category,
      outboundMessageId: s === sid ? outboundId : null,
    })),
  );
  log("conversation.emergency", { tenantId, conversationId: conversation.id, messageSid: sid, category });
}

async function emailOwner(
  msg: CustomerMessage,
  conversation: Conversation,
  outcome: ConversationOutcome,
  reason: string,
  details: LeadDetails | undefined,
  key: string,
  deps: ConversationDeps,
  booking?: { slot: string; address: string },
): Promise<void> {
  const { store, log, notifications } = deps;
  const { tenantId, config } = msg;
  const to = config.escalationContact.email;
  if (!notifications || !to) return;
  try {
    const thread = await store.loadThread(tenantId, msg.customerPhone, since(conversation));
    const email = renderConversationUpdateEmail(config, {
      callerPhone: msg.customerPhone,
      outcome,
      reason,
      details,
      booking,
      thread: thread.slice(-12),
    });
    const id = await notifications.store.enqueue({
      tenantId,
      kind: outcome === "emergency" ? "emergency" : outcome === "booked" ? "estimate_booked" : "conversation_update",
      idempotencyKey: key,
      leadId: msg.leadId,
      recipientEmail: to,
      subject: email.subject,
      body: email.body,
    });
    if (id) await sendNotification(id, notifications);
  } catch (err) {
    log("conversation.notify_failed", { tenantId, conversationId: conversation.id, error: errorLabel(err) });
    await notifications.opsAlert("conversation.notify_failed", { tenantId, conversationId: conversation.id });
    // Not swallowed: the message stays unhandled and is forwarded to the owner.
    throw err;
  }
}

export const _test = { pendingFrom, nextQuestion };
