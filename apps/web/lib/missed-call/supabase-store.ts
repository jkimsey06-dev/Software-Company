import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { tenantConfigSchema } from "@sc/shared";
import type { CallOutcome, Logger, MissedCallStore } from "./types";

const LEAD_REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Carries the Postgres/PostgREST error code, which is safe to log. The message
// can include row values, so it is kept off the error that reaches logs.
export class StoreError extends Error {
  constructor(
    readonly operation: string,
    readonly code: string,
  ) {
    super(`${operation} failed (${code})`);
    this.name = "StoreError";
  }
}

// Thrown when a tenant's stored config fails validation. The voice webhook then
// returns 500, so Twilio's fallback forwards the call straight to the owner.
export class TenantConfigError extends Error {
  readonly code = "invalid_config";
  constructor() {
    super("tenant config is invalid");
    this.name = "TenantConfigError";
  }
}

function check<T>(
  result: { data: T; error: { message: string; code?: string } | null },
  what: string,
): T {
  if (result.error) throw new StoreError(what, result.error.code ?? "unknown");
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
        throw new TenantConfigError();
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
      if (inserted.length > 0) return call.outcome;

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
      if (updated.length > 0) return call.outcome;

      // Someone else set it first; that answer stands.
      const existing = required(
        await db
          .from("calls")
          .select("outcome")
          .eq("tenant_id", call.tenantId)
          .eq("call_sid", call.callSid)
          .single(),
        "read call outcome",
      );
      return existing.outcome as CallOutcome;
    },

    async findOrCreateMissedCallLead(tenantId, phone) {
      // Locked per (tenant, phone) in the database, so concurrent webhooks share one lead.
      const leadId = required(
        await db.rpc("find_or_create_missed_call_lead", {
          p_tenant_id: tenantId,
          p_phone: phone,
          p_reuse_since: new Date(Date.now() - LEAD_REUSE_WINDOW_MS).toISOString(),
        }),
        "find or create lead",
      );
      return leadId as string;
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

    async claimTextback(message, cooldownSince) {
      // Locked per (tenant, phone) in the database: the cooldown check and the
      // insert happen together, so two overlapping calls can't both be texted.
      const id = check(
        await db.rpc("claim_missed_call_textback", {
          p_tenant_id: message.tenantId,
          p_idempotency_key: message.idempotencyKey,
          p_lead_id: message.leadId,
          p_to_phone: message.toPhone,
          p_from_phone: message.fromPhone,
          p_body: message.body,
          p_template_version: message.templateVersion,
          p_cooldown_since: cooldownSince.toISOString(),
        }),
        "claim text-back",
      );
      return (id as string | null) ?? null;
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
