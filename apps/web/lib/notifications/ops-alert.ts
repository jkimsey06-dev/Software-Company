import { errorLabel, type Logger } from "../missed-call/types";
import type { EmailSender, OpsAlert } from "./types";

// Emails the operator about a system problem. Doesn't touch the database, so
// it still works when Supabase is down. Fields must be IDs and codes only.
export function createOpsAlert(
  email: EmailSender | null,
  to: string | undefined,
  log: Logger,
): OpsAlert {
  return async (event, fields) => {
    log("ops_alert", { alert: event, ...fields });
    if (!email || !to) return;
    const details = Object.entries(fields)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");
    try {
      await email.send({
        to,
        subject: `[Front Office alert] ${event}`,
        text: `${event}\n\n${details}\n\nSee docs/runbooks for what to check.`,
        // One email per event and subject (e.g. per call) even if raised twice.
        idempotencyKey: `ops:${event}:${Object.values(fields).join(":")}`.slice(0, 256),
      });
    } catch (err) {
      log("ops_alert.send_failed", { alert: event, error: errorLabel(err) });
    }
  };
}
