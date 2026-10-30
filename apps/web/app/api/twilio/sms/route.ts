import { getSmsRouteDeps } from "../../../../lib/missed-call/deps";
import { smsRoute } from "../../../../lib/inbound-sms/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = smsRoute(getSmsRouteDeps);
