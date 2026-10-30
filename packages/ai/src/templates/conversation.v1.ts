import type { TenantConfig } from "@sc/shared";

// Every text the conversation sends. Built only from tenant config (owner-
// approved), never from model output or customer text.
// Versioned: never edit a version that has been used; add v2.
export const CONVERSATION_TEMPLATES_V1 = "conversation-templates@v1";

export type Question = "service" | "area" | "urgency";

export type FixedMessage =
  | { kind: "emergency" }
  | { kind: "handoff" }
  | { kind: "fallback" }
  | { kind: "complete" }
  | { kind: "out_of_area" }
  | { kind: "unlisted_service" }
  | { kind: "turn_limit" }
  | { kind: "ask"; question: Question; prefix?: "ai_disclosure" | "other_question" | { faqId: string } }
  // Times come from the owner's calendar, already formatted by our code.
  | { kind: "offer_times"; slots: string[]; retry?: boolean }
  | { kind: "ask_address"; slot: string; again?: boolean }
  | { kind: "booked"; slot: string }
  | { kind: "other_time" };

function serviceList(config: TenantConfig): string {
  const names = config.services.slice(0, 6).map((s) => s.name.toLowerCase());
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

const QUESTIONS: Record<Question, (config: TenantConfig) => string> = {
  service: (c) => `What do you need help with: ${serviceList(c)}?`,
  area: () => "What city or ZIP code is the job in?",
  urgency: () => "How urgent is it: is it an emergency, needed in the next day or two, or flexible?",
};

export function renderFixedMessageV1(message: FixedMessage, config: TenantConfig): string {
  const business = config.businessName;
  switch (message.kind) {
    case "emergency":
      return (
        "If you smell gas, see smoke or fire, or there's water near anything electrical, " +
        "leave the area and call 911 or your gas or power company now. " +
        `We've alerted ${business} and someone will call you as soon as they can.`
      );
    case "handoff":
      return `Thanks. I'm passing this to the team at ${business}, and someone will reach out to you directly.`;
    case "fallback":
      return `Thanks for your message! Someone from ${business} will get back to you shortly.`;
    case "complete":
      return `Thanks! I've passed your details to ${business}. They'll reach out to set up a time.`;
    case "out_of_area":
      return `Thanks! That may be outside the area ${business} serves. I've passed your details to the team, and they'll let you know.`;
    case "unlisted_service":
      return `Thanks! I'll pass this to the team at ${business} to see if they can help, and someone will reach out to you.`;
    case "turn_limit":
      return `Thanks for the details! I'm passing this to the team at ${business}, and someone will reach out to you directly.`;
    case "offer_times": {
      const intro = message.retry
        ? "Sorry, that time was just taken. Here are some other times:"
        : `${business} can come out for an estimate at one of these times:`;
      const list = message.slots.map((slot, i) => `${i + 1}) ${slot}`).join("\n");
      return `${intro}\n${list}\nReply with the number, or tell us if none of these work.`;
    }
    case "ask_address":
      return message.again
        ? "Sorry, I didn't catch that. What's the street address (house number and street) for the estimate?"
        : `Great, ${message.slot} it is. What's the street address for the estimate?`;
    case "booked":
      return `You're booked for an estimate on ${message.slot}. ${business} may call to confirm or adjust. Reply STOP to opt out.`;
    case "other_time":
      return `No problem. I'll have the team at ${business} reach out to find a time that works.`;
    case "ask": {
      const question = QUESTIONS[message.question](config);
      const prefix = message.prefix;
      if (!prefix) return question;
      if (prefix === "ai_disclosure") return `Yes, I'm an AI assistant for ${business}. A person from the team will follow up. ${question}`;
      if (prefix === "other_question") return `Good question. I'll pass it to the team so they can cover it when they call. ${question}`;
      const answer = config.knowledgeBase.find((e) => e.id === prefix.faqId)?.answer;
      return answer ? `${answer} ${question}` : question;
    }
  }
}
