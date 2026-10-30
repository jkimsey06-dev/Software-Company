import { parseSlotNumber, type ConversationModel, type FixedMessage, type ModelCallInfo } from "@sc/ai";
import { findEstimateSlots, formatSlot, type TenantConfig } from "@sc/shared";
import { CalendarAuthError, eventIdFor, type CalendarClient } from "../calendar/google";
import { errorLabel } from "../missed-call/types";
import { formatPhone } from "../notifications/templates";
import type { Conversation, ConversationDeps, TurnAction } from "./types";

// Minutes before the first offered slot, and kept free around busy blocks.
const MIN_LEAD_MINUTES = 120;
// A picked time this close (or already past) is no longer booked.
const MIN_BOOK_MINUTES = 60;
const BUFFER_MINUTES = 30;
// After this many offers (first + new times), a person takes over.
const MAX_OFFER_ROUNDS = 2;

type BookingMsg = { tenantId: string; config: TenantConfig; customerPhone: string; leadId: string | null };

// What a booking step wants to do. The caller sends `message`, and only if it
// was delivered runs `apply`. `terminal` ends the conversation. `onCalendar`
// is set once the event is on the owner's calendar, so the owner hears about
// it even if the confirmation text never reaches the customer.
export interface BookingPlan {
  action: TurnAction;
  reason?: string;
  message: FixedMessage | null;
  info?: ModelCallInfo;
  apply?: () => Promise<void>;
  onCalendar?: { slot: string; address: string };
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

const nowFrom = (deps: ConversationDeps) => deps.now?.() ?? new Date();

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

