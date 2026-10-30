import type { TenantConfig } from "@sc/shared";

// Fixed texts sent when the model must not or cannot write the reply.
// Versioned: never edit a version that has been used; add v2.
export const CONVERSATION_TEMPLATES_V1 = "conversation-templates@v1";

export type FixedMessage = "emergency" | "handoff" | "fallback" | "complete" | "ai_disclosure" | "turn_limit";

export function renderFixedMessageV1(kind: FixedMessage, config: TenantConfig): string {
  const business = config.businessName;
  switch (kind) {
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
    case "ai_disclosure":
      return `Yes, I'm an AI assistant for ${business}. A person from the team will follow up. What can we help you with?`;
    case "turn_limit":
      return `Thanks for the details! I'm passing this to the team at ${business}, and someone will reach out to you directly.`;
  }
}
