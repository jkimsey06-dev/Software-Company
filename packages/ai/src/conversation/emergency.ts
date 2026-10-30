// Deterministic emergency check. Runs before any model and in every state of
// the conversation, so an emergency is never missed because a model was down,
// wrong, or the conversation had already ended. Biased toward safety: a false
// alarm costs a fixed safety text and an owner call; a miss could cost much more.

const GAS = "(gas|natural gas|propane|lp|rotten eggs?)";
const ALWAYS: RegExp[] = [
  new RegExp(`\\b(smel+s?|smel+(ed|ing)|reeks?|stinks?) (of |like )?${GAS}\\b`),
  new RegExp(`\\b${GAS} (smel+|odou?r|leak(ing|s)?|fumes)\\b`),
  /\b(leak(ing)?|hiss(ing)?) (natural )?(gas|propane)\b/,
  /\bcarbon monoxide\b|\b(co|carbon) (alarm|detector)\b/,
  /\b(smoke|smoking|flames?|on fire|caught fire|fire)\b/,
  /\b(burning (smell|plastic|rubber)|smell(s|ing)? (like )?burning)\b/,
  /\b(spark(s|ing)?|arc(ing)?|electrical fire)\b/,
  /\bpanel (is )?(buzzing|hot|humming loud|melting)\b/,
  /\b(electrocut\w*|got shocked|getting shocked|shock(ed)? me)\b/,
  /\b(exposed|live|bare|hot) wires?\b|\bpower lines? (down|fell|on)\b/,
  /\b(flood(ed|ing)?|water everywhere|burst pipe|pipe burst|pipe (broke|exploded))\b/,
  /\b(filling|filled) (up )?with water\b|\bwater (is )?(pouring|gushing|coming|leaking) (through|from|out of) (the )?(ceiling|light|wall)\b/,
  /\bwater (near|on|in|by) (the )?(panel|breaker|outlet|electrical|wires?)\b/,
  /\btree (fell|came down|crashed) (on|through|into)\b|\broof (caved|collapsed)\b/,
  /\b(can'?t breathe|chest pain|passed out|fainted|collapsed|unconscious|not breathing|ambulance|911)\b/,
  // Spanish
  /\b(huele a gas|olor a gas|fuga de gas|humo|fuego|incendio|chispas|se (esta )?inunda\w*|inundaci[oó]n|monoxido)\b/,
];

// Phrases that contain an alarm word but aren't emergencies.
const BENIGN = [
  /\b(no|not|never|isn'?t|without|not any) (any )?(smoke|smoking|fire|flames?|sparks?|gas smell|smell of gas|gas leak|leak)\b/g,
  /\bfire (up|pit|place|wood|works?)\b/g,
  /\bfireplace\b/g,
  /\bflooded with (calls|messages|texts|work|orders|requests|emails)\b/g,
  /\bsmoke (detector|alarm)s? (is |are |keeps |keep |has been |have been )?(chirp\w*|beep\w*)\b/g,
  /\b(low|dead|replace the) batter(y|ies)\b/g,
  /\bgas (furnace|water heater|stove|range|dryer|line install\w*|fireplace|grill|logs?|bill|company)\b(?! (smel+|odou?r|leak))/g,
];

// No heat or no AC is an emergency only with someone vulnerable at home.
const CLIMATE = "(heat|heater|heating|furnace|a/?c|ac|air|cooling|air conditioning)";
const NO_CLIMATE = new RegExp(
  `\\b(no|not any|without|lost|out of)( \\w+)? ${CLIMATE}\\b` +
    `|\\b${CLIMATE}( \\w+){0,2} (is |isn't |isnt |has |went )?(not working|out|off|broke|broken|stopped( working)?|died|dead|won't (turn on|work|come on)|quit)\\b`,
);
const VULNERABLE = /\b(baby|babies|infant|newborn|toddler|\d+ (week|month)s? old|([6-9]\d|1[01]\d) (years?|yrs?) old|elderly|grand(ma|pa|mother|father|parents?)|oxygen|dialysis|chemo\w*|disabled|sick|pregnant|medical (condition|equipment)|heat stroke|hypothermia|freezing|(1[0-9]{2}|[0-9]|[1-3][0-9]) degrees)\b/;

const INVISIBLE = /[­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[^\p{L}\p{N}'/ ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function looksLikeEmergency(text: string): boolean {
  let t = normalize(text);
  for (const re of BENIGN) t = t.replace(re, " ");
  if (ALWAYS.some((re) => re.test(t))) return true;
  return NO_CLIMATE.test(t) && VULNERABLE.test(t);
}

// "Are you a bot?" gets a fixed, honest answer, never a model's wording.
const ASKS_IF_AI = [
  /\b(are|r) (you|u) (a |an )?(bot|robot|ai|a i|computer|machine|automated|human|person|real (person|human)|actual (person|human))\b/,
  /^(u|you) (a |an )?(bot|robot|ai)\b/,
  /\b(is this|is that|this is) (a |an )?(bot|robot|ai|automated|computer|machine|real person|human|person)\b/,
  /\bam i (talking|texting|chatting|speaking)( to| with)? (a |an )?(bot|robot|ai|computer|machine|real person|human|person)\b/,
  /\bwho am i (talking|texting) (to|with)\b/,
];

export function asksIfAi(text: string): boolean {
  const t = normalize(text);
  return ASKS_IF_AI.some((re) => re.test(t));
}
