import { phoneE164 } from "@sc/shared";
import twilio from "twilio";
import { errorLabel } from "../missed-call/types";
import { classifyKeyword } from "./keywords";
import type { InboundSms, SmsDeps } from "./types";

// We never auto-reply here. Twilio's Advanced Opt-Out sends the STOP/START/HELP
// confirmations, and the AI conversation (later) will send real replies.
function noReply(): string {
  return new twilio.twiml.MessagingResponse().toString();
}

// A customer texted one of a tenant's numbers.
export async function handleInboundSms(msg: InboundSms, deps: SmsDeps): Promise<string> {
  const { store, log } = deps;
  const tenantId = await store.findTenantIdByNumber(msg.to);
  if (!tenantId) {
    log("sms.unknown_number", { messageSid: msg.messageSid });
    return noReply();
  }
  const ctx = { tenantId, messageSid: msg.messageSid };

  if (!phoneE164.safeParse(msg.from).success) {
    log("sms.invalid_sender", ctx);
    return noReply();
  }
  const fromPhone = msg.from;
  const { keyword, bare } = classifyKeyword(msg.body, msg.optOutType);

  // The lead link is nice to have; it must never stand in the way of a STOP.
  let leadId: string | null = null;
  try {
    leadId = await store.findLatestLeadId(tenantId, fromPhone);
  } catch (err) {
    log("sms.lead_lookup_failed", { ...ctx, error: errorLabel(err) });
  }
  // Message and opt-out change are recorded together, so a STOP is never lost
  // between steps and a replayed START can't undo a later STOP.
  const isNew = await store.recordInbound({
    tenantId,
    messageSid: msg.messageSid,
    fromPhone,
    toPhone: msg.to,
    body: msg.body,
    keyword,
    leadId,
  });
  if (!isNew) {
    log("sms.duplicate", ctx);
    return noReply();
  }
  log("sms.received", { ...ctx, keyword: keyword ?? "none", bare, hasLead: leadId !== null });
  if (bare) return noReply();

  // A plain text with words goes to the AI conversation. Keywords, opt-outs and
  // photo-only messages go straight to the owner.
  if (!keyword && msg.body.trim() && deps.converse) {
    deps.converse({
      tenantId,
      customerPhone: fromPhone,
      businessNumber: msg.to,
      leadId,
      messageSid: msg.messageSid,
      body: msg.body,
      numMedia: msg.numMedia,
      receivedAt: new Date(),
    });
    return noReply();
  }

  if (deps.notifyReply) {
    try {
      const config = await store.loadTenantConfig(tenantId);
      deps.notifyReply({
        tenantId,
        config,
        leadId,
        messageSid: msg.messageSid,
        callerPhone: fromPhone,
        body: msg.body,
        numMedia: msg.numMedia,
        receivedAt: new Date(),
        optedOut: keyword === "stop",
      });
    } catch (err) {
      log("sms.notify_failed", { ...ctx, error: errorLabel(err) });
    }
  }
  return noReply();
}
