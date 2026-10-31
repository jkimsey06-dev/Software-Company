export interface InboundRow {
  body: string;
  keyword: string | null;
  created_at: string;
}

export interface OutboundRow {
  body: string;
  status: string;
  created_at: string;
}

export interface ThreadItem {
  from: "customer" | "business";
  text: string;
  at: string;
  // e.g. "Not delivered"; only on our texts.
  note?: string;
  keyword?: string;
}

const OUTBOUND_NOTES: Record<string, string> = {
  pending: "Sending",
  failed: "Not delivered",
  unknown: "Delivery unconfirmed",
};

// The customer's texts and ours, oldest first. Text is data: it's shown as
// plain text and never interpreted.
export function buildThread(inbound: InboundRow[], outbound: OutboundRow[]): ThreadItem[] {
  const items: ThreadItem[] = [
    ...inbound.map((m) => ({ from: "customer" as const, text: m.body, at: m.created_at, keyword: m.keyword ?? undefined })),
    ...outbound.map((m) => ({ from: "business" as const, text: m.body, at: m.created_at, note: OUTBOUND_NOTES[m.status] })),
  ];
  return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
