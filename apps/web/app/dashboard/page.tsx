import { listLeads } from "../../lib/dashboard/data";
import { LeadList } from "./lead-list";
import { parsePage, parseStatusFilter, tenantTimezone } from "../../lib/dashboard/format";
import { getContext } from "../../lib/dashboard/server";

// Always rendered per request: it shows the signed-in owner's data.
export const dynamic = "force-dynamic";

export default async function Dashboard({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { db, tenant } = await getContext();
  const status = parseStatusFilter(params.status);
  const page = parsePage(params.page);
  const data = await listLeads(db, tenant.tenantId, { status, page });
  return <LeadList {...data} config={tenant.config} timezone={tenantTimezone(tenant.config)} status={status} page={page} />;
}
