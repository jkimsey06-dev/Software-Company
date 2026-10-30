import type { SupabaseClient } from "@supabase/supabase-js";
import { StoreError } from "../missed-call/supabase-store";
import type { NotificationStore } from "./types";

// A sender that has held a row this long is assumed dead; the row can be retaken.
const STALE_LOCK = "5 minutes";

function data<T>(result: { data: T; error: { code?: string } | null }, what: string): T {
  if (result.error) throw new StoreError(what, result.error.code ?? "unknown");
  return result.data;
}

export function createNotificationStore(db: SupabaseClient): NotificationStore {
  return {
    async enqueue(n) {
      const rows = data(
        await db
          .from("notifications")
          .upsert(
            {
              tenant_id: n.tenantId,
              kind: n.kind,
              idempotency_key: n.idempotencyKey,
              lead_id: n.leadId,
              recipient_email: n.recipientEmail,
              subject: n.subject,
              body: n.body,
            },
            { onConflict: "tenant_id,idempotency_key", ignoreDuplicates: true },
          )
          .select("id"),
        "enqueue notification",
      );
      return (rows?.[0]?.id as string | undefined) ?? null;
    },

    async claim(id) {
      const rows = data(
        await db.rpc("claim_notification", { p_id: id, p_stale_after: STALE_LOCK }),
        "claim notification",
      ) as Array<Record<string, unknown>> | null;
      const row = rows?.[0];
      if (!row) return null;
      return {
        id: row.id as string,
        tenantId: row.tenant_id as string,
        recipientEmail: row.recipient_email as string,
        subject: row.subject as string,
        body: row.body as string,
        attempts: row.attempts as number,
      };
    },

    async markSent(id, attempt, providerId) {
      data(
        await db
          .from("notifications")
          .update({ status: "sent", provider_id: providerId, locked_at: null, last_error_code: null })
          .eq("id", id)
          .eq("status", "sending")
          .eq("attempts", attempt),
        "mark notification sent",
      );
    },

    async markFailed(id, attempt, errorCode, retryAt) {
      data(
        await db
          .from("notifications")
          .update({
            status: retryAt ? "failed" : "dead",
            last_error_code: errorCode.slice(0, 100),
            next_attempt_at: (retryAt ?? new Date()).toISOString(),
            locked_at: null,
          })
          .eq("id", id)
          .eq("status", "sending")
          .eq("attempts", attempt),
        "mark notification failed",
      );
    },

    async expireOld() {
      const count = data(await db.rpc("expire_notifications"), "expire notifications");
      return (count as number | null) ?? 0;
    },

    async due(limit) {
      const ids = data(
        await db.rpc("due_notifications", { p_limit: limit, p_stale_after: STALE_LOCK }),
        "list due notifications",
      ) as string[] | null;
      return ids ?? [];
    },
  };
}
