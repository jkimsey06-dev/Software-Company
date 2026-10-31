import { sameOrigin } from "../../../../../lib/dashboard/auth-routes";
import { parseLeadEdit } from "../../../../../lib/dashboard/edit";
import { getContext } from "../../../../../lib/dashboard/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /dashboard/leads/:id/update  Saves the owner's edits. It runs as the
// signed-in owner, so row-level security and column grants decide what is
// allowed; the tenant filter is a second check.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!sameOrigin(request)) return new Response("Forbidden", { status: 403 });
  const { id } = await params;
  if (!UUID.test(id)) return new Response("Not found", { status: 404 });
  const { db, tenant } = await getContext();
  const back = (q: string) => Response.redirect(new URL(`/dashboard/leads/${id}?${q}`, request.url), 303);

  const edit = parseLeadEdit(await request.formData());
  if (!edit) return back("error=invalid");

  const update: Record<string, string | null> = { name: edit.name, address: edit.address, notes: edit.notes };
  if (edit.status) update.status = edit.status;
  const { data, error } = await db.from("leads").update(update).eq("tenant_id", tenant.tenantId).eq("id", id).select("id");
  if (error) return back("error=save");
  if (!data?.length) return new Response("Not found", { status: 404 });
  return back("saved=1");
}
