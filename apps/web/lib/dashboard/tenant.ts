export interface Membership {
  tenantId: string;
  name: string;
  role: "owner" | "staff";
  config: unknown;
}

export const TENANT_COOKIE = "sc_tenant";

// The business shown: the one in the cookie if the user still belongs to it,
// otherwise the first by name. The cookie is only a preference; membership is
// always re-read from the database.
export function pickTenant(memberships: Membership[], cookieValue: string | undefined): Membership | null {
  if (!memberships.length) return null;
  const sorted = [...memberships].sort((a, b) => a.name.localeCompare(b.name));
  return sorted.find((m) => m.tenantId === cookieValue) ?? sorted[0] ?? null;
}
