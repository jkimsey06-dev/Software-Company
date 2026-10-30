import { getCalendarRouteDeps } from "../../../../lib/missed-call/deps";
import { callbackRoute } from "../../../../lib/calendar/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = callbackRoute(getCalendarRouteDeps);
