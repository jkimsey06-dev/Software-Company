import {
  CONVERSATION_TEMPLATES_V1,
  ModelUnavailableError,
  asksIfAi,
  checkReply,
  looksLikeEmergency,
  renderFixedMessageV1,
  type FixedMessage,
  type LeadDetails,
  type ModelCallInfo,
  type Turn,
} from "@sc/ai";
import { canSendTexts } from "@sc/shared";
import { SmsSendError, errorLabel } from "../missed-call/types";
import { sendNotification } from "../notifications/dispatch";
import { renderConversationUpdateEmail, renderOwnerEmergencySms, type ConversationOutcome } from "../notifications/templates";
import type { Conversation, ConversationDeps, CustomerMessage, ThreadMessage, TurnAction } from "./types";

// Model-written replies per conversation before a person takes over.
export const MAX_AI_REPLIES = 6;
// History the model sees.
const HISTORY_LIMIT = 20;
// Passes per lease: a message that arrives while we work is answered too.
const MAX_PASSES = 3;
const NANP = /^\+1[2-9]\d{9}$/;
const TWILIO_UNSUBSCRIBED = "21610";

type Decision =
  | { action: "ai_reply"; text: string; details: LeadDetails; info: ModelCallInfo; category: string }
  | { action: "complete"; details: LeadDetails; info: ModelCallInfo; category: string }
  | { action: "emergency" | "ai_disclosure" | "turn_limit"; category?: string }
  | { action: "handoff"; reason: string; category?: string; details?: LeadDetails; info?: ModelCallInfo }
  | { action: "fallback"; reason: string; category?: string; violations?: string[]; info?: ModelCallInfo }
  | { action: "skipped"; reason: string; category: string; info?: ModelCallInfo };

const FIXED: Partial<Record<TurnAction, FixedMessage>> = {
  emergency: "emergency",
  handoff: "handoff",
  fallback: "fallback",
  complete: "complete",
  ai_disclosure: "ai_disclosure",
  turn_limit: "turn_limit",
};

// Called after the SMS webhook has answered Twilio. Returns false when the AI
// won't handle this message, so the caller forwards it to the owner instead.
export async function handleCustomerMessage(msg: CustomerMessage, deps: ConversationDeps): Promise<boolean> {
  const { store, log } = deps;
  const { tenantId, config, customerPhone: phone } = msg;
  const ctx = { tenantId, messageSid: msg.messageSid };

  // Same gates as the text-back: approved texting, a US/Canada number that
  // isn't the business, the tenant's own sending number, and no opt-out.
  if (!canSendTexts(config)) return false;
  const sendFrom = config.messaging.fromNumber as string;
  if (!NANP.test(phone)) return false;
  if ([msg.businessNumber, sendFrom, config.calls.forwardToNumber].includes(phone)) return false;
  if (!(await store.tenantOwnsNumber(tenantId, sendFrom))) return false;
  if (await store.isOptedOut(tenantId, phone)) return false;

  const conversation = await store.startConversation(tenantId, phone, msg.leadId);
  if (conversation.status !== "active") {
    log("conversation.not_active", { ...ctx, conversationId: conversation.id, status: conversation.status });
    return false;
  }

  for (let lease = 0; lease < 2; lease++) {
    // Someone else is working this conversation; they re-check for new
    // messages after releasing, so this one will be answered.
    if (!(await store.acquireLease(conversation.id))) return true;
    try {
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        const done = await takeTurn(msg, conversation, sendFrom, deps);
        if (done) break;
      }
    } finally {
      await store.releaseLease(conversation.id).catch((err) =>
        log("conversation.release_failed", { ...ctx, error: errorLabel(err) }),
      );
    }
    // A message that landed between our last check and the release.
    const thread = await store.loadThread(tenantId, phone, since(conversation));
    if (pendingFrom(thread).pending.length === 0) break;
  }
  return true;
}

function since(conversation: Conversation): Date {
  // Include the missed-call text-back that started the thread.
  return new Date(conversation.createdAt.getTime() - 24 * 3_600_000);
}

function pendingFrom(thread: ThreadMessage[]) {
  let lastBusiness = -1;
  thread.forEach((m, i) => {
    if (m.from === "business") lastBusiness = i;
  });
  const pending = thread.slice(lastBusiness + 1).filter((m) => m.from === "customer");
  const history: Turn[] = thread
    .slice(Math.max(0, lastBusiness + 1 - HISTORY_LIMIT), lastBusiness + 1)
    .map((m) => ({ from: m.from, text: m.text }));
  return { pending, history };
}

