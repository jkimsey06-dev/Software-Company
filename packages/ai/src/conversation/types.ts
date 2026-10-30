import type { LeadUrgency } from "@sc/shared";

// One message in the SMS thread, oldest first. Customer text is untrusted.
export interface Turn {
  from: "customer" | "business";
  text: string;
}

export const SAFETY_CATEGORIES = [
  "normal",
  "emergency",
  "upset",
  "wants_human",
  "wrong_number",
  "spam",
] as const;
export type SafetyCategory = (typeof SAFETY_CATEGORIES)[number];

// What we know about the job. Null means not known yet.
export interface LeadDetails {
  serviceId: string | null;
  area: string | null;
  urgency: LeadUrgency;
}

// What the model understood from the customer's latest messages. The model
// never writes text that is sent; it only fills these fields.
export interface Understanding {
  details: LeadDetails;
  // Id of an approved FAQ entry that answers a question the customer asked.
  faqId: string | null;
  // They asked something the approved FAQ doesn't answer.
  askedOtherQuestion: boolean;
  // They need a service the business doesn't list.
  unlistedService: boolean;
  needsHuman: boolean;
}

export interface ModelCallInfo {
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
}

// Thrown when the model declined, timed out, or returned something unusable.
// The caller falls back to a fixed message and a human.
export class ModelUnavailableError extends Error {
  constructor(readonly reason: "refusal" | "invalid_output" | "api_error" | "timeout" | "max_tokens") {
    super(`model unavailable (${reason})`);
    this.name = "ModelUnavailableError";
  }
}

export interface ConversationModel {
  classify(input: { history: Turn[]; latest: string }): Promise<{ category: SafetyCategory; info: ModelCallInfo }>;
  understand(input: {
    history: Turn[];
    latest: string;
    known: LeadDetails;
  }): Promise<{ result: Understanding; info: ModelCallInfo }>;
}
