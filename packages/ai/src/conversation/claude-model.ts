import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { LEAD_URGENCIES, type TenantConfig } from "@sc/shared";
import { z } from "zod";
import { MISSED_CALL_QUALIFIER_V1, buildQualifierSystemV1 } from "../prompts/missed-call-qualifier.v1";
import { SAFETY_CLASSIFIER_SYSTEM_V1, SAFETY_CLASSIFIER_V1 } from "../prompts/safety-classifier.v1";
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

const ReplySchema = z.object({
  reply: z.string(),
  service_id: z.string().nullable(),
  area: z.string().nullable(),
  in_service_area: z.boolean().nullable(),
  urgency: z.enum(LEAD_URGENCIES),
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

export function createClaudeConversationModel(config: TenantConfig, client = new Anthropic({ timeout: 20_000, maxRetries: 1 })): ConversationModel {
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

    async reply({ history, latest, known }) {
      try {
        const response = await client.messages.parse({
          model: CONVERSATION_MODEL,
          max_tokens: 4000,
          system: buildQualifierSystemV1(config),
          output_config: { effort: "low", format: zodOutputFormat(ReplySchema) },
          messages: [
            {
              role: "user",
              content: `${formatConversation(history, latest)}\n\n<known_details>\n${describeKnown(known)}\n</known_details>\n\nWrite the next text to the customer.`,
            },
          ],
        });
        if (response.stop_reason === "refusal") throw new ModelUnavailableError("refusal");
        if (response.stop_reason === "max_tokens") throw new ModelUnavailableError("max_tokens");
        const out = response.parsed_output;
        if (!out) throw new ModelUnavailableError("invalid_output");
        const validService = config.services.some((s) => s.id === out.service_id);
        return {
          result: {
            reply: out.reply,
            needsHuman: out.needs_human,
            details: {
              serviceId: validService ? out.service_id : null,
              area: out.area?.trim().slice(0, 120) || null,
              inServiceArea: out.in_service_area,
              urgency: out.urgency,
            },
          },
          info: {
            model: CONVERSATION_MODEL,
            promptVersion: MISSED_CALL_QUALIFIER_V1,
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
