import type { ZodType } from "zod";
import { handleDialStatus, handleIncomingCall, type CallDeps } from "./handle-call";
import { dialStatusParams, inboundCallParams, readVerifiedTwilioForm } from "./twilio-request";

export interface RouteDeps extends CallDeps {
  twilioAuthToken: string;
}

function xml(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/xml" } });
}

async function verified<T>(
  request: Request,
  deps: RouteDeps,
  schema: ZodType<T>,
): Promise<{ ok: true; params: T } | { ok: false; response: Response }> {
  const form = await readVerifiedTwilioForm(request, deps.twilioAuthToken, deps.publicBaseUrl);
  if (!form) {
    deps.log("twilio.signature_rejected");
    return { ok: false, response: new Response("Forbidden", { status: 403 }) };
  }
  const parsed = schema.safeParse(form);
  if (!parsed.success) {
    deps.log("twilio.bad_params");
    return { ok: false, response: new Response("Bad Request", { status: 400 }) };
  }
  return { ok: true, params: parsed.data };
}

export function voiceRoute(getDeps: () => RouteDeps) {
  return async (request: Request): Promise<Response> => {
    const deps = getDeps();
    const result = await verified(request, deps, inboundCallParams);
    if (!result.ok) return result.response;
    const { CallSid, From, To } = result.params;
    // Errors here return 500 so Twilio uses the number's fallback URL, which
    // should forward straight to the owner (see docs/runbooks/twilio.md).
    return xml(await handleIncomingCall({ callSid: CallSid, from: From, to: To }, deps));
  };
}

export function dialStatusRoute(getDeps: () => RouteDeps) {
  return async (request: Request): Promise<Response> => {
    const deps = getDeps();
    const result = await verified(request, deps, dialStatusParams);
    if (!result.ok) return result.response;
    const { CallSid, From, To, DialCallStatus } = result.params;
    try {
      return xml(
        await handleDialStatus(
          { callSid: CallSid, from: From, to: To, dialStatus: DialCallStatus },
          deps,
        ),
      );
    } catch (err) {
      // The caller is still on the line: end the call cleanly rather than
      // playing Twilio's error message. The failure is logged for follow-up.
      deps.log("dial_status.error", { callSid: CallSid, error: String(err) });
      return xml('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    }
  };
}
