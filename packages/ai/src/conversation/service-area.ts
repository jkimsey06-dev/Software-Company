import type { TenantConfig } from "@sc/shared";

// Decided in code from the tenant's config, never by the model.
// true: a listed ZIP or city. false: a ZIP or city that isn't listed.
// null: can't tell (nothing usable given).
export function inServiceArea(config: TenantConfig, area: string | null): boolean | null {
  if (!area) return null;
  const text = area.toLowerCase();
  const zips = text.match(/\b\d{5}\b/g);
  if (zips?.length) return zips.some((z) => config.serviceArea.zipCodes.includes(z));
  const cities = config.serviceArea.cities.map((c) => c.toLowerCase());
  if (cities.some((c) => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text))) return true;
  return /[a-z]{3,}/.test(text) ? false : null;
}

// Keeps what the model reported as the area to something safe to store and
// show: letters, digits, spaces and basic punctuation, short.
export function cleanArea(area: string | null): string | null {
  if (!area) return null;
  const cleaned = area
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} ,.'-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return cleaned || null;
}
