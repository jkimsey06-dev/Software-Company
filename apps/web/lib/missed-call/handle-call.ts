import { canSendTexts, phoneE164 } from "@sc/shared";
import { MISSED_CALL_TEXTBACK_V1, renderMissedCallTextbackV1 } from "@sc/ai";
import twilio from "twilio";
import { SmsSendError, type Logger, type MissedCallStore, type SmsSender } from "./types";

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
}

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
      error: String(err),
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

// Second webhook: the forwarded call ended. If nobody answered, create the lead
// and text the caller back, exactly once.
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

  const missed = MISSED_DIAL_STATUSES.has(call.dialStatus);
  if (!missed && !ANSWERED_DIAL_STATUSES.has(call.dialStatus)) {
    // Unknown status: don't guess. No text.
    log("dial_status.unrecognized", { ...ctx, dialStatus: call.dialStatus });
  }

  const fromPhone = validPhone(call.from);
  const isFirst = await store.setCallOutcome({
    tenantId,
    callSid: call.callSid,
    fromPhone,
    toPhone: call.to,
    outcome: missed ? "missed" : "answered",
    dialStatus: call.dialStatus,
  });
  if (!isFirst) {
    log("dial_status.duplicate", ctx);
    return hangup();
  }
  if (!missed) return hangup();

  if (!fromPhone) {
    log("missed_call.no_caller_id", ctx);
    return hangup();
  }

  const leadId = await store.findOrCreateMissedCallLead(tenantId, fromPhone);
  await store.linkCallToLead(tenantId, call.callSid, leadId);
  log("missed_call.lead_saved", { ...ctx, leadId });

  const skip = (reason: string) => {
    log("textback.skipped", { ...ctx, reason });
    return hangup();
  };
  if (!canSendTexts(config)) return skip("a2p_not_approved");
  if (fromPhone === config.calls.forwardToNumber) return skip("caller_is_owner");
  if (await store.isOptedOut(tenantId, fromPhone)) return skip("opted_out");

  // canSendTexts guarantees fromNumber is set.
  const sendFrom = config.messaging.fromNumber as string;
  const body = renderMissedCallTextbackV1(config);
  const messageId = await store.claimOutboundMessage({
    tenantId,
    idempotencyKey: `missed-call-textback:${call.callSid}`,
    leadId,
    toPhone: fromPhone,
    fromPhone: sendFrom,
    body,
    templateVersion: MISSED_CALL_TEXTBACK_V1,
  });
  if (!messageId) return skip("already_claimed");

  try {
    const { sid } = await deps.sender.send({ from: sendFrom, to: fromPhone, body });
    await store.markMessage(messageId, { status: "sent", providerSid: sid });
    log("textback.sent", { ...ctx, messageId });
  } catch (err) {
    const sendError =
      err instanceof SmsSendError ? err : new SmsSendError("unknown", "unexpected", String(err));
    // 'unknown' is never retried automatically: a retry could double-text.
    await store.markMessage(messageId, {
      status: sendError.kind === "rejected" ? "failed" : "unknown",
      errorCode: sendError.code,
    });
    if (sendError.code === TWILIO_UNSUBSCRIBED) {
      await store.addOptOut(tenantId, fromPhone, "carrier");
    }
    log("textback.send_failed", { ...ctx, messageId, kind: sendError.kind, code: sendError.code });
    return hangup();
  }

  const response = new VoiceResponse();
  response.say("Sorry we missed your call. We'll text you in just a moment.");
  response.hangup();
  return response.toString();
}
