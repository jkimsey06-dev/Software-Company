import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { tenantConfigSchema } from "@sc/shared";
import type { Logger, MissedCallStore } from "./types";

const LEAD_REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;

function check<T>(result: { data: T; error: { message: string } | null }, what: string): T {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return result.data;
}

// For queries that must return data (selects after writes, list queries).
function required<T>(
  result: { data: T; error: { message: string } | null },
  what: string,
): NonNullable<T> {
  const data = check(result, what);
  if (data === null || data === undefined) throw new Error(`${what}: no data returned`);
  return data;
}

// Service-role client: bypasses RLS. Server-only; never import from client components.
export function createServiceClient(url: string, serviceRoleKey: string): SupabaseClient {
  if (typeof window !== "undefined") {
    throw new Error("The service role client must never run in the browser.");
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function createSupabaseStore(db: SupabaseClient, log: Logger): MissedCallStore {
  return {
    async findTenantByNumber(phone) {
      const row = check(
        await db
          .from("tenant_phone_numbers")
          .select("tenant_id, tenants(config)")
          .eq("phone", phone)
          .maybeSingle(),
        "find tenant by number",
      ) as { tenant_id: string; tenants: { config: unknown } | null } | null;
      if (!row?.tenants) return null;

      const config = tenantConfigSchema.safeParse(row.tenants.config);
      if (!config.success) {
        log("tenant.config_invalid", { tenantId: row.tenant_id });
        return null;
      }
      return { tenantId: row.tenant_id, config: config.data };
    },

    async recordInboundCall(call) {
      check(
        await db.from("calls").upsert(
          {
            tenant_id: call.tenantId,
            call_sid: call.callSid,
            from_phone: call.fromPhone,
            to_phone: call.toPhone,
          },
          { onConflict: "call_sid", ignoreDuplicates: true },
        ),
        "record inbound call",
      );
    },

    async setCallOutcome(call) {
      // Call never recorded (first webhook failed to log it): insert with outcome.
      const inserted = required(
        await db
          .from("calls")
          .upsert(
            {
              tenant_id: call.tenantId,
              call_sid: call.callSid,
              from_phone: call.fromPhone,
              to_phone: call.toPhone,
              outcome: call.outcome,
              dial_status: call.dialStatus,
            },
            { onConflict: "call_sid", ignoreDuplicates: true },
          )
          .select("id"),
        "insert call outcome",
      );
      if (inserted.length > 0) return true;

      // Already recorded: only the first request to set the outcome wins.
      const updated = required(
        await db
          .from("calls")
          .update({ outcome: call.outcome, dial_status: call.dialStatus })
          .eq("tenant_id", call.tenantId)
          .eq("call_sid", call.callSid)
          .is("outcome", null)
          .select("id"),
        "update call outcome",
      );
      return updated.length > 0;
    },

    async findOrCreateMissedCallLead(tenantId, phone) {
      const since = new Date(Date.now() - LEAD_REUSE_WINDOW_MS).toISOString();
      const existing = required(
        await db
          .from("leads")
          .select("id")
          .eq("tenant_id", tenantId)
          .eq("phone", phone)
          .in("status", ["new", "contacted"])
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(1),
        "find open lead",
      );
      if (existing[0]) return existing[0].id as string;

      const created = required(
        await db
          .from("leads")
          .insert({ tenant_id: tenantId, phone, source: "missed_call" })
          .select("id")
          .single(),
        "create lead",
      );
      return created.id as string;
    },

    async linkCallToLead(tenantId, callSid, leadId) {
      check(
        await db
          .from("calls")
          .update({ lead_id: leadId })
          .eq("tenant_id", tenantId)
          .eq("call_sid", callSid),
        "link call to lead",
      );
    },

    async isOptedOut(tenantId, phone) {
      const rows = required(
        await db
          .from("opt_outs")
          .select("phone")
          .eq("tenant_id", tenantId)
          .eq("phone", phone)
          .limit(1),
        "check opt-out",
      );
      return rows.length > 0;
    },

    async addOptOut(tenantId, phone, source) {
      check(
        await db
          .from("opt_outs")
          .upsert(
            { tenant_id: tenantId, phone, source },
            { onConflict: "tenant_id,phone", ignoreDuplicates: true },
          ),
        "add opt-out",
      );
    },

    async claimOutboundMessage(message) {
      const rows = required(
        await db
          .from("outbound_messages")
          .upsert(
            {
              tenant_id: message.tenantId,
              idempotency_key: message.idempotencyKey,
              lead_id: message.leadId,
              to_phone: message.toPhone,
              from_phone: message.fromPhone,
              body: message.body,
              template_version: message.templateVersion,
            },
            { onConflict: "tenant_id,idempotency_key", ignoreDuplicates: true },
          )
          .select("id"),
        "claim outbound message",
      );
      return (rows[0]?.id as string | undefined) ?? null;
    },

    async markMessage(id, update) {
      check(
        await db
          .from("outbound_messages")
          .update(
            update.status === "sent"
              ? { status: "sent", provider_sid: update.providerSid }
              : { status: update.status, error_code: update.errorCode },
          )
          .eq("id", id),
        "mark message",
      );
    },
  };
}
