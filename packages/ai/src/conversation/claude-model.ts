import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { LEAD_URGENCIES, type TenantConfig } from "@sc/shared";
import { z } from "zod";
import { LEAD_UNDERSTANDING_V1, buildUnderstandingSystemV1 } from "../prompts/lead-understanding.v1";
import { SAFETY_CLASSIFIER_SYSTEM_V1, SAFETY_CLASSIFIER_V1 } from "../prompts/safety-classifier.v1";
import { cleanArea } from "./service-area";
import {
  ModelUnavailableError,
  SAFETY_CATEGORIES,
  type ConversationModel,
  type LeadDetails,
  type Turn,
} from "./types";

// Per CLAUDE.md: mid-size model for conversations, small model for classification.
export const CONVERSATION_MODEL = "claude-sonnet-5-5";
export const CLASSIFIER_MODEL = "claude-haiku-5-5";

const ClassificationSchema = z.object({ category: z.enum(SAFETY_CATEGORIES) });

const UnderstandingSchema = z.object({
  service_id: z.string().nullable(),
  unlisted_service: z.boolean(),
  area: z.string().nullable(),
  urgency: z.enum(LEAD_URGENCIES),
  faq_id: z.string().nullable(),
  asked_other_question: z.boolean(),
  needs_human: z.boolean(),
});

// Customer text can't open or close tags: angle brackets become look-alikes.
function escapeCustomer(text: string): string {
  return text.replace(/</g, "‹").replace(/>/g, "›");
}

export function formatConversation(history: Turn[], latest: string): string {
  const lines = history.map((t) =>
    t.from === "customer" ? `<customer>${escapeCustomer(t.text)}</customer>` : `<business>${t.text}</business>`,
  );
  return [
    "<conversation>",
    ...lines,
    "</conversation>",
    "",
    "<latest_customer_message>",
    `<customer>${escapeCustomer(latest)}</customer>`,
    "</latest_customer_message>",
  ].join("\n");
}

function describeKnown(known: LeadDetails): string {
  return [
    `service_id: ${known.serviceId ?? "unknown"}`,
    `area: ${known.area ?? "unknown"}`,
    `urgency: ${known.urgency}`,
  ].join("\n");
}

function toUnavailable(err: unknown): ModelUnavailableError {
  if (err instanceof ModelUnavailableError) return err;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ModelUnavailableError("timeout");
  return new ModelUnavailableError("api_error");
}

// Both calls together must finish well inside the webhook's 60s limit, so each
// gets one 15s attempt; a failure falls back to a fixed text and a human.
export function createClaudeConversationModel(
  config: TenantConfig,
  client = new Anthropic({ timeout: 15_000, maxRetries: 0 }),
): ConversationModel {
  return {
    async classify({ history, latest }) {
      try {
        const response = await client.messages.parse({
          model: CLASSIFIER_MODEL,
          max_tokens: 2000,
          system: SAFETY_CLASSIFIER_SYSTEM_V1,
          output_config: { effort: "low", format: zodOutputFormat(ClassificationSchema) },
          messages: [{ role: "user", content: formatConversation(history, latest) }],
        });
        if (response.stop_reason === "refusal") throw new ModelUnavailableError("refusal");
        if (response.stop_reason === "max_tokens") throw new ModelUnavailableError("max_tokens");
        if (!response.parsed_output) throw new ModelUnavailableError("invalid_output");
        return {
          category: response.parsed_output.category,
          info: {
            model: CLASSIFIER_MODEL,
            promptVersion: SAFETY_CLASSIFIER_V1,
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          },
        };
      } catch (err) {
        throw toUnavailable(err);
      }
    },

    async understand({ history, latest, known }) {
      try {
        const response = await client.messages.parse({
          model: CONVERSATION_MODEL,
          max_tokens: 4000,
          system: buildUnderstandingSystemV1(config),
          output_config: { effort: "low", format: zodOutputFormat(UnderstandingSchema) },
          messages: [
            {
              role: "user",
              content: `${formatConversation(history, latest)}\n\n<known_details>\n${describeKnown(known)}\n</known_details>`,
            },
          ],
        });
        if (response.stop_reason === "refusal") throw new ModelUnavailableError("refusal");
        if (response.stop_reason === "max_tokens") throw new ModelUnavailableError("max_tokens");
        const out = response.parsed_output;
        if (!out) throw new ModelUnavailableError("invalid_output");
        // Only ids from this tenant's config get through.
        const serviceId = config.services.some((s) => s.id === out.service_id) ? out.service_id : null;
        const faqId = config.knowledgeBase.some((e) => e.id === out.faq_id) ? out.faq_id : null;
        return {
          result: {
            details: { serviceId, area: cleanArea(out.area), urgency: out.urgency },
            faqId,
            askedOtherQuestion: out.asked_other_question,
            unlistedService: out.unlisted_service && !serviceId,
            needsHuman: out.needs_human,
          },
          info: {
            model: CONVERSATION_MODEL,
            promptVersion: LEAD_UNDERSTANDING_V1,
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          },
        };
      } catch (err) {
        throw toUnavailable(err);
      }
    },
  };
}
