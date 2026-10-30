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

// What the conversation model extracted so far. Null means not known yet.
export interface LeadDetails {
  serviceId: string | null;
  area: string | null;
  inServiceArea: boolean | null;
  urgency: LeadUrgency;
}

export interface ModelReply {
  reply: string;
  details: LeadDetails;
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
  reply(input: {
    history: Turn[];
    latest: string;
    known: LeadDetails;
  }): Promise<{ result: ModelReply; info: ModelCallInfo }>;
}
