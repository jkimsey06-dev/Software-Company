import type { TenantConfig } from "@sc/shared";

// Versioned template. Never edit a version once it has been used; add v2.
export const MISSED_CALL_TEXTBACK_V1 = "missed-call-textback@v1";

export function renderMissedCallTextbackV1(config: TenantConfig): string {
  const { businessName } = config;
  const { aiDisclosureAtStart, optOutText } = config.messaging;
  const greeting = aiDisclosureAtStart
    ? `Hi, this is the AI assistant for ${businessName}.`
    : `Hi, it's ${businessName}.`;
  return `${greeting} Sorry we missed your call! What can we help you with today? ${optOutText}`;
}
