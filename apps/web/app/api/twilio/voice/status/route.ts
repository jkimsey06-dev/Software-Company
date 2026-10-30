import { getRouteDeps } from "../../../../../lib/missed-call/deps";
import { dialStatusRoute } from "../../../../../lib/missed-call/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = dialStatusRoute(getRouteDeps);
