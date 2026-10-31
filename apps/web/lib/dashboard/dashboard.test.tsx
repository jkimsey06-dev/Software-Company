import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LeadDetail } from "../../app/dashboard/lead-detail";
import { LeadList } from "../../app/dashboard/lead-list";
import { parseEmail, parseTokenHash, sameOrigin } from "./auth-routes";
import type { ConversationInfo, LeadRow } from "./data";
import { formatWhen, parsePage, parseStatusFilter, serviceName, telHref, tenantTimezone } from "./format";
import { pickTenant, type Membership } from "./tenant";
import { buildThread } from "./thread";

const config = { timezone: "America/New_York", services: [{ id: "ac-repair", name: "AC repair" }] };
const lead = (over: Partial<LeadRow> = {}): LeadRow => ({
  id: "10000000-0000-4000-8000-000000000001",
  phone: "+14235550111",
  name: null,
  service_id: "ac-repair",
  area: "Cleveland",
  urgency: "soon",
  status: "new",
  source: "missed_call",
  notes: null,
  address: null,
  created_at: "2026-10-30T18:15:00Z",
  ...over,
});
const conv = (over: Partial<ConversationInfo> = {}): ConversationInfo => ({
  lead_id: "10000000-0000-4000-8000-000000000001",
  status: "completed",
  stage: "booked",
  chosen_slot: "2026-11-02T13:00:00Z",
  handoff_reason: null,
  address: "123 Main St",
  created_at: "2026-10-30T18:20:00Z",
  ...over,
});

describe("params", () => {
  it("accepts only known statuses and sane page numbers", () => {
    expect(parseStatusFilter("won")).toBe("won");
    expect(parseStatusFilter("won' or 1=1")).toBeNull();
    expect(parseStatusFilter(undefined)).toBeNull();
    expect(parsePage("3")).toBe(3);
    expect(parsePage("-1")).toBe(1);
    expect(parsePage("99999999")).toBe(1);
    expect(parsePage("abc")).toBe(1);
  });

  it("only valid phone numbers become tel links", () => {
    expect(telHref("+14235550111")).toBe("tel:+14235550111");
    expect(telHref("javascript:alert(1)")).toBeNull();
  });

  it("reads tenant config defensively", () => {
    expect(tenantTimezone({ timezone: "Nope/Zone" })).toBe("America/New_York");
    expect(tenantTimezone(null)).toBe("America/New_York");
    expect(tenantTimezone({ timezone: "America/Chicago" })).toBe("America/Chicago");
    expect(serviceName(config, "ac-repair")).toBe("AC repair");
    expect(serviceName(config, "gone")).toBe("gone");
    expect(serviceName({ services: "x" }, "a")).toBe("a");
    expect(formatWhen("2026-10-30T18:15:00Z", "America/New_York")).toBe("Oct 30, 2:15 PM");
    expect(formatWhen("garbage", "America/New_York")).toBe("");
  });
});

describe("tenant choice", () => {
  const m = (tenantId: string, name: string): Membership => ({ tenantId, name, role: "owner", config: {} });
  it("uses the cookie only if the user still belongs to that business", () => {
    const list = [m("b", "Bravo"), m("a", "Alpha")];
    expect(pickTenant(list, "b")?.tenantId).toBe("b");
    expect(pickTenant(list, "someone-elses")?.tenantId).toBe("a");
    expect(pickTenant(list, undefined)?.tenantId).toBe("a");
    expect(pickTenant([], "a")).toBeNull();
  });
});

describe("thread", () => {
  it("merges both directions oldest first and flags undelivered texts", () => {
    const t = buildThread(
      [{ body: "AC repair", keyword: null, created_at: "2026-10-30T18:16:00Z" }],
      [
        { body: "Sorry we missed you", status: "sent", created_at: "2026-10-30T18:15:30Z" },
        { body: "Which area?", status: "failed", created_at: "2026-10-30T18:17:00Z" },
      ],
    );
    expect(t.map((x) => x.text)).toEqual(["Sorry we missed you", "AC repair", "Which area?"]);
    expect(t[2]?.note).toBe("Not delivered");
    expect(t[0]?.note).toBeUndefined();
  });
});

