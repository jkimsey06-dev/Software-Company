import { parseSlotNumber, type ConversationModel, type FixedMessage, type ModelCallInfo } from "@sc/ai";
import { findEstimateSlots, formatSlot, type TenantConfig } from "@sc/shared";
import { CalendarAuthError, eventIdFor, type CalendarClient } from "../calendar/google";
import { formatPhone } from "../notifications/templates";
import type { BookingState, Conversation, ConversationDeps, TurnAction } from "./types";

// Minutes before the first offered slot, and kept free around busy blocks.
const MIN_LEAD_MINUTES = 120;
const BUFFER_MINUTES = 30;
// After this many offers (first + "that time was taken"), a person takes over.
const MAX_OFFER_ROUNDS = 2;

// What a booking step wants to do. The caller sends `message`, and only if it
// was delivered runs `apply`. `terminal` ends the conversation.
export interface BookingPlan {
  action: TurnAction;
  reason?: string;
  message: FixedMessage | null;
  info?: ModelCallInfo;
  apply?: () => Promise<void>;
  terminal?: {
    status: "completed" | "handed_off";
    outcome: "complete" | "needs_you" | "booked";
    reason: string;
    booking?: { slot: string; address: string };
  };
}

async function calendar(msg: { tenantId: string }, deps: ConversationDeps): Promise<CalendarClient | "revoked" | null> {
  if (!deps.calendarFor) return null;
  const access = await deps.calendarFor(msg.tenantId);
  if (access.ok) return access.client;
  return access.reason === "revoked" ? "revoked" : null;
}

async function onRevoked(tenantId: string, deps: ConversationDeps): Promise<void> {
  await deps.markCalendarRevoked?.(tenantId).catch(() => undefined);
  await deps.notifications?.opsAlert("calendar.revoked", { tenantId });
}

async function freeSlots(client: CalendarClient, config: TenantConfig, now: Date, exclude: Date[] = []): Promise<Date[]> {
  const until = new Date(now.getTime() + (config.calendar.bookingWindowDays + 1) * 24 * 3_600_000);
  const busy = await client.busy(now, until);
  const taken = new Set(exclude.map((d) => d.getTime()));
  return findEstimateSlots(config, {
    now,
    busy,
    minLeadMinutes: MIN_LEAD_MINUTES,
    bufferMinutes: BUFFER_MINUTES,
    count: config.calendar.slotsToOffer + taken.size,
  })
    .filter((s) => !taken.has(s.getTime()))
    .slice(0, config.calendar.slotsToOffer);
}

// All details are known. Offer times if a calendar is connected and has room;
// otherwise hand the lead to the owner to schedule, as before.
export async function planOffer(
  msg: { tenantId: string; config: TenantConfig },
  conversation: Conversation,
  deps: ConversationDeps,
): Promise<BookingPlan> {
  const complete = (reason: string): BookingPlan => ({
    action: "complete",
    reason,
    message: { kind: "complete" },
    terminal: { status: "completed", outcome: "complete", reason },
  });
  // Emergencies are handled elsewhere; an urgent job isn't put on a calendar.
  if (conversation.details.urgency === "emergency") return complete("urgent");
  const client = await calendar(msg, deps);
  if (client === "revoked") {
    await onRevoked(msg.tenantId, deps);
    return complete("calendar_revoked");
  }
  if (!client) return complete("no_calendar");

  const now = deps.now?.() ?? new Date();
  let slots: Date[];
  try {
    slots = await freeSlots(client, msg.config, now);
  } catch (err) {
    if (err instanceof CalendarAuthError) await onRevoked(msg.tenantId, deps);
    deps.log("booking.calendar_unavailable", { tenantId: msg.tenantId, step: "offer" });
    return complete("calendar_unavailable");
  }
  if (!slots.length) return complete("no_times");
  return {
    action: "offer_times",
    message: { kind: "offer_times", slots: slots.map((s) => formatSlot(s, msg.config.timezone)) },
    apply: () =>
      deps.store.setBooking(conversation.id, {
        stage: "choosing_time",
        offeredSlots: slots,
        offerRounds: conversation.booking.offerRounds + 1,
      }),
  };
}

const otherTime = (reason: string): BookingPlan => ({
  action: "handoff",
  reason,
  message: { kind: "other_time" },
  terminal: { status: "handed_off", outcome: "needs_you", reason },
});

