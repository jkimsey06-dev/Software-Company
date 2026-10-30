export type Keyword = "stop" | "start" | "help";

// Twilio's standard opt-out words, matched against the whole message.
const STOP_WORDS = new Set([
  "stop", "stopall", "stop all", "unsubscribe", "cancel", "end", "quit",
  "optout", "opt out", "opt-out", "revoke",
]);
const START_WORDS = new Set(["start", "unstop"]);
const HELP_WORDS = new Set(["help", "info"]);

// Plain-language opt-outs. Carriers only require the exact words, but someone
// who writes "stop texting me" means it, so we honor it too. Erring this way
// can only stop texts, never start them.
const STOP_PHRASES = [
  /^(please\s+)?(stop|quit)\s+(texting|messaging|contacting|sending|txting)\b/,
  /\b(remove|take)\s+me\s+(from|off)\b/,
  /\b(don'?t|do\s+not|never)\s+(text|message|contact|txt)\s+me\b/,
  /^unsubscribe\b/,
];

function normalize(body: string): string {
  return body
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s"'.!?]+|[\s"'.!?]+$/g, "");
}

// Twilio's Advanced Opt-Out tags keyword messages with OptOutType; that wins.
export function classifyKeyword(body: string, optOutType?: string): Keyword | null {
  switch (optOutType?.toUpperCase()) {
    case "STOP":
      return "stop";
    case "START":
      return "start";
    case "HELP":
      return "help";
  }
  const text = normalize(body);
  if (STOP_WORDS.has(text) || STOP_PHRASES.some((re) => re.test(text))) return "stop";
  if (START_WORDS.has(text)) return "start";
  if (HELP_WORDS.has(text)) return "help";
  return null;
}
