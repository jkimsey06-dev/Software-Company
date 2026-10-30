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

const STREET_WORDS =
  "st|street|rd|road|ave|avenue|dr|drive|ln|lane|ct|court|blvd|boulevard|way|pl|place|cir|circle|pkwy|parkway|hwy|highway|trl|trail|ter|terrace|pike|loop|run|pt|point|sq|square|row|path|cv|cove|bnd|bend|ridge|rdg|holw|hollow|xing|crossing|route|rte|county road|cr|lp|walk|alley|aly|fwy|freeway|tpke|turnpike|byp|bypass|mtn|mountain|vw|view|hts|heights|est|estates|cres|crescent|grv|grove|hl|hill|pass|spur|trce|trace";
// House number (optionally with a grid prefix like N1234), then a street that
// ends in a street word or a numbered road ("Hwy 64", "County Rd 5"). After
// it, only a unit and a city/state/ZIP: no free text ("gate code, prepaid...")
// rides along onto the owner's calendar.
const UNIT = String.raw`(?:,? (?:apt|unit|ste|suite|lot|#) ?#?[a-z0-9-]{1,6})?`;
// City: up to three words ("Signal Mountain", "Lookout Mountain TN").
const PLACE = String.raw`(?:,? [a-z][a-z.'-]{1,19}(?: [a-z][a-z.'-]{1,19}){0,2}?(?:,? [a-z]{2})?(?:,? \d{5}(?:-\d{4})?)?)?`;
const STREET_ADDRESS = new RegExp(
  `^[nsew]?\\d{1,6}[a-z]?(?:-\\d{1,4})? (?:[a-z0-9.'-]+ ){0,5}(?:${STREET_WORDS})\\.?(?: \\d{1,4}[a-z]?)?${UNIT}${PLACE}\\.?$`,
);
const RURAL_ROUTE = new RegExp(String.raw`^(?:rr|rural route|hc|highway contract) ?\d{1,4},? box \d{1,6}${PLACE}\.?$`);
const PO_BOX = /\bp\.? ?o\.? ?box\b|\bpost office box\b/;
const LINK = /https?:|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|us|biz|info|me|ly|app)\b/;
const PHONE = /\d[\d ().-]{8,}\d/;

// A street address the customer gave, or null. It goes on the owner's calendar
// event and the lead, so it must look like a place an estimate can happen:
// a house number and a street (or a rural route), no PO boxes, links or phone
// numbers. Safe characters only, short.
export function cleanAddress(address: string | null): string | null {
  if (!address) return null;
  const cleaned = address
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} ,.#'-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
  const t = cleaned.toLowerCase();
  if (PO_BOX.test(t) || LINK.test(t) || PHONE.test(t)) return null;
  return STREET_ADDRESS.test(t) || RURAL_ROUTE.test(t) ? cleaned : null;
}

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };

// "2", "#2", "option #2", "2.", "the 2nd one", "two", "2️⃣" -> 2. Anything else: null.
export function parseSlotNumber(text: string, count: number): number | null {
  const t = text
    .normalize("NFKC")
    .replace(/[\uFE0F\u20E3]/g, "")
    .toLowerCase()
    .trim();
  const m =
    /^(?:the )?(?:(?:option|number|choice|no\.?)\s*)?#?\s*([1-9]|one|two|three|four|five|first|second|third|fourth|fifth)(?:st|nd|rd|th)?(?:\s*(?:one|option|please|pls|works|is good|is fine|thanks?|ty))?\s*[.!)]*$/.exec(t);
  if (!m) return null;
  const raw = m[1] as string;
  const n = WORD_NUMBERS[raw] ?? Number(raw);
  return n >= 1 && n <= count ? n : null;
}
