import { getSmsRouteDeps } from "../../../../lib/missed-call/deps";
import { smsRoute } from "../../../../lib/inbound-sms/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The AI conversation runs after the response; give it room to finish.
export const maxDuration = 60;

export const POST = smsRoute(getSmsRouteDeps);
