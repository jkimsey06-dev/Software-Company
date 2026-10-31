// Adds a person to a business so they can sign in to the dashboard.
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     pnpm --filter @sc/web owner:add <tenant-id> <email> [owner|staff] [--apply]
//
// Without --apply it only shows what it would do. With --apply it creates the
// login if needed and adds the membership. It sends NO email: tell the person
// to go to <app>/login and ask for a link. Run it against dev unless you mean
// otherwise: it shows which project it is talking to first.
import { createClient } from "@supabase/supabase-js";
import { addOwner, parseAddOwnerArgs, type OwnerAdmin } from "../lib/dashboard/add-owner.ts";

const args = parseAddOwnerArgs(process.argv.slice(2));
if (!args) {
  console.error("Usage: owner:add <tenant-id (uuid)> <email> [owner|staff] [--apply]");
  process.exit(1);
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const admin: OwnerAdmin = {
  async tenantName(id) {
    const { data, error } = await db.from("tenants").select("name").eq("id", id).maybeSingle();
    if (error) throw new Error("Could not look up the business.");
    return (data as { name: string } | null)?.name ?? null;
  },
  async findUserId(email) {
    for (let page = 1; page <= 50; page++) {
      const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw new Error("Could not look up users.");
      const hit = data.users.find((u) => u.email?.toLowerCase() === email);
      if (hit) return hit.id;
      if (data.users.length < 200) return null;
    }
    return null;
  },
  async createUser(email) {
    const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true });
    if (error || !data.user) throw new Error("Could not create the login.");
    return data.user.id;
  },
  async addMember(tenantId, userId, role) {
    const { error } = await db.from("tenant_members").insert({ tenant_id: tenantId, user_id: userId, role });
    if (error?.code === "23505") return "exists";
    if (error) throw new Error("Could not add the membership.");
    return "added";
  },
};

console.log(`Project: ${new URL(url).host}`);
try {
  const r = await addOwner(admin, args);
  console.log(`Business: ${r.tenantName}`);
  if (!r.applied) {
    console.log(`${args.email}: ${r.userExists ? "already has a login" : "would get a new login"}, would be added as ${args.role}.`);
    console.log("Nothing changed. Run again with --apply to do it.");
  } else {
    console.log(`${args.email}: ${r.userExists ? "existing login" : "login created"}, ${r.alreadyMember ? "was already a member" : `added as ${args.role}`}.`);
    console.log("No email was sent. Tell them to open /login on the app and ask for a link.");
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : "Failed.");
  process.exit(1);
}
