import { getCalendarStatus } from "../../../lib/dashboard/data";
import { formatWhen, tenantTimezone } from "../../../lib/dashboard/format";
import { getContext } from "../../../lib/dashboard/server";

// Always rendered per request: it shows the signed-in owner's data.
export const dynamic = "force-dynamic";

export default async function Settings() {
  const { db, tenant } = await getContext();
  const calendar = await getCalendarStatus(db, tenant.tenantId);
  const tz = tenantTimezone(tenant.config);
  return (
    <main className="page wide">
      <h1>Settings</h1>
      <section className="panel">
        <h2>Google Calendar</h2>
        {calendar?.status === "connected" && (
          <p>Connected since {formatWhen(calendar.connected_at, tz)}. Customers can pick estimate times, and booked estimates land on your calendar.</p>
        )}
        {calendar?.status === "revoked" && (
          <p className="notice">The connection stopped working (access was removed or expired). Customers aren&apos;t being offered times. Ask us for a new connect link.</p>
        )}
        {!calendar && <p>Not connected. Customers are told you&apos;ll reach out to set up a time. Ask us for a connect link to turn on booking.</p>}
      </section>
    </main>
  );
}
