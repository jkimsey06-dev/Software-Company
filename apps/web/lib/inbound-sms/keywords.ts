export type Keyword = "stop" | "start" | "help";

export interface Classification {
  keyword: Keyword | null;
  // True when the whole message is just a standard keyword ("STOP", "Start!").
  // Anything else, even if it opts the customer out, is also shown to the owner,
  // because it may carry a request ("Don't text me, call me").
  bare: boolean;
}

// Twilio's standard keywords. A message made only of these (plus filler like
// "please") is a bare keyword.
const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout", "revoke"]);
const START_WORDS = new Set(["start", "unstop"]);
const HELP_WORDS = new Set(["help", "info"]);
const FILLER = new Set(["please", "pls", "plz", "now", "thanks", "thank", "you", "thx", "ty", "all"]);

// Plain-language opt-outs anywhere in the message. When in doubt we opt the
// customer out: it can only stop texts, never start them, and the owner still
// sees the message.
const STOP_PHRASES = [
  /\bstop (texting|texts|text|txting|txts|txt|messaging|messages|message|sending|contacting)\b/,
  /\bstop all (texts|messages|txts)\b/,
  /\bno more (texts|text messages|messages|txts)\b/,
  /\bunsubscribe me\b/,
  /\bopt (me )?out\b/,
  /\bremove me from (your|the|this) (list|texts|text list|texting list|mailing list|messages)\b/,
  /\b(don'?t|do not|never) (text|message|txt|contact) me\b/,
];

// Characters that are invisible or reorder text: removed before matching.
const INVISIBLE = /[­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

function words(body: string): string[] {
  return body
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    // Anything that isn't a letter, digit or apostrophe separates words:
    // punctuation, emoji, CJK full stops, inverted marks.
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .replace(/(^|\s)'+|'+(\s|$)/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function onlyFrom(tokens: string[], set: Set<string>): boolean {
  const meaningful = tokens.filter((t) => !FILLER.has(t));
  return meaningful.length > 0 && meaningful.every((t) => set.has(t));
}

// Twilio's Advanced Opt-Out tags keyword messages with OptOutType; that wins.
export function classifyKeyword(body: string, optOutType?: string): Classification {
  const tokens = words(body);
  const text = tokens.join(" ");
  switch (optOutType?.toUpperCase()) {
    case "STOP":
      return { keyword: "stop", bare: onlyFrom(tokens, STOP_WORDS) };
    case "START":
      return { keyword: "start", bare: onlyFrom(tokens, START_WORDS) };
    case "HELP":
      return { keyword: "help", bare: false };
  }
  if (onlyFrom(tokens, STOP_WORDS) || text === "opt out" || text === "stop all") {
    // CANCEL, END and QUIT could mean "cancel my appointment": the owner sees them.
    const standard = tokens.some((t) => t === "stop" || t === "stopall" || t === "unsubscribe");
    return { keyword: "stop", bare: standard && onlyFrom(tokens, new Set(["stop", "stopall", "unsubscribe"])) };
  }
  if (STOP_PHRASES.some((re) => re.test(text))) return { keyword: "stop", bare: false };
  if (onlyFrom(tokens, START_WORDS)) return { keyword: "start", bare: true };
  // HELP is answered by Twilio, but a lone "help" could be an emergency: the
  // owner always sees it.
  if (onlyFrom(tokens, HELP_WORDS)) return { keyword: "help", bare: false };
  return { keyword: null, bare: false };
}
