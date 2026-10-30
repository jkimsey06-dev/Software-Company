// Checks every model-written text before it can be sent. Anything that might
// promise a price, a time, a warranty or availability, or pretend to be a
// person, is blocked; the caller sends a fixed message and hands off instead.

export const MAX_REPLY_CHARS = 320;

const RULES: { name: string; re: RegExp }[] = [
  { name: "price", re: /\$|\b\d+\s*(dollars?|bucks|usd)\b|\b\d+\s*%|\bpercent\b/i },
  { name: "price_promise", re: /\b(discount|coupon|promo|free|no charge|no cost|waive[ds]?|cheap(er|est)?|special offer|deal)\b/i },
  { name: "warranty", re: /\b(warrant(y|ies|ied)|guarantee[ds]?|guaranteed)\b/i },
  { name: "clock_time", re: /\b\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)\b|\b\d{1,2}:\d{2}\b|\b(noon|midnight)\b/i },
  { name: "time_window", re: /\bwithin (the )?(\d+|an?|one|two|few|next)\s*(minutes?|mins?|hours?|hrs?|days?)\b/i },
  {
    name: "arrival_promise",
    re: /\b(we|i|someone|somebody|a tech(nician)?|they|he|she)('ll| will| can| could| are able to| am able to)? (be there|come (out|by|over)|stop by|arrive|get there|send (someone|a tech))\b.*\b(today|tonight|tomorrow|this (morning|afternoon|evening|week)|asap|right away|soon|now)\b|\bon (our|the|my|his|her|their) way\b/i,
  },
  { name: "availability", re: /\b(we('re| are) (available|open|free)|have (an )?(opening|availability|slot)|can fit you in|(book|schedule)d? you (for|at|on))\b/i },
  { name: "claims_human", re: /\b(i'?m|i am) (a |an )?(real |actual )?(person|human|technician|tech|owner|employee)\b|\bnot (a |an )?(bot|robot|ai)\b/i },
  { name: "link", re: /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|co|us|biz|info)\b/i },
  { name: "phone_number", re: /\+?\d[\d\s().-]{8,}\d/ },
  { name: "markup", re: /[<>]|\*\*|```/ },
];

export interface GuardResult {
  ok: boolean;
  violations: string[];
}

export function checkReply(text: string): GuardResult {
  const violations: string[] = [];
  const trimmed = text.trim();
  if (trimmed.length === 0) violations.push("empty");
  if (Array.from(trimmed).length > MAX_REPLY_CHARS) violations.push("too_long");
  for (const rule of RULES) if (rule.re.test(trimmed)) violations.push(rule.name);
  return { ok: violations.length === 0, violations };
}