// They were offered numbered times.
export async function planChoice(
  msg: { config: TenantConfig },
  conversation: Conversation,
  latest: string,
  model: ConversationModel,
  deps: ConversationDeps,
): Promise<BookingPlan> {
  const { offeredSlots } = conversation.booking;
  let choice = parseSlotNumber(latest, offeredSlots.length);
  let info: ModelCallInfo | undefined;
  if (choice === null) {
    const picked = await model.chooseSlot({
      latest,
      options: offeredSlots.map((s) => formatSlot(s, msg.config.timezone)),
    });
    info = picked.info;
    if (picked.result.wantsOtherTime) return { ...otherTime("wants_other_time"), info };
    choice = picked.result.choice;
  }
  const slot = choice ? offeredSlots[choice - 1] : undefined;
  if (!slot) {
    // Unclear: show the same options again (the question limit still applies).
    return {
      action: "offer_times",
      reason: "unclear_choice",
      message: { kind: "offer_times", slots: offeredSlots.map((s) => formatSlot(s, msg.config.timezone)) },
      info,
    };
  }
  return {
    action: "ask_address",
    message: { kind: "ask_address", slot: formatSlot(slot, msg.config.timezone) },
    info,
    apply: () => deps.store.setBooking(conversation.id, { stage: "asking_address", chosenSlot: slot }),
  };
}

// They picked a time and were asked for the address.
export async function planAddressAndBook(
  msg: { tenantId: string; config: TenantConfig; customerPhone: string; leadId: string | null },
  conversation: Conversation,
  latest: string,
  askedAgain: boolean,
  model: ConversationModel,
  deps: ConversationDeps,
): Promise<BookingPlan> {
  const { config } = msg;
  const slot = conversation.booking.chosenSlot;
  const slotLabel = slot ? formatSlot(slot, config.timezone) : "";
  const { address, info } = await model.extractAddress({ latest });
  if (!slot) return { ...otherTime("no_chosen_slot"), info };
  if (!address) {
    if (askedAgain) return { ...otherTime("no_address"), info };
    return { action: "ask_address", reason: "unclear_address", message: { kind: "ask_address", slot: slotLabel, again: true }, info };
  }

  const client = await calendar(msg, deps);
  if (client === "revoked") {
    await onRevoked(msg.tenantId, deps);
    return { ...otherTime("calendar_revoked"), info };
  }
  if (!client) return { ...otherTime("calendar_unavailable"), info };

  const now = deps.now?.() ?? new Date();
  const end = new Date(slot.getTime() + config.calendar.estimateDurationMinutes * 60_000);
  try {
    // Check again: the time may have been taken since we offered it.
    const busy = await client.busy(new Date(slot.getTime() - BUFFER_MINUTES * 60_000), new Date(end.getTime() + BUFFER_MINUTES * 60_000));
    const stillFree = busy.length === 0 && slot.getTime() > now.getTime();
    if (!stillFree) {
      if (conversation.booking.offerRounds >= MAX_OFFER_ROUNDS) return { ...otherTime("slot_taken"), info };
      const fresh = await freeSlots(client, config, now, conversation.booking.offeredSlots);
      if (!fresh.length) return { ...otherTime("slot_taken"), info };
      return {
        action: "slot_taken",
        message: { kind: "offer_times", slots: fresh.map((s) => formatSlot(s, config.timezone)), retry: true },
        info,
        apply: async () => {
          await deps.store.setBooking(conversation.id, {
            stage: "choosing_time",
            offeredSlots: fresh,
            chosenSlot: null,
            offerRounds: conversation.booking.offerRounds + 1,
          });
          if (msg.leadId) await deps.store.updateLeadAddress(msg.tenantId, msg.leadId, address);
        },
      };
    }

    const service = config.services.find((s) => s.id === conversation.details.serviceId)?.name ?? "Estimate";
    const eventId = eventIdFor(conversation.id, slot);
    // Booked before we tell the customer; the id makes a retry a no-op.
    await client.createEvent({
      id: eventId,
      start: slot,
      end,
      summary: `Estimate: ${service} - ${formatPhone(msg.customerPhone)}`,
      description: [
        `Customer: ${msg.customerPhone}`,
        `Service: ${service}`,
        `Area (as they wrote it): ${conversation.details.area ?? "not given"}`,
        `Urgency: ${conversation.details.urgency}`,
        `Address (as they wrote it): ${address}`,
        "Booked by the text assistant.",
      ].join("\n"),
      location: address,
    });
    if (msg.leadId) await deps.store.updateLeadAddress(msg.tenantId, msg.leadId, address);
    await deps.store.setBooking(conversation.id, { stage: "booked", bookedEventId: eventId } satisfies Partial<BookingState>);
    return {
      action: "booked",
      message: { kind: "booked", slot: slotLabel },
      info,
      terminal: { status: "completed", outcome: "booked", reason: "booked", booking: { slot: slotLabel, address } },
    };
  } catch (err) {
    if (err instanceof CalendarAuthError) await onRevoked(msg.tenantId, deps);
    deps.log("booking.calendar_unavailable", { tenantId: msg.tenantId, step: "book" });
    return { ...otherTime("calendar_unavailable"), info };
  }
}
