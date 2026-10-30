import { getNotificationDeps } from "../../../../lib/missed-call/deps";
import { cronRoute } from "../../../../lib/notifications/cron-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = cronRoute(() => process.env.CRON_SECRET, getNotificationDeps);