// One decision and one reply for everything the customer sent since our last
// text. Returns true when there's nothing more to do.
async function takeTurn(
  msg: CustomerMessage,
  conversation: Conversation,
  sendFrom: string,
  deps: ConversationDeps,
): Promise<boolean> {
  const { store, log } = deps;
  const { tenantId, config, customerPhone: phone } = msg;

  const current = await store.startConversation(tenantId, phone, msg.leadId);
  if (current.id !== conversation.id || current.status !== "active") return true;

  const thread = await store.loadThread(tenantId, phone, since(conversation));
  const { pending, history } = pendingFrom(thread);
  const newest = pending.at(-1);
  if (!newest?.messageSid) return true;
  const sid = newest.messageSid;
  const latest = pending.map((m) => m.text).join("\n");
  const ctx = { tenantId, conversationId: conversation.id, messageSid: sid };

  const decision = await decide(latest, history, current, deps.modelFor(config), log, ctx);

  // Last check before texting: they may have just replied STOP.
  let outboundId: string | null = null;
  const fixed = FIXED[decision.action];
  const text = decision.action === "ai_reply" ? decision.text : fixed ? renderFixedMessageV1(fixed, config) : null;
  if (text && !(await store.isOptedOut(tenantId, phone))) {
    const version =
      decision.action === "ai_reply" ? `${decision.info.promptVersion}/${decision.info.model}` : CONVERSATION_TEMPLATES_V1;
    outboundId = await sendText(msg, sendFrom, sid, text, version, deps);
  }

  const info = "info" in decision ? decision.info : undefined;
  await store.recordTurn({
    tenantId,
    conversationId: conversation.id,
    inboundMessageSid: sid,
    action: decision.action,
    safetyCategory: decision.category,
    model: info?.model,
    promptVersion: info?.promptVersion,
    guardViolations: decision.action === "fallback" ? decision.violations : undefined,
    inputTokens: info?.inputTokens,
    outputTokens: info?.outputTokens,
    outboundMessageId: outboundId,
  });
  log("conversation.turn", { ...ctx, action: decision.action, category: decision.category ?? "none" });

  const details = "details" in decision ? decision.details : undefined;
  if (details && msg.leadId) {
    await store.updateLeadDetails(tenantId, msg.leadId, details).catch((err) =>
      log("conversation.lead_update_failed", { ...ctx, error: errorLabel(err) }),
    );
  }

  if (decision.action === "ai_reply") {
    await store.incrementAiReplies(conversation.id);
    return false; // check for messages that arrived meanwhile
  }
  if (decision.action === "ai_disclosure") return false;

  const reason = "reason" in decision ? decision.reason : decision.action;
  await store.setStatus(conversation.id, decision.action === "complete" ? "completed" : "handed_off", reason);
  await notifyOwner(msg, conversation, decision.action, reason, details, sid, sendFrom, deps);
  return true;
}

async function decide(
  latest: string,
  history: Turn[],
  conversation: Conversation,
  model: ReturnType<ConversationDeps["modelFor"]>,
  log: ConversationDeps["log"],
  ctx: Record<string, string>,
): Promise<Decision> {
  // Emergencies never wait on a model.
  if (looksLikeEmergency(latest)) return { action: "emergency", category: "emergency_keywords" };
  if (asksIfAi(latest)) return { action: "ai_disclosure" };
  if (conversation.aiReplies >= MAX_AI_REPLIES) return { action: "turn_limit" };

  let category: string;
  try {
    ({ category } = await model.classify({ history, latest }));
  } catch (err) {
    const reason = err instanceof ModelUnavailableError ? err.reason : "api_error";
    log("conversation.model_unavailable", { ...ctx, step: "classify", reason });
    return { action: "fallback", reason: `classifier_${reason}` };
  }
  if (category === "emergency") return { action: "emergency", category };
  if (category === "upset" || category === "wants_human") return { action: "handoff", reason: category, category };
  if (category === "wrong_number" || category === "spam") return { action: "skipped", reason: category, category };

  let reply;
  try {
    reply = await model.reply({
      history,
      latest,
      known: { serviceId: null, area: null, inServiceArea: null, urgency: "unknown" },
    });
  } catch (err) {
    const reason = err instanceof ModelUnavailableError ? err.reason : "api_error";
    log("conversation.model_unavailable", { ...ctx, step: "reply", reason });
    return { action: "fallback", reason: `reply_${reason}`, category };
  }
  const { result, info } = reply;
  if (result.needsHuman) return { action: "handoff", reason: "needs_human", category, details: result.details, info };

  const d = result.details;
  if (d.serviceId && d.area && d.urgency !== "unknown") {
    return { action: "complete", details: d, info, category };
  }

  const guard = checkReply(result.reply);
  if (!guard.ok) {
    log("conversation.reply_blocked", { ...ctx, violations: guard.violations.join(",") });
    return { action: "fallback", reason: "reply_blocked", category, violations: guard.violations, info };
  }
  return { action: "ai_reply", text: result.reply.trim(), details: d, info, category };
}

