import type { SupabaseClient } from "@supabase/supabase-js";
import { PAGE_SIZE, type LeadStatus } from "./format";
import { buildThread, type InboundRow, type OutboundRow, type ThreadItem } from "./thread";

// Every query names the tenant as well as relying on row-level security.

export interface LeadRow {
  id: string;
  phone: string;
  name: string | null;
  service_id: string | null;
  area: string | null;
  urgency: string;
  status: string;
  source: string;
  notes: string | null;
  address: string | null;
  created_at: string;
}

export interface ConversationInfo {
  lead_id: string;
  status: string;
  stage: string;
  chosen_slot: string | null;
  handoff_reason: string | null;
  address: string | null;
  created_at: string;
}

const LEAD_COLUMNS = "id, phone, name, service_id, area, urgency, status, source, notes, address, created_at";
const CONVERSATION_COLUMNS = "lead_id, status, stage, chosen_slot, handoff_reason, address, created_at";

function ok<T>(res: { data: T | null; error: unknown }, what: string): T {
  if (res.error || res.data === null) throw new Error(`could not load ${what}`);
  return res.data;
}

// For maybeSingle(): no row is fine, an error is not.
function okOrNull<T>(res: { data: T | null; error: unknown }, what: string): T | null {
  if (res.error) throw new Error(`could not load ${what}`);
  return res.data;
}

// Newest conversation per lead.
function latestByLead(rows: ConversationInfo[]): Map<string, ConversationInfo> {
  const map = new Map<string, ConversationInfo>();
  for (const r of [...rows].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))) {
    if (!map.has(r.lead_id)) map.set(r.lead_id, r);
  }
  return map;
}

export async function listLeads(
  db: SupabaseClient,
  tenantId: string,
  opts: { status: LeadStatus | null; page: number },
): Promise<{ leads: LeadRow[]; conversations: Map<string, ConversationInfo>; hasNext: boolean }> {
  const from = (opts.page - 1) * PAGE_SIZE;
  let q = db.from("leads").select(LEAD_COLUMNS).eq("tenant_id", tenantId);
  if (opts.status) q = q.eq("status", opts.status);
  const rows = ok(await q.order("created_at", { ascending: false }).range(from, from + PAGE_SIZE), "leads") as LeadRow[];
  const leads = rows.slice(0, PAGE_SIZE);
  const ids = leads.map((l) => l.id);
  const conversations = ids.length
    ? latestByLead(
        ok(
          await db.from("conversations").select(CONVERSATION_COLUMNS).eq("tenant_id", tenantId).in("lead_id", ids),
          "conversations",
        ) as ConversationInfo[],
      )
    : new Map<string, ConversationInfo>();
  return { leads, conversations, hasNext: rows.length > PAGE_SIZE };
}

export async function getLeadDetail(
  db: SupabaseClient,
  tenantId: string,
  leadId: string,
): Promise<{ lead: LeadRow; conversation: ConversationInfo | null; thread: ThreadItem[] } | null> {
  const lead = okOrNull(await db.from("leads").select(LEAD_COLUMNS).eq("tenant_id", tenantId).eq("id", leadId).maybeSingle(), "lead") as LeadRow | null;
  if (!lead) return null;
  const [inbound, outbound, conversations] = await Promise.all([
    db.from("inbound_messages").select("body, keyword, created_at").eq("tenant_id", tenantId).eq("lead_id", leadId).order("created_at").limit(300),
    db.from("outbound_messages").select("body, status, created_at").eq("tenant_id", tenantId).eq("lead_id", leadId).order("created_at").limit(300),
    db.from("conversations").select(CONVERSATION_COLUMNS).eq("tenant_id", tenantId).eq("lead_id", leadId),
  ]);
  return {
    lead,
    conversation: latestByLead(ok(conversations, "conversation") as ConversationInfo[]).get(leadId) ?? null,
    thread: buildThread(ok(inbound, "messages") as InboundRow[], ok(outbound, "messages") as OutboundRow[]),
  };
}

export async function getCalendarStatus(
  db: SupabaseClient,
  tenantId: string,
): Promise<{ status: "connected" | "revoked"; connected_at: string } | null> {
  const res = await db.from("calendar_connections").select("status, connected_at").eq("tenant_id", tenantId).maybeSingle();
  return okOrNull(res, "calendar status") as { status: "connected" | "revoked"; connected_at: string } | null;
}
