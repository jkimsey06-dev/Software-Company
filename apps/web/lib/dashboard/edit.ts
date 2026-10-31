import { z } from "zod";
import { LEAD_STATUSES, type LeadStatus } from "./format";

export interface LeadEdit {
  // Null means "leave the status alone" (the owner didn't change it).
  status: LeadStatus | null;
  name: string | null;
  address: string | null;
  notes: string | null;
}

// Control characters (including NUL, which Postgres can't store) are dropped;
// line breaks are kept in notes.
function clean(value: string, keepNewlines: boolean): string {
  const text = value.normalize("NFKC").replace(/\r\n?/g, "\n");
  const stripped = keepNewlines
    ? text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    : text.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/ {2,}/g, " ");
  return stripped.trim();
}

const text = (max: number) => z.string().max(max * 4);

const schema = z.object({
  status: z.enum(LEAD_STATUSES),
  was_status: z.enum(LEAD_STATUSES),
  name: text(120),
  address: text(200),
  notes: text(4000),
});

// What the owner submitted, checked and cleaned. Anything unexpected is
// refused rather than guessed at. The status is only changed if the owner
// changed it: the system may have marked the lead "booked" while the form
// was open, and saving a note must not undo that.
export function parseLeadEdit(form: FormData): LeadEdit | null {
  const get = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };
  const parsed = schema.safeParse({
    status: get("status"),
    was_status: get("was_status"),
    name: get("name"),
    address: get("address"),
    notes: get("notes"),
  });
  if (!parsed.success) return null;
  const d = parsed.data;
  const name = clean(d.name, false);
  const address = clean(d.address, false);
  const notes = clean(d.notes, true);
  if (name.length > 120 || address.length > 200 || notes.length > 4000) return null;
  return {
    status: d.status === d.was_status ? null : d.status,
    name: name || null,
    address: address || null,
    notes: notes || null,
  };
}
