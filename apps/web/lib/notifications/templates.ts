import type { TenantConfig } from "@sc/shared";

export type TextbackOutcome =
  | { kind: "sent" }
  | { kind: "skipped"; reason: string }
  | { kind: "failed" | "unknown" };

const SKIP_REASONS: Record<string, string> = {
  a2p_not_approved: "Texting isn't switched on for your number yet, so we didn't text them.",
  opted_out: "They've opted out of texts, so we didn't text them.",
  non_us_number: "It's not a US or Canada number, so we didn't text them.",
  already_texted: "We already texted them recently, so we didn't text them again.",
  unrecognized_status: "We couldn't tell how the call ended, so we didn't text them.",
};

export function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

function formatTime(at: Date, timezone: string): string {
  // Date and zone included, so the repeated hour at a DST change is unambiguous.
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(at);
}

function textbackLine(outcome: TextbackOutcome): string {
  switch (outcome.kind) {
    case "sent":
      return "We texted them back and will let you know what they need.";
    case "skipped":
      return `${SKIP_REASONS[outcome.reason] ?? "We didn't text them."} Please call them back.`;
    case "failed":
    case "unknown":
      return "Our text-back didn't go through. Please call them back.";
  }
}

// Plain text only. Caller details come from Twilio and are formatted, never
// passed through as markup.
export function renderNewLeadEmail(
  config: TenantConfig,
  lead: { callerPhone: string; calledAt: Date; textback: TextbackOutcome },
): { subject: string; body: string } {
  const caller = formatPhone(lead.callerPhone);
  return {
    subject: `Missed call: ${caller}`,
    body: [
      `Someone called ${config.businessName} at ${formatTime(lead.calledAt, config.timezone)} and the call wasn't answered.`,
      "",
      `Caller: ${caller}`,
      textbackLine(lead.textback),
      "",
      `Call them: tel:${lead.callerPhone}`,
    ].join("\n"),
  };
}

export function renderTextbackFailedEmail(
  config: TenantConfig,
  lead: { callerPhone: string; calledAt: Date },
): { subject: string; body: string } {
  const caller = formatPhone(lead.callerPhone);
  return {
    subject: `Text-back failed: ${caller}`,
    body: [
      `${caller} called ${config.businessName} again at ${formatTime(lead.calledAt, config.timezone)} and the call wasn't answered.`,
      "",
      "Our text-back didn't go through. Please call them back.",
      "",
      `Call them: tel:${lead.callerPhone}`,
    ].join("\n"),
  };
}

// Customer text is untrusted. Invisible and reordering characters are removed,
// Unicode line separators become real line breaks (so every line stays quoted),
// and it's capped by characters, never splitting an emoji. The email is plain
// text, so nothing in it can render as markup.
const STRIP = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

function quoteCustomerText(body: string): string {
  const cleaned = body.replace(/\r\n?|[\u2028\u2029\u0085]/g, "\n").replace(STRIP, "").trim();
  const chars = Array.from(cleaned);
  const short = chars.length > 1000 ? `${chars.slice(0, 1000).join("")}...` : cleaned;
  return short
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function renderCustomerReplyEmail(
  config: TenantConfig,
  reply: { callerPhone: string; body: string; numMedia: number; receivedAt: Date; optedOut?: boolean },
): { subject: string; body: string } {
  const caller = formatPhone(reply.callerPhone);
  const lines = [`${caller} texted ${config.businessName} at ${formatTime(reply.receivedAt, config.timezone)}:`, ""];
  if (reply.body.trim()) lines.push(quoteCustomerText(reply.body));
  if (reply.numMedia > 0) {
    lines.push(`(${reply.numMedia} photo${reply.numMedia === 1 ? "" : "s"} attached; view in Twilio)`);
  }
  if (reply.optedOut) {
    lines.push("", "This message opted them out of texts. You can still call them.");
    lines.push("", `Call them: tel:${reply.callerPhone}`);
  } else {
    lines.push("", `Call or text them: tel:${reply.callerPhone}`);
  }
  return { subject: `Text from ${caller}`, body: lines.join("\n") };
}