describe("login helpers", () => {
  it("validates email and token shapes", () => {
    expect(parseEmail("  Owner@Example.com ")).toBe("owner@example.com");
    expect(parseEmail("not an email")).toBeNull();
    expect(parseEmail(null)).toBeNull();
    expect(parseEmail("a".repeat(300) + "@example.com")).toBeNull();
    expect(parseTokenHash("abcDEF12_-xyz890")).toBe("abcDEF12_-xyz890");
    expect(parseTokenHash('"><script>')).toBeNull();
    expect(parseTokenHash(null)).toBeNull();
  });

  it("accepts POSTs only from the same origin", () => {
    const req = (origin?: string) => new Request("https://app.example.com/auth/signout", { method: "POST", headers: origin ? { origin } : {} });
    expect(sameOrigin(req("https://app.example.com"))).toBe(true);
    expect(sameOrigin(req("https://evil.example.com"))).toBe(false);
    expect(sameOrigin(req())).toBe(false);
  });
});

describe("lead list", () => {
  const render = (over: Partial<Parameters<typeof LeadList>[0]> = {}) =>
    renderToStaticMarkup(
      <LeadList leads={[lead()]} conversations={new Map()} config={config} timezone="America/New_York" status={null} page={1} hasNext={false} {...over} />,
    );

  it("shows the lead, and a booked estimate and needs-you flag", () => {
    const html = render({
      leads: [lead(), lead({ id: "10000000-0000-4000-8000-000000000002", urgency: "emergency" })],
      conversations: new Map([
        ["10000000-0000-4000-8000-000000000001", conv()],
        ["10000000-0000-4000-8000-000000000002", conv({ lead_id: "10000000-0000-4000-8000-000000000002", stage: "qualifying", status: "handed_off" })],
      ]),
    });
    expect(html).toContain("(423) 555-0111");
    expect(html).toContain("AC repair");
    expect(html).toContain("Estimate Mon, Nov 2, 8:00 AM");
    expect(html).toContain("Needs you");
    expect(html).toContain("Emergency");
    expect(html).toContain('href="/dashboard/leads/10000000-0000-4000-8000-000000000001"');
  });

  it("explains an empty list and links the pages", () => {
    expect(render({ leads: [] })).toContain("No leads yet");
    expect(render({ leads: [], status: "won" })).toContain("No won leads");
    const html = render({ page: 2, hasNext: true, status: "new" });
    expect(html).toContain('href="/dashboard?status=new"');
    expect(html).toContain('href="/dashboard?status=new&amp;page=3"');
  });
});

describe("lead detail", () => {
  it("shows customer text as plain text, never as markup or links", () => {
    const hostile = `<img src=x onerror=alert(1)> <script>alert(2)</script> https://evil.example`;
    const html = renderToStaticMarkup(
      <LeadDetail
        lead={lead({ notes: hostile, area: hostile, address: hostile })}
        conversation={conv()}
        thread={buildThread([{ body: hostile, keyword: null, created_at: "2026-10-30T18:16:00Z" }], [])}
        config={config}
        timezone="America/New_York"
      />,
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('href="https://evil');
  });

  it("shows the booking, the call link, and why the lead needs you", () => {
    const html = renderToStaticMarkup(
      <LeadDetail lead={lead()} conversation={conv({ status: "handed_off", handoff_reason: "wants_human", stage: "booked" })} thread={[]} config={config} timezone="America/New_York" />,
    );
    expect(html).toContain('href="tel:+14235550111"');
    expect(html).toContain("Mon, Nov 2, 8:00 AM");
    expect(html).toContain("123 Main St");
    expect(html).toContain("They asked to talk to a person.");
    expect(html).toContain("No texts yet");
  });
});
