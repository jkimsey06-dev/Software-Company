import { timingSafeEqual } from "node:crypto";
import { errorLabel } from "../missed-call/types";
import { sendDueNotifications } from "./dispatch";
import type { NotificationDeps } from "./types";

function bearerMatches(header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Retries queued owner notifications. Called by the scheduler with
// `Authorization: Bearer $CRON_SECRET` (Vercel Cron sends this automatically).
export function cronRoute(
  getSecret: () => string | undefined,
  getDeps: () => NotificationDeps | null,
  // Extra work per run (e.g. forwarding customer texts nobody handled).
  getSweep?: () => ((deps: NotificationDeps) => Promise<number>) | null,
) {
  return async (request: Request): Promise<Response> => {
    const secret = getSecret();
    // Fail closed: no secret configured means nobody can trigger it.
    if (!secret || secret.length < 32 || !bearerMatches(request.headers.get("authorization"), secret)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const deps = getDeps();
    if (!deps) return Response.json({ ok: true, processed: 0, disabled: true });
    try {
      const sweep = getSweep?.();
      const swept = sweep ? await sweep(deps) : 0;
      const processed = await sendDueNotifications(deps);
      return Response.json(sweep ? { ok: true, processed, swept } : { ok: true, processed });
    } catch (err) {
      const error = errorLabel(err);
      deps.log("notification.cron_failed", { error });
      await deps.opsAlert("notification.cron_failed", { error });
      return Response.json({ ok: false }, { status: 500 });
    }
  };
}
