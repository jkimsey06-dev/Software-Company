// Conversation logic, guardrails and message templates for client-facing assistants.
// Prompts and templates live in versioned files, never as inline strings elsewhere.
export {
  MISSED_CALL_TEXTBACK_V1,
  renderMissedCallTextbackV1,
} from "./templates/missed-call-textback.v1";
export {
  CONVERSATION_TEMPLATES_V1,
  renderFixedMessageV1,
  type FixedMessage,
} from "./templates/conversation.v1";
export { asksIfAi, looksLikeEmergency } from "./conversation/emergency";
export { MAX_REPLY_CHARS, checkReply } from "./conversation/guard";
export {
  CLASSIFIER_MODEL,
  CONVERSATION_MODEL,
  createClaudeConversationModel,
  formatConversation,
} from "./conversation/claude-model";
export * from "./conversation/types";
