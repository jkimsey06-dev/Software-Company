import type { ConversationInfo, LeadRow } from "../../lib/dashboard/data";
import { LEAD_STATUSES, formatEstimate, formatWhen, serviceName, statusLabel, telHref, urgencyLabel } from "../../lib/dashboard/format";
import type { ThreadItem } from "../../lib/dashboard/thread";
import { formatPhone, reasonLine } from "../../lib/notifications/templates";

interface Props {
  lead: LeadRow;
  conversation: ConversationInfo | null;
  thread: ThreadItem[];
  config: unknown;
  timezone: string;
  notice?: "saved" | "invalid" | "save";
}

const NOTICES = {
  saved: "Saved.",
  invalid: "Those changes couldn't be saved. Check the lengths and try again.",
  save: "Something went wrong saving. Please try again.",
};

export function LeadDetail({ lead, conversation, thread, config, timezone, notice }: Props) {
  const tel = telHref(lead.phone);
  const booked = conversation?.stage === "booked" && conversation.chosen_slot ? formatEstimate(conversation.chosen_slot, timezone) : null;
  const address = lead.address || conversation?.address || null;
  const needsYou = conversation?.status === "handed_off";
  const why = needsYou && conversation?.handoff_reason ? reasonLine(conversation.handoff_reason) : "";
  return (
    <main className="page wide">
      <p><a href="/dashboard">← All leads</a></p>
      <h1>{lead.name || formatPhone(lead.phone)}</h1>
      <div className="badges">
        <span className={`badge status-${lead.status}`}>{statusLabel(lead.status)}</span>
        {lead.urgency === "emergency" && <span className="badge urgent">Emergency</span>}
        {needsYou && <span className="badge needs">Needs you</span>}
      </div>
      {why && <p className="notice">{why}</p>}
      {notice && <p className={notice === "saved" ? "notice ok" : "notice"} role="status">{NOTICES[notice]}</p>}

      {tel && (
        <p>
          <a className="button" href={tel}>Call {formatPhone(lead.phone)}</a>
        </p>
      )}

      {booked && (
        <section className="panel">
          <h2>Estimate booked</h2>
          <p>{booked}. It&apos;s on your calendar.</p>
          {address && <p>Address (as they wrote it): <span className="text">{address}</span></p>}
        </section>
      )}

      <section className="panel">
        <h2>Details</h2>
        <dl>
          <dt>Service</dt><dd>{serviceName(config, lead.service_id)}</dd>
          <dt>Area (as they wrote it)</dt><dd className="text">{lead.area || "Not given yet"}</dd>
          <dt>Urgency</dt><dd>{urgencyLabel(lead.urgency)}</dd>
          {!booked && address && (<><dt>Address (as they wrote it)</dt><dd className="text">{address}</dd></>)}
          <dt>Phone</dt><dd>{formatPhone(lead.phone)}</dd>
          <dt>First contact</dt><dd>{formatWhen(lead.created_at, timezone)}</dd>
          {lead.notes && (<><dt>Notes</dt><dd className="text">{lead.notes}</dd></>)}
        </dl>
      </section>

      <section className="panel">
        <h2>Edit</h2>
        <form method="post" action={`/dashboard/leads/${lead.id}/update`} className="stack">
          <input type="hidden" name="was_status" value={lead.status} />
          <label htmlFor="status">Status</label>
          <select id="status" name="status" defaultValue={lead.status}>
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>{statusLabel(s)}</option>
            ))}
          </select>
          <label htmlFor="name">Name</label>
          <input id="name" name="name" defaultValue={lead.name ?? ""} maxLength={120} autoComplete="off" />
          <label htmlFor="address">Address</label>
          <input id="address" name="address" defaultValue={lead.address ?? ""} maxLength={200} autoComplete="off" />
          <label htmlFor="notes">Notes (only you see these)</label>
          <textarea id="notes" name="notes" defaultValue={lead.notes ?? ""} maxLength={4000} rows={4} />
          <button type="submit">Save</button>
        </form>
      </section>

      <section className="panel">
        <h2>Texts</h2>
        {thread.length === 0 ? (
          <p className="muted">No texts yet.</p>
        ) : (
          <ol className="thread">
            {thread.map((m, i) => (
              <li key={i} className={m.from}>
                <div className="meta">
                  {m.from === "customer" ? "Customer" : "Assistant"} · {formatWhen(m.at, timezone)}
                  {m.keyword ? ` · ${m.keyword.toUpperCase()}` : ""}
                  {m.note ? ` · ${m.note}` : ""}
                </div>
                <div className="text bubble">{m.text}</div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
