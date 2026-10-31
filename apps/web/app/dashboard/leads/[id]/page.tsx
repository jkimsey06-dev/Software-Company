import { notFound } from "next/navigation";
import { getLeadDetail } from "../../../../lib/dashboard/data";
import { tenantTimezone } from "../../../../lib/dashboard/format";
import { getContext } from "../../../../lib/dashboard/server";
import { LeadDetail } from "../../lead-detail";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Always rendered per request: it shows the signed-in owner's data.
export const dynamic = "force-dynamic";

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { db, tenant } = await getContext();
  const detail = await getLeadDetail(db, tenant.tenantId, id);
  if (!detail) notFound();
  return <LeadDetail {...detail} config={tenant.config} timezone={tenantTimezone(tenant.config)} />;
}
