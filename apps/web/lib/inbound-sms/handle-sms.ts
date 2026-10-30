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
  const keyword = classifyKeyword(msg.body, msg.optOutType);

  // Opt-outs first, before anything that could fail on the way.
  if (keyword === "stop") await store.addOptOut(tenantId, fromPhone);
  if (keyword === "start") await store.removeOptOut(tenantId, fromPhone);

  const leadId = await store.findLatestLeadId(tenantId, fromPhone);
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
  log("sms.received", { ...ctx, keyword: keyword ?? "none", hasLead: leadId !== null });
  if (keyword) return noReply();

  // A real reply: pass it to the owner until the AI conversation exists.
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
      });
    } catch (err) {
      log("sms.notify_failed", { ...ctx, error: errorLabel(err) });
    }
  }
  return noReply();
}
