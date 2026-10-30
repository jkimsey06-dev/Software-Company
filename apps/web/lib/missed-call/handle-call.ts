import { canSendTexts, phoneE164, type TenantConfig } from "@sc/shared";
import { MISSED_CALL_TEXTBACK_V1, renderMissedCallTextbackV1 } from "@sc/ai";
import twilio from "twilio";
import {
  SmsSendError,
  errorLabel,
  type Logger,
  type MissedCallStore,
  type SmsSender,
} from "./types";

import type { TextbackOutcome } from "../notifications/templates";

const { VoiceResponse } = twilio.twiml;

export const DIAL_STATUS_PATH = "/api/twilio/voice/status";

// Dial outcomes that mean nobody picked up. "canceled" = caller hung up first.
const MISSED_DIAL_STATUSES = new Set(["no-answer", "busy", "failed", "canceled"]);
const ANSWERED_DIAL_STATUSES = new Set(["completed", "answered"]);

// Twilio error 21610: recipient has replied STOP to this sender.
const TWILIO_UNSUBSCRIBED = "21610";

export interface CallDeps {
  store: MissedCallStore;
  sender: SmsSender;
  publicBaseUrl: string;
  log: Logger;
  // Tells the tenant's owner about a missed-call lead. Must not throw.
  notifyOwner?: OwnerNotifier;
}

export type OwnerNotifier = (lead: {
  tenantId: string;
  config: TenantConfig;
  leadId: string;
  callerPhone: string;
  calledAt: Date;
  textback: TextbackOutcome;
  messageId?: string;
}) => Promise<void>;

export interface InboundCall {
  callSid: string;
  from: string;
  to: string;
}

function hangup(): string {
  const response = new VoiceResponse();
  response.hangup();
  return response.toString();
}

function validPhone(value: string): string | null {
  return phoneE164.safeParse(value).success ? value : null;
}

// First webhook: a call is coming in. Ring the owner, then report back to
// DIAL_STATUS_PATH. Forwarding must keep working even if logging the call fails.
export async function handleIncomingCall(call: InboundCall, deps: CallDeps): Promise<string> {
  const tenant = await deps.store.findTenantByNumber(call.to);
  if (!tenant) {
    deps.log("voice.unknown_number", { callSid: call.callSid });
    const response = new VoiceResponse();
    response.say("Sorry, this number is not in service.");
    response.hangup();
    return response.toString();
  }

  try {
    await deps.store.recordInboundCall({
      tenantId: tenant.tenantId,
      callSid: call.callSid,
      fromPhone: validPhone(call.from),
      toPhone: call.to,
    });
  } catch (err) {
    deps.log("voice.record_call_failed", {
      tenantId: tenant.tenantId,
      callSid: call.callSid,
      error: errorLabel(err),
    });
  }

  const response = new VoiceResponse();
  const dial = response.dial({
    timeout: tenant.config.calls.ringSeconds,
    action: new URL(DIAL_STATUS_PATH, deps.publicBaseUrl).toString(),
    method: "POST",
  });
  dial.number(tenant.config.calls.forwardToNumber);
  return response.toString();
}

// Only text US/Canada numbers until other countries' rules have been reviewed.
const NANP = /^\+1[2-9]\d{9}$/;

async function withRetry<T>(attempts: number, fn: () => Promise<T>): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
    }
  }
}

// Second webhook: the forwarded call ended. If nobody answered, save the lead
// and text the caller back, at most once per call and once per cooldown.
//
// Every step is idempotent, so a redelivered webhook resumes where a failed one
// stopped: the outcome can't flip, the lead is reused, and the message claim
// (unique key per call) means a text is never sent twice.
export async function handleDialStatus(
  call: InboundCall & { dialStatus: string },
  deps: CallDeps,
): Promise<string> {
  const { store, log } = deps;
  const tenant = await store.findTenantByNumber(call.to);
  if (!tenant) {
    log("dial_status.unknown_number", { callSid: call.callSid });
    return hangup();
  }
  const { tenantId, config } = tenant;
  const ctx = { tenantId, callSid: call.callSid };

  const answered = ANSWERED_DIAL_STATUSES.has(call.dialStatus);
  const recognized = answered || MISSED_DIAL_STATUSES.has(call.dialStatus);
  if (!recognized) {
    // Save it as missed so the owner sees the lead, but don't text on a guess.
    log("dial_status.unrecognized", { ...ctx, dialStatus: call.dialStatus });
  }

  const fromPhone = validPhone(call.from);
  const outcome = await store.setCallOutcome({
    tenantId,
    callSid: call.callSid,
    fromPhone,
    toPhone: call.to,
    outcome: answered ? "answered" : "missed",
    dialStatus: call.dialStatus,
  });
  if (outcome === "answered") return hangup();

  if (!fromPhone) {
    log("missed_call.no_caller_id", ctx);
    return hangup();
  }

  const leadId = await store.findOrCreateMissedCallLead(tenantId, fromPhone);
  await store.linkCallToLead(tenantId, call.callSid, leadId);
  log("missed_call.lead_saved", { ...ctx, leadId });

  const textback = await textBack(
    { tenantId, config, callSid: call.callSid, leadId, callerPhone: fromPhone, businessNumber: call.to, recognized },
    deps,
  );

  // The owner hears about every new lead, whatever happened to the text-back.
  await deps.notifyOwner?.({
    tenantId,
    config,
    leadId,
    callerPhone: fromPhone,
    calledAt: new Date(),
    textback: textback.outcome,
    messageId: textback.messageId,
  });

  if (textback.outcome.kind !== "sent") return hangup();
  const response = new VoiceResponse();
  response.say("Sorry we missed your call. We'll text you in just a moment.");
  response.hangup();
  return response.toString();
}