  let slots: Date[];
  try {
    slots = await freeSlots(client, msg.config, nowFrom(deps));
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

const handOff = (reason: string, info?: ModelCallInfo, kind: "other_time" | "handoff" = "other_time"): BookingPlan => ({
  action: "handoff",
  reason,
  message: { kind },
  info,
  terminal: { status: "handed_off", outcome: "needs_you", reason },
});

// The picked time can't be booked any more: offer new times, keeping the
// address if they gave one, or hand off after too many rounds.
async function reoffer(
  msg: BookingMsg,
  conversation: Conversation,
  retry: "taken" | "expired",
  address: string | null,
  info: ModelCallInfo | undefined,
  deps: ConversationDeps,
): Promise<BookingPlan> {
  const reason = retry === "taken" ? "slot_taken" : "slot_expired";
  if (conversation.booking.offerRounds >= MAX_OFFER_ROUNDS) return handOff(reason, info);
  const client = await calendar(msg, deps);
  if (client === "revoked") {
    await onRevoked(msg.tenantId, deps);
    return handOff("calendar_revoked", info);
  }
  if (!client) return handOff("calendar_unavailable", info);
  let fresh: Date[];
  try {
    fresh = await freeSlots(client, msg.config, nowFrom(deps), conversation.booking.offeredSlots);
  } catch (err) {
    if (err instanceof CalendarAuthError) await onRevoked(msg.tenantId, deps);
    deps.log("booking.calendar_unavailable", { tenantId: msg.tenantId, step: "reoffer" });
    return handOff("calendar_unavailable", info);
  }
  if (!fresh.length) return handOff(reason, info);
  return {
    action: retry === "taken" ? "slot_taken" : "offer_times",
    reason,
    message: { kind: "offer_times", slots: fresh.map((s) => formatSlot(s, msg.config.timezone)), retry },
    info,
    apply: async () => {
      await deps.store.setBooking(conversation.id, {
        stage: "choosing_time",
        offeredSlots: fresh,
        chosenSlot: null,
        bookedEventId: null,
        offerRounds: conversation.booking.offerRounds + 1,
        address,
      });
    },
  };
}

// They were offered numbered times.
export async function planChoice(
  msg: BookingMsg,
  conversation: Conversation,
  latest: string,
  model: ConversationModel,
  deps: ConversationDeps,
): Promise<BookingPlan> {
  const { config } = msg;
  const { offeredSlots } = conversation.booking;
  let choice = parseSlotNumber(latest, offeredSlots.length);
  let info: ModelCallInfo | undefined;
  if (choice === null) {
    const picked = await model.chooseSlot({
      latest,
      options: offeredSlots.map((s) => formatSlot(s, config.timezone)),
    });
    info = picked.info;
    if (picked.result.wantsOtherTime) return handOff("wants_other_time", info);
    choice = picked.result.choice;
  }
  const slot = choice ? offeredSlots[choice - 1] : undefined;
  if (!slot) {
    // Unclear: show the same options again (the question limit still applies).
    return {
      action: "offer_times",
      reason: "unclear_choice",
      message: { kind: "offer_times", slots: offeredSlots.map((s) => formatSlot(s, config.timezone)) },
      info,
    };
  }
  // They took a while to answer: don't confirm a time that's now too close.
  if (slot.getTime() < nowFrom(deps).getTime() + MIN_LEAD_MINUTES * 60_000) {
    return reoffer(msg, conversation, "expired", conversation.booking.address, info, deps);
  }
  // The address from an earlier round (their first pick was taken).
  if (conversation.booking.address) return planBook(msg, conversation, slot, conversation.booking.address, info, deps);
  return {
    action: "ask_address",
    message: { kind: "ask_address", slot: formatSlot(slot, config.timezone) },
    info,
    apply: () => deps.store.setBooking(conversation.id, { stage: "asking_address", chosenSlot: slot }),
  };
}

// They picked a time and were asked for the address.
export async function planAddressAndBook(
  msg: BookingMsg,
  conversation: Conversation,
  latest: string,
  askedAgain: boolean,
  model: ConversationModel,
  deps: ConversationDeps,
): Promise<BookingPlan> {
  const slot = conversation.booking.chosenSlot;
  const { address, info } = await model.extractAddress({ latest });
  if (!slot) return handOff("no_chosen_slot", info);
  if (!address) {
    if (askedAgain) return handOff("no_address", info);
    return {
      action: "ask_address",
      reason: "unclear_address",
      message: { kind: "ask_address", slot: formatSlot(slot, msg.config.timezone), again: true },
      info,
    };
  }
  return planBook(msg, conversation, slot, address, info, deps);
}

// Hold the time, check it's still free, then create the event.
async function planBook(
  msg: BookingMsg,
  conversation: Conversation,
  slot: Date,
  address: string,
  info: ModelCallInfo | undefined,
  deps: ConversationDeps,
): Promise<BookingPlan> {
  const { config, tenantId } = msg;
  if (slot.getTime() < nowFrom(deps).getTime() + MIN_BOOK_MINUTES * 60_000) {
    return reoffer(msg, conversation, "expired", address, info, deps);
  }
  const client = await calendar(msg, deps);
  if (client === "revoked") {
    await onRevoked(tenantId, deps);
    return handOff("calendar_revoked", info);
  }
  if (!client) return handOff("calendar_unavailable", info);

  const end = new Date(slot.getTime() + config.calendar.estimateDurationMinutes * 60_000);
  let held = false;
  try {
    // The hold stops two customers booking the same time at once; the busy
    // check catches anything the owner added since we offered it.
    held = await deps.store.claimEstimateSlot(tenantId, conversation.id, slot, end, BUFFER_MINUTES);
    const busy = held
      ? await client.busy(new Date(slot.getTime() - BUFFER_MINUTES * 60_000), new Date(end.getTime() + BUFFER_MINUTES * 60_000))
      : [];
    if (!held || busy.length) {
      if (held) await release(msg, conversation, deps);
      return reoffer(msg, conversation, "taken", address, info, deps);
    }
    const eventId = eventIdFor(conversation.id, slot);
    // Saved before calling Google: a retry finishes this booking instead of
    // seeing its own event as busy and offering new times.
    await deps.store.setBooking(conversation.id, { stage: "booking", chosenSlot: slot, bookedEventId: eventId, address });
    return createAndConfirm(msg, conversation, slot, address, eventId, info, client, deps);
  } catch (err) {
    if (err instanceof CalendarAuthError) await onRevoked(tenantId, deps);
    deps.log("booking.calendar_unavailable", { tenantId, step: "check", error: errorLabel(err) });
    if (held) await release(msg, conversation, deps);
    return handOff("calendar_unavailable", info);
  }
}

// An earlier attempt got as far as creating the event (stage "booking" or
// "booked") but didn't confirm with the customer: finish it.
export async function planResumeBooking(
  msg: BookingMsg,
  conversation: Conversation,
  deps: ConversationDeps,
): Promise<BookingPlan> {
  const { chosenSlot: slot, address, bookedEventId } = conversation.booking;
  if (!slot || !address || !bookedEventId) return handOff("booking_uncertain", undefined, "handoff");
  const client = await calendar(msg, deps);
  if (!client || client === "revoked") {
    if (client === "revoked") await onRevoked(msg.tenantId, deps);
    return uncertain(msg, slot, address);
  }
  return createAndConfirm(msg, conversation, slot, address, bookedEventId, undefined, client, deps);
}

function uncertain(msg: BookingMsg, slot: Date, address: string): BookingPlan {
  const booking = { slot: formatSlot(slot, msg.config.timezone), address };
  return {
    ...handOff("booking_uncertain", undefined, "handoff"),
    terminal: { status: "handed_off", outcome: "needs_you", reason: "booking_uncertain", booking },
  };
}

async function release(msg: BookingMsg, conversation: Conversation, deps: ConversationDeps): Promise<void> {
  await deps.store.releaseEstimateSlot(msg.tenantId, conversation.id).catch((err) =>
    deps.log("booking.release_failed", { tenantId: msg.tenantId, conversationId: conversation.id, error: errorLabel(err) }),
  );
}

async function createAndConfirm(
  msg: BookingMsg,
  conversation: Conversation,
  slot: Date,
  address: string,
  eventId: string,
  info: ModelCallInfo | undefined,
  client: CalendarClient,
  deps: ConversationDeps,
): Promise<BookingPlan> {
  const { config, tenantId } = msg;
  const end = new Date(slot.getTime() + config.calendar.estimateDurationMinutes * 60_000);
  const service = config.services.find((s) => s.id === conversation.details.serviceId)?.name ?? "Estimate";
  let result: "created" | "exists" | "cancelled";
  try {
    // The id makes a retry a no-op.
    result = await client.createEvent({
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
  } catch (err) {
    deps.log("booking.create_failed", { tenantId, conversationId: conversation.id, error: errorLabel(err) });
    if (err instanceof CalendarAuthError) {
      // Google refused outright: nothing was created.
      await onRevoked(tenantId, deps);
      await release(msg, conversation, deps);
      return handOff("calendar_revoked", info);
    }
    // A timeout may have happened after Google created it: tell the owner to check.
    return { ...uncertain(msg, slot, address), info };
  }
  if (result === "cancelled") {
    // The owner deleted this exact event: don't put it back.
    await release(msg, conversation, deps);
    return handOff("event_cancelled", info);
  }

  const slotLabel = formatSlot(slot, config.timezone);
  const booking = { slot: slotLabel, address };
  // The event exists; a failure to record that is logged, not fatal.
  await deps.store
    .setBooking(conversation.id, { stage: "booked" })
    .catch((err) => deps.log("booking.save_failed", { tenantId, conversationId: conversation.id, error: errorLabel(err) }));
  if (msg.leadId) {
    await deps.store
      .updateLeadAddress(tenantId, msg.leadId, address)
      .catch((err) => deps.log("booking.lead_address_failed", { tenantId, conversationId: conversation.id, error: errorLabel(err) }));
  }
  return {
    action: "booked",
    message: { kind: "booked", slot: slotLabel },
    info,
    onCalendar: booking,
    terminal: { status: "completed", outcome: "booked", reason: "booked", booking },
  };
}
