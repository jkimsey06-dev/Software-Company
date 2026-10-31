import type { ReactNode } from "react";
import { getContext } from "../../lib/dashboard/server";
import { SITE } from "../../lib/site";

export const metadata = { title: `Dashboard · ${SITE.productName}`, robots: { index: false } };

// Always rendered per request: it shows the signed-in owner's data.
export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const { tenant, tenants, userEmail } = await getContext();
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <strong>{tenant.name}</strong>
          <nav>
            <a href="/dashboard">Leads</a>
            <a href="/dashboard/settings">Settings</a>
          </nav>
          <div className="topbar-right">
            {tenants.length > 1 && (
              <form method="post" action="/dashboard/switch" className="inline">
                <select name="tenant" defaultValue={tenant.tenantId} aria-label="Business">
                  {tenants.map((t) => (
                    <option key={t.tenantId} value={t.tenantId}>{t.name}</option>
                  ))}
                </select>
                <button type="submit">Switch</button>
              </form>
            )}
            <span className="muted">{userEmail}</span>
            <form method="post" action="/auth/signout" className="inline">
              <button type="submit" className="link">Sign out</button>
            </form>
          </div>
        </div>
      </header>
      {children}
    </>
  );
}
