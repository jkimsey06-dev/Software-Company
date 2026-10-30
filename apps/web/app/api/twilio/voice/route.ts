import { getRouteDeps } from "../../../../lib/missed-call/deps";
import { voiceRoute } from "../../../../lib/missed-call/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = voiceRoute(getRouteDeps);
