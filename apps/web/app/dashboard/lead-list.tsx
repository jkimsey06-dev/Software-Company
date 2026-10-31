import type { ConversationInfo, LeadRow } from "../../lib/dashboard/data";
import { LEAD_STATUSES, formatEstimate, formatWhen, serviceName, statusLabel, urgencyLabel, type LeadStatus } from "../../lib/dashboard/format";
import { formatPhone } from "../../lib/notifications/templates";

interface Props {
  leads: LeadRow[];
  conversations: Map<string, ConversationInfo>;
  config: unknown;
  timezone: string;
  status: LeadStatus | null;
  page: number;
  hasNext: boolean;
}

function href(status: LeadStatus | null, page: number): string {
  const q = new URLSearchParams();
  if (status) q.set("status", status);
  if (page > 1) q.set("page", String(page));
  const s = q.toString();
  return s ? `/dashboard?${s}` : "/dashboard";
}

export function LeadList({ leads, conversations, config, timezone, status, page, hasNext }: Props) {
  return (
    <main className="page wide">
      <h1>Leads</h1>
      <nav className="chips" aria-label="Filter by status">
        <a href={href(null, 1)} aria-current={status === null ? "page" : undefined}>All</a>
        {LEAD_STATUSES.map((s) => (
          <a key={s} href={href(s, 1)} aria-current={status === s ? "page" : undefined}>{statusLabel(s)}</a>
        ))}
      </nav>

      {leads.length === 0 ? (
        <p className="muted">{status ? `No ${statusLabel(status).toLowerCase()} leads.` : "No leads yet. They show up here when someone calls and isn't answered."}</p>
      ) : (
        <ul className="cards">
          {leads.map((lead) => {
            const conv = conversations.get(lead.id);
            const booked = conv?.stage === "booked" && conv.chosen_slot ? formatEstimate(conv.chosen_slot, timezone) : null;
            return (
              <li key={lead.id}>
                <a href={`/dashboard/leads/${lead.id}`} className="card">
                  <div className="card-top">
                    <strong>{lead.name || formatPhone(lead.phone)}</strong>
                    <span className="muted">{formatWhen(lead.created_at, timezone)}</span>
                  </div>
                  <div>
                    {serviceName(config, lead.service_id)} · {lead.area || "Area not given yet"}
                  </div>
                  <div className="badges">
                    <span className={`badge status-${lead.status}`}>{statusLabel(lead.status)}</span>
                    {lead.urgency === "emergency" && <span className="badge urgent">Emergency</span>}
                    {lead.urgency !== "emergency" && lead.urgency !== "unknown" && <span className="badge">{urgencyLabel(lead.urgency)}</span>}
                    {booked && <span className="badge booked">Estimate {booked}</span>}
                    {conv?.status === "handed_off" && <span className="badge needs">Needs you</span>}
                  </div>
                </a>
              </li>
            );
          })}
        </ul>
      )}

      <nav className="pager" aria-label="Pages">
        {page > 1 && <a href={href(status, page - 1)}>← Newer</a>}
        {hasNext && <a href={href(status, page + 1)}>Older →</a>}
      </nav>
    </main>
  );
}