async function textBack(
  ctx: {
    tenantId: string;
    config: TenantConfig;
    callSid: string;
    leadId: string;
    callerPhone: string;
    businessNumber: string;
    recognized: boolean;
  },
  deps: CallDeps,
): Promise<{ outcome: TextbackOutcome; messageId?: string }> {
  const { store, log } = deps;
  const { tenantId, config, leadId, callerPhone: fromPhone } = ctx;
  const logCtx = { tenantId, callSid: ctx.callSid };
  const skip = (reason: string) => {
    log("textback.skipped", { ...logCtx, reason });
    return { outcome: { kind: "skipped" as const, reason } };
  };

  if (!ctx.recognized) return skip("unrecognized_status");
  if (!canSendTexts(config)) return skip("a2p_not_approved");
  // canSendTexts guarantees fromNumber is set.
  const sendFrom = config.messaging.fromNumber as string;
  const ownNumbers = [ctx.businessNumber, sendFrom, config.calls.forwardToNumber];
  if (ownNumbers.includes(fromPhone)) return skip("caller_is_tenant");
  if (!NANP.test(fromPhone)) return skip("non_us_number");
  // Never send under another tenant's number, even if config is wrong.
  if ((await store.findTenantByNumber(sendFrom))?.tenantId !== tenantId) {
    return skip("from_number_not_owned");
  }
  if (await store.isOptedOut(tenantId, fromPhone)) return skip("opted_out");

  const body = renderMissedCallTextbackV1(config);
  const cooldownSince = new Date(Date.now() - config.messaging.textbackCooldownHours * 3_600_000);
  const messageId = await store.claimTextback(
    {
      tenantId,
      idempotencyKey: `missed-call-textback:${ctx.callSid}`,
      leadId,
      toPhone: fromPhone,
      fromPhone: sendFrom,
      body,
      templateVersion: MISSED_CALL_TEXTBACK_V1,
    },
    cooldownSince,
  );
  // Already texted for this call, or within the cooldown.
  if (!messageId) return skip("already_texted");

  let sid: string;
  try {
    ({ sid } = await deps.sender.send({ from: sendFrom, to: fromPhone, body }));
  } catch (err) {
    const sendError =
      err instanceof SmsSendError ? err : new SmsSendError("unknown", "unexpected", "send failed");
    log("textback.send_failed", { ...logCtx, messageId, kind: sendError.kind, code: sendError.code });
    // Record the opt-out first: it matters more than the message status.
    if (sendError.code === TWILIO_UNSUBSCRIBED) {
      await withRetry(3, () => store.addOptOut(tenantId, fromPhone, "carrier"));
    }
    // 'unknown' is never retried automatically: a retry could double-text.
    await withRetry(3, () =>
      store.markMessage(messageId, {
        status: sendError.kind === "rejected" ? "failed" : "unknown",
        errorCode: sendError.code,
      }),
    );
    return { outcome: { kind: sendError.kind === "rejected" ? "failed" : "unknown" }, messageId };
  }

  // The text is out. A failure to record that must not relabel it or resend;
  // a row left 'pending' is picked up by the runbook's review query.
  try {
    await withRetry(3, () => store.markMessage(messageId, { status: "sent", providerSid: sid }));
    log("textback.sent", { ...logCtx, messageId });
  } catch (err) {
    log("textback.mark_sent_failed", { ...logCtx, messageId, providerSid: sid, error: errorLabel(err) });
  }
  return { outcome: { kind: "sent" }, messageId };
}
