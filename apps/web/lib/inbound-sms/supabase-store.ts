import type { SupabaseClient } from "@supabase/supabase-js";
import { tenantConfigSchema } from "@sc/shared";
import { StoreError, TenantConfigError } from "../missed-call/supabase-store";
import type { Logger } from "../missed-call/types";
import type { InboundSmsStore } from "./types";

function data<T>(result: { data: T; error: { code?: string } | null }, what: string): T {
  if (result.error) throw new StoreError(what, result.error.code ?? "unknown");
  return result.data;
}

export function createInboundSmsStore(db: SupabaseClient, log: Logger): InboundSmsStore {
  return {
    async findTenantIdByNumber(phone) {
      const row = data(
        await db.from("tenant_phone_numbers").select("tenant_id").eq("phone", phone).maybeSingle(),
        "find tenant id by number",
      ) as { tenant_id: string } | null;
      return row?.tenant_id ?? null;
    },

    async loadTenantConfig(tenantId) {
      const row = data(
        await db.from("tenants").select("config").eq("id", tenantId).single(),
        "load tenant config",
      ) as { config: unknown };
      const parsed = tenantConfigSchema.safeParse(row.config);
      if (!parsed.success) {
        log("tenant.config_invalid", { tenantId });
        throw new TenantConfigError();
      }
      return parsed.data;
    },

    async recordInbound(m) {
      const rows = data(
        await db
          .from("inbound_messages")
          .upsert(
            {
              tenant_id: m.tenantId,
              message_sid: m.messageSid,
              from_phone: m.fromPhone,
              to_phone: m.toPhone,
              body: m.body,
              keyword: m.keyword,
              lead_id: m.leadId,
            },
            { onConflict: "message_sid", ignoreDuplicates: true },
          )
          .select("id"),
        "record inbound message",
      );
      return (rows?.length ?? 0) > 0;
    },

    async addOptOut(tenantId, phone) {
      data(
        await db
          .from("opt_outs")
          .upsert(
            { tenant_id: tenantId, phone, source: "inbound_stop" },
            { onConflict: "tenant_id,phone", ignoreDuplicates: true },
          ),
        "add opt-out",
      );
    },

    async removeOptOut(tenantId, phone) {
      data(
        await db.from("opt_outs").delete().eq("tenant_id", tenantId).eq("phone", phone),
        "remove opt-out",
      );
    },

    async findLatestLeadId(tenantId, phone) {
      const rows = data(
        await db
          .from("leads")
          .select("id")
          .eq("tenant_id", tenantId)
          .eq("phone", phone)
          .order("created_at", { ascending: false })
          .limit(1),
        "find latest lead",
      );
      return (rows?.[0]?.id as string | undefined) ?? null;
    },
  };
}
