import type { Schedule } from "../notifications/owner";
import { errorLabel } from "../missed-call/types";
import { inboundSmsParams, readVerifiedTwilioForm } from "../missed-call/twilio-request";
import type { OpsAlert } from "../notifications/types";
import { handleInboundSms } from "./handle-sms";
import { classifyKeyword } from "./keywords";
import type { SmsDeps } from "./types";

export interface SmsRouteDeps extends SmsDeps {
  twilioAuthToken: string;
  publicBaseUrl: string;
  opsAlert?: OpsAlert;
  schedule?: Schedule;
}

function xml(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/xml" } });
}

export function smsRoute(getDeps: () => SmsRouteDeps) {
  return async (request: Request): Promise<Response> => {
    const deps = getDeps();
    const form = await readVerifiedTwilioForm(request, deps.twilioAuthToken, deps.publicBaseUrl);
    if (!form) {
      deps.log("twilio.signature_rejected");
      return new Response("Forbidden", { status: 403 });
    }
    const parsed = inboundSmsParams.safeParse(form);
    if (!parsed.success) {
      deps.log("twilio.bad_params");
      return new Response("Bad Request", { status: 400 });
    }
    const p = parsed.data;
    try {
      return xml(
        await handleInboundSms(
          {
            messageSid: p.MessageSid,
            from: p.From,
            to: p.To,
            body: p.Body,
            numMedia: p.NumMedia,
            optOutType: p.OptOutType,
          },
          deps,
        ),
      );
    } catch (err) {
      // 500, and the operator is told. Twilio's Advanced Opt-Out still blocks
      // texts to anyone who sent a standard STOP keyword.
      // Say whether it was an opt-out: Twilio blocks its standard keywords on
      // its own, but a plain-language one must be added by hand from its logs.
      const error = errorLabel(err);
      const keyword = classifyKeyword(p.Body, p.OptOutType).keyword ?? "none";
      deps.log("sms.error", { messageSid: p.MessageSid, keyword, error });
      const alert = deps.opsAlert;
      if (alert) deps.schedule?.(() => alert("sms.error", { messageSid: p.MessageSid, keyword, error }));
      return new Response("Server Error", { status: 500 });
    }
  };
}
