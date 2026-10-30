import type { SupabaseClient } from "@supabase/supabase-js";
import { StoreError } from "../missed-call/supabase-store";

export interface CalendarConnection {
  calendarId: string;
  refreshTokenEnc: string;
  status: "connected" | "revoked";
}

export interface CalendarStore {
  getConnection(tenantId: string): Promise<CalendarConnection | null>;
  saveConnection(tenantId: string, calendarId: string, refreshTokenEnc: string): Promise<void>;
  markRevoked(tenantId: string): Promise<void>;
  // True the first time this link nonce is used; false after that.
  useLinkNonce(nonce: string, tenantId: string): Promise<boolean>;
}

function data<T>(result: { data: T; error: { code?: string } | null }, what: string): T {
  if (result.error) throw new StoreError(what, result.error.code ?? "unknown");
  return result.data;
}

export function createCalendarStore(db: SupabaseClient): CalendarStore {
  return {
    async getConnection(tenantId) {
      const row = data(
        await db
          .from("calendar_connections")
          .select("calendar_id, refresh_token_enc, status")
          .eq("tenant_id", tenantId)
          .maybeSingle(),
        "get calendar connection",
      ) as { calendar_id: string; refresh_token_enc: string; status: "connected" | "revoked" } | null;
      return row ? { calendarId: row.calendar_id, refreshTokenEnc: row.refresh_token_enc, status: row.status } : null;
    },

    async saveConnection(tenantId, calendarId, refreshTokenEnc) {
      data(
        await db.from("calendar_connections").upsert(
          { tenant_id: tenantId, calendar_id: calendarId, refresh_token_enc: refreshTokenEnc, status: "connected", connected_at: new Date().toISOString() },
          { onConflict: "tenant_id" },
        ),
        "save calendar connection",
      );
    },

    async markRevoked(tenantId) {
      data(
        await db.from("calendar_connections").update({ status: "revoked" }).eq("tenant_id", tenantId),
        "mark calendar revoked",
      );
    },

    async useLinkNonce(nonce, tenantId) {
      const res = await db.from("calendar_link_uses").insert({ nonce, tenant_id: tenantId });
      if (res.error?.code === "23505") return false;
      data(res, "use link nonce");
      return true;
    },
  };
}
