import { getCalendarRouteDeps } from "../../../../lib/missed-call/deps";
import { connectRoute } from "../../../../lib/calendar/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = connectRoute(getCalendarRouteDeps);
