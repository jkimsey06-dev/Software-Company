// Deterministic emergency check. Runs before any model, so an emergency is
// never missed because a model was down or wrong. Biased toward safety: a
// false alarm costs a fixed safety text and an owner call; a miss could cost
// much more.

const ALWAYS: RegExp[] = [
  /\b(smell(s|ing)?|smelled) (of |like )?(gas|propane|rotten eggs?)\b/,
  /\bgas (smell|leak|leaking|odor|odour)\b/,
  /\b(leak(ing)?|hiss(ing)?) gas\b/,
  /\bcarbon monoxide\b/,
  /\b(co|carbon) (alarm|detector)\b/,
  /\b(smoke|smoking|flames?|on fire|caught fire|fire)\b/,
  /\b(burning (smell|plastic|rubber)|smell(s|ing)? (like )?burning)\b/,
  /\b(spark(s|ing)?|arc(ing)?|electrical fire)\b/,
  /\b(electrocut\w*|got shocked|getting shocked|shock(ed)? me)\b/,
  /\b(exposed|live|bare|hot) wires?\b/,
  /\b(flood(ed|ing)?|water everywhere|burst pipe|pipe burst|pipe (broke|exploded))\b/,
  /\bwater (near|on|in|by) (the )?(panel|breaker|outlet|electrical|wires?)\b/,
  /\b(can'?t breathe|chest pain|passed out|unconscious|ambulance|911)\b/,
];

// No heat or no AC is an emergency only with someone vulnerable at home.
const NO_CLIMATE = /\b(no|not any|without|lost|out of|isn'?t (working|on)|won'?t (turn on|work|come on)|stopped working|broke(n)?)\b.*\b(heat|heater|furnace|a\/?c|ac|air|cooling)\b|\b(heat|heater|furnace|a\/?c|ac|air|cooling)\b.*\b(not working|out|off|broke(n)?|stopped|died|dead|won'?t)\b/;
const VULNERABLE = /\b(baby|babies|infant|newborn|toddler|elderly|grand(ma|pa|mother|father|parents?)|my (mom|dad|mother|father) is (old|elderly|\d{2})|oxygen|dialysis|disabled|sick|pregnant|medical (condition|equipment)|heat stroke|hypothermia|freezing|\d{3} degrees)\b/;

function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[^\p{L}\p{N}'/ ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function looksLikeEmergency(text: string): boolean {
  const t = normalize(text);
  if (ALWAYS.some((re) => re.test(t))) return true;
  return NO_CLIMATE.test(t) && VULNERABLE.test(t);
}

// "Are you a bot?" gets a fixed, honest answer, never a model's wording.
const ASKS_IF_AI =
  /\b(are|r) (you|u) (a |an )?(bot|robot|ai|a\.i|computer|machine|automated|real|human|person|real person|actual person)\b|\b(is this|am i (talking|texting|chatting) (to|with)) (a |an )?(bot|robot|ai|computer|machine|real person|human|person)\b|\bwho am i (talking|texting) (to|with)\b/;

export function asksIfAi(text: string): boolean {
  return ASKS_IF_AI.test(normalize(text));
}
