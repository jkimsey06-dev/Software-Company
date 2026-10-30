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

// A street address the customer gave: safe characters only, short, and it must
// look like an address (a house number and a word).
export function cleanAddress(address: string | null): string | null {
  if (!address) return null;
  const cleaned = address
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} ,.#'/-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
  return /\d/.test(cleaned) && /\p{L}{2,}/u.test(cleaned) ? cleaned : null;
}

// "2", "#2", "option 2", "2.", "the 2nd one" -> 2. Anything else: null.
export function parseSlotNumber(text: string, count: number): number | null {
  const t = text.normalize("NFKC").toLowerCase().trim();
  const m = /^(?:(?:option|number|#|no\.?)\s*)?([1-9])(?:st|nd|rd|th)?(?:\s*(?:one|please|pls|works|is good|thanks?|ty))?\s*[.!)]*$/.exec(t);
  const n = m ? Number(m[1]) : null;
  return n !== null && n >= 1 && n <= count ? n : null;
}