// Claim, send, record: the same never-twice pattern as the text-back.
async function sendText(
  msg: CustomerMessage,
  sendFrom: string,
  sid: string,
  body: string,
  templateVersion: string,
  deps: ConversationDeps,
): Promise<string | null> {
  const { store, log } = deps;
  const ctx = { tenantId: msg.tenantId, messageSid: sid };
  const id = await store.claimOutbound({
    tenantId: msg.tenantId,
    idempotencyKey: `conversation-reply:${sid}`,
    leadId: msg.leadId,
    toPhone: msg.customerPhone,
    fromPhone: sendFrom,
    body,
    templateVersion,
  });
  if (!id) return null;
  try {
    const { sid: providerSid } = await deps.sender.send({ from: sendFrom, to: msg.customerPhone, body });
    await store.markMessage(id, { status: "sent", providerSid }).catch((err) =>
      log("conversation.mark_sent_failed", { ...ctx, messageId: id, providerSid, error: errorLabel(err) }),
    );
  } catch (err) {
    const e = err instanceof SmsSendError ? err : new SmsSendError("unknown", "unexpected", "send failed");
    log("conversation.send_failed", { ...ctx, messageId: id, kind: e.kind, code: e.code });
    await store
      .markMessage(id, { status: e.kind === "rejected" ? "failed" : "unknown", errorCode: e.code })
      .catch(() => undefined);
    if (e.code === TWILIO_UNSUBSCRIBED) {
      // Twilio says they've opted out; nothing more goes to them.
      return id;
    }
  }
  return id;
}

async function notifyOwner(
  msg: CustomerMessage,
  conversation: Conversation,
  action: TurnAction,
  reason: string,
  details: LeadDetails | undefined,
  sid: string,
  sendFrom: string,
  deps: ConversationDeps,
): Promise<void> {
  const { store, log, notifications } = deps;
  const { tenantId, config } = msg;
  const outcome: ConversationOutcome = action === "complete" ? "complete" : action === "emergency" ? "emergency" : "needs_you";

  // Emergencies also go to the owner's phone, from the tenant's own number.
  if (action === "emergency") {
    const thread = await store.loadThread(tenantId, msg.customerPhone, since(conversation)).catch(() => []);
    const latest = thread.filter((m) => m.from === "customer").at(-1)?.text ?? "";
    const body = renderOwnerEmergencySms(config, { callerPhone: msg.customerPhone, latest });
    const id = await store.claimOutbound({
      tenantId,
      idempotencyKey: `emergency-alert:${sid}`,
      leadId: msg.leadId,
      toPhone: config.escalationContact.phone,
      fromPhone: sendFrom,
      body,
      templateVersion: CONVERSATION_TEMPLATES_V1,
    });
    if (id) {
      try {
        const { sid: providerSid } = await deps.sender.send({ from: sendFrom, to: config.escalationContact.phone, body });
        await store.markMessage(id, { status: "sent", providerSid }).catch(() => undefined);
      } catch (err) {
        log("conversation.owner_alert_failed", { tenantId, messageSid: sid, error: errorLabel(err) });
        await store.markMessage(id, { status: "unknown", errorCode: errorLabel(err).slice(0, 64) }).catch(() => undefined);
        await notifications?.opsAlert("conversation.owner_alert_failed", { tenantId, messageSid: sid });
      }
    }
  }

  const to = config.escalationContact.email;
  if (!notifications || !to) return;
  try {
    const thread = await store.loadThread(tenantId, msg.customerPhone, since(conversation));
    const email = renderConversationUpdateEmail(config, {
      callerPhone: msg.customerPhone,
      outcome,
      reason,
      details,
      thread: thread.slice(-12),
    });
    const id = await notifications.store.enqueue({
      tenantId,
      kind: action === "emergency" ? "emergency" : "conversation_update",
      idempotencyKey: action === "emergency" ? `emergency:${sid}` : `conversation-update:${conversation.id}:${outcome}`,
      leadId: msg.leadId,
      recipientEmail: to,
      subject: email.subject,
      body: email.body,
    });
    if (id) await sendNotification(id, notifications);
  } catch (err) {
    log("conversation.notify_failed", { tenantId, conversationId: conversation.id, error: errorLabel(err) });
    await notifications.opsAlert("conversation.notify_failed", { tenantId, conversationId: conversation.id });
  }
}

export const _test = { pendingFrom };
