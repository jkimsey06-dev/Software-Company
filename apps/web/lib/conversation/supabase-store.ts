import type { SupabaseClient } from "@supabase/supabase-js";
import { StoreError } from "../missed-call/supabase-store";
import type { Conversation, ConversationStore, ThreadMessage } from "./types";

const REUSE_AFTER = "7 days";
const LEASE_SECONDS = 90;

function data<T>(result: { data: T; error: { code?: string } | null }, what: string): T {
  if (result.error) throw new StoreError(what, result.error.code ?? "unknown");
  return result.data;
}

function toConversation(row: Record<string, unknown>): Conversation {
  return {
    id: row.id as string,
    status: row.status as Conversation["status"],
    aiReplies: row.ai_replies as number,
    leadId: (row.lead_id as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
  };
}

export function createConversationStore(db: SupabaseClient): ConversationStore {
  return {
    async startConversation(tenantId, phone, leadId) {
      const rows = data(
        await db.rpc("start_conversation", {
          p_tenant_id: tenantId,
          p_phone: phone,
          p_lead_id: leadId,
          p_reuse_after: REUSE_AFTER,
        }),
        "start conversation",
      ) as Record<string, unknown>[] | null;
      if (!rows?.[0]) throw new StoreError("start conversation", "no_row");
      return toConversation(rows[0]);
    },

    async acquireLease(id) {
      return (
        data(await db.rpc("acquire_conversation_lease", { p_id: id, p_seconds: LEASE_SECONDS }), "acquire lease") ===
        true
      );
    },

    async releaseLease(id) {
      data(await db.from("conversations").update({ lease_until: null }).eq("id", id), "release lease");
    },

    async loadThread(tenantId, phone, since) {
      const after = since.toISOString();
      const [inbound, outbound] = await Promise.all([
        db
          .from("inbound_messages")
          .select("message_sid, body, created_at")
          .eq("tenant_id", tenantId)
          .eq("from_phone", phone)
          .gte("created_at", after)
          .order("created_at", { ascending: true })
          .limit(100),
        db
          .from("outbound_messages")
          .select("body, created_at")
          .eq("tenant_id", tenantId)
          .eq("to_phone", phone)
          .in("status", ["pending", "sent", "unknown"])
          .gte("created_at", after)
          .order("created_at", { ascending: true })
          .limit(100),
      ]);
      const messages: ThreadMessage[] = [
        ...(data(inbound, "load inbound") ?? []).map((r) => ({
          from: "customer" as const,
          text: r.body as string,
          at: new Date(r.created_at as string),
          messageSid: r.message_sid as string,
        })),
        ...(data(outbound, "load outbound") ?? []).map((r) => ({
          from: "business" as const,
          text: r.body as string,
          at: new Date(r.created_at as string),
        })),
      ];
      return messages.sort((a, b) => a.at.getTime() - b.at.getTime());
    },

    async recordTurn(t) {
      const rows = data(
        await db
          .from("conversation_turns")
          .upsert(
            {
              tenant_id: t.tenantId,
              conversation_id: t.conversationId,
              inbound_message_sid: t.inboundMessageSid,
              action: t.action,
              safety_category: t.safetyCategory ?? null,
              model: t.model ?? null,
              prompt_version: t.promptVersion ?? null,
              guard_violations: t.guardViolations ?? [],
              input_tokens: t.inputTokens ?? null,
              output_tokens: t.outputTokens ?? null,
              outbound_message_id: t.outboundMessageId ?? null,
            },
            { onConflict: "conversation_id,inbound_message_sid", ignoreDuplicates: true },
          )
          .select("id"),
        "record turn",
      );
      return (rows?.length ?? 0) > 0;
    },

    async setStatus(id, status, reason) {
      data(
        await db
          .from("conversations")
          .update({ status, handoff_reason: reason?.slice(0, 64) ?? null })
          .eq("id", id),
        "set conversation status",
      );
    },

    async incrementAiReplies(id) {
      // Only the lease holder writes this, so read-then-write is safe.
      const row = data(
        await db.from("conversations").select("ai_replies").eq("id", id).single(),
        "read ai replies",
      ) as { ai_replies: number };
      data(
        await db.from("conversations").update({ ai_replies: row.ai_replies + 1 }).eq("id", id),
        "increment ai replies",
      );
    },

    async updateLeadDetails(tenantId, leadId, d) {
      const update: Record<string, unknown> = {};
      if (d.serviceId) update.service_id = d.serviceId;
      if (d.area) update.area = d.area;
      if (d.urgency !== "unknown") update.urgency = d.urgency;
      if (Object.keys(update).length === 0) return;
      data(
        await db.from("leads").update(update).eq("tenant_id", tenantId).eq("id", leadId),
        "update lead details",
      );
    },

    async isOptedOut(tenantId, phone) {
      const rows = data(
        await db.from("opt_outs").select("phone").eq("tenant_id", tenantId).eq("phone", phone).limit(1),
        "check opt-out",
      );
      return (rows?.length ?? 0) > 0;
    },

    async tenantOwnsNumber(tenantId, phone) {
      const row = data(
        await db.from("tenant_phone_numbers").select("tenant_id").eq("phone", phone).maybeSingle(),
        "check number owner",
      ) as { tenant_id: string } | null;
      return row?.tenant_id === tenantId;
    },

    async claimOutbound(m) {
      const rows = data(
        await db
          .from("outbound_messages")
          .upsert(
            {
              tenant_id: m.tenantId,
              idempotency_key: m.idempotencyKey,
              lead_id: m.leadId,
              to_phone: m.toPhone,
              from_phone: m.fromPhone,
              body: m.body,
              template_version: m.templateVersion,
            },
            { onConflict: "tenant_id,idempotency_key", ignoreDuplicates: true },
          )
          .select("id"),
        "claim outbound message",
      );
      return (rows?.[0]?.id as string | undefined) ?? null;
    },

    async markMessage(id, update) {
      data(
        await db
          .from("outbound_messages")
          .update(
            update.status === "sent"
              ? { status: "sent", provider_sid: update.providerSid }
              : { status: update.status, error_code: update.errorCode },
          )
          .eq("id", id),
        "mark message",
      );
    },
  };
}
