import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { cache } from "react";
import { redirect } from "next/navigation";
import { sessionCookieOptions } from "./cookies";
import { readSupabasePublicEnv } from "./env";
import { TENANT_COOKIE, pickTenant, type Membership } from "./tenant";

// A Supabase client acting as the signed-in owner (cookies carry the session).
// Row-level security decides what it can see.
export async function createDashboardClient(): Promise<SupabaseClient | null> {
  const env = readSupabasePublicEnv();
  if (!env) return null;
  const store = await cookies();
  return createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        // Server components can't set cookies; proxy.ts refreshes the session.
        try {
          for (const { name, value, options } of list) store.set(name, value, sessionCookieOptions(options));
        } catch {
          /* read-only context */
        }
      },
    },
  });
}

export interface DashboardContext {
  db: SupabaseClient;
  userEmail: string;
  tenant: Membership;
  tenants: Membership[];
}

function toMemberships(rows: unknown): Membership[] {
  if (!Array.isArray(rows)) return [];
  const out: Membership[] = [];
  for (const row of rows) {
    const r = row as { tenant_id?: string; role?: string; tenants?: unknown };
    const t = (Array.isArray(r.tenants) ? r.tenants[0] : r.tenants) as { name?: string; config?: unknown } | null | undefined;
    if (typeof r.tenant_id !== "string" || !t || typeof t.name !== "string") continue;
    out.push({ tenantId: r.tenant_id, name: t.name, role: r.role === "owner" ? "owner" : "staff", config: t.config });
  }
  return out;
}

export async function listMemberships(db: SupabaseClient, userId: string): Promise<Membership[]> {
  const { data, error } = await db.from("tenant_members").select("tenant_id, role, tenants(name, config)").eq("user_id", userId);
  if (error) throw new Error("could not load memberships");
  return toMemberships(data);
}

// Every dashboard page starts here (once per request, shared with the layout). getUser() asks Supabase to validate the
// session (not just read the cookie).
export const getContext = cache(async (): Promise<DashboardContext> => {
  const db = await createDashboardClient();
  if (!db) redirect("/login?error=not_configured");
  const { data } = await db.auth.getUser();
  const user = data.user;
  if (!user) redirect("/login");
  const tenants = await listMemberships(db, user.id);
  const tenant = pickTenant(tenants, (await cookies()).get(TENANT_COOKIE)?.value);
  if (!tenant) redirect("/login?error=no_access");
  return { db, userEmail: user.email ?? "", tenant, tenants };
});
