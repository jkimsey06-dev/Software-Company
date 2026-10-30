import { describe, expect, it } from "vitest";
import { handleDialStatus, handleIncomingCall } from "./handle-call";
import {
  BASE_URL,
  BUSINESS_NUMBER,
  CALLER,
  CALL_SID,
  FakeSender,
  FakeStore,
  OWNER_PHONE,
  TENANT_ID,
  recordingLogger,
  textingConfig,
} from "./test-helpers";
import { SmsSendError } from "./types";

function setup(store = new FakeStore()) {
  const sender = new FakeSender();
  const log = recordingLogger();
  return { store, sender, log, deps: { store, sender, log, publicBaseUrl: BASE_URL } };
}

const missedCall = (overrides: Partial<{ callSid: string; from: string; dialStatus: string }> = {}) => ({
  callSid: CALL_SID,
  from: CALLER,
  to: BUSINESS_NUMBER,
  dialStatus: "no-answer",
  ...overrides,
});

describe("handleIncomingCall", () => {
  it("records the call and rings the owner with the configured timeout", async () => {
    const { store, deps } = setup();
    const twiml = await handleIncomingCall({ callSid: CALL_SID, from: CALLER, to: BUSINESS_NUMBER }, deps);
    expect(twiml).toContain(`<Dial timeout="18" action="${BASE_URL}/api/twilio/voice/status" method="POST">`);
    expect(twiml).toContain(`<Number>${OWNER_PHONE}</Number>`);
    expect(store.calls.get(CALL_SID)?.outcome).toBeNull();
  });

  it("still forwards the call if logging it fails", async () => {
    const store = new FakeStore();
    store.failOn.add("recordInboundCall");
    const { deps, log } = setup(store);
    const twiml = await handleIncomingCall({ callSid: CALL_SID, from: CALLER, to: BUSINESS_NUMBER }, deps);
    expect(twiml).toContain(`<Number>${OWNER_PHONE}</Number>`);
    expect(log.events).toContain("voice.record_call_failed");
  });

  it("does not forward calls to numbers no tenant owns", async () => {
    const { store, deps } = setup();
    const twiml = await handleIncomingCall({ callSid: CALL_SID, from: CALLER, to: "+14235559999" }, deps);
    expect(twiml).not.toContain("<Dial");
    expect(twiml).toContain("<Hangup/>");
    expect(store.calls.size).toBe(0);
  });
});

describe("handleDialStatus", () => {
  it("saves a lead and texts the caller back once, from the tenant's number", async () => {
    const { store, sender, deps } = setup();
    const twiml = await handleDialStatus(missedCall(), deps);

    expect(store.leads).toEqual([{ id: "lead-1", tenantId: TENANT_ID, phone: CALLER }]);
    expect(store.calls.get(CALL_SID)).toMatchObject({ outcome: "missed", leadId: "lead-1" });
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toMatchObject({ from: BUSINESS_NUMBER, to: CALLER });
    expect(sender.sent[0]?.body).toContain("Reply STOP to opt out");
    expect(store.message()).toMatchObject({
      status: "sent",
      idempotencyKey: `missed-call-textback:${CALL_SID}`,
      templateVersion: "missed-call-textback@v1",
    });
    expect(twiml).toContain("<Say>");
  });

  it.each(["no-answer", "busy", "failed", "canceled"])("treats %s as a missed call", async (status) => {
    const { sender, deps } = setup();
    await handleDialStatus(missedCall({ dialStatus: status }), deps);
    expect(sender.sent).toHaveLength(1);
  });

  it("does nothing more for answered calls", async () => {
    const { store, sender, deps } = setup();
    await handleDialStatus(missedCall({ dialStatus: "completed" }), deps);
    expect(store.calls.get(CALL_SID)?.outcome).toBe("answered");
    expect(store.leads).toHaveLength(0);
    expect(sender.sent).toHaveLength(0);
  });

  it("does not text on an unrecognized dial status", async () => {
    const { sender, log, deps } = setup();
    await handleDialStatus(missedCall({ dialStatus: "something-new" }), deps);
    expect(sender.sent).toHaveLength(0);
    expect(log.events).toContain("dial_status.unrecognized");
  });

  it("sends one text when the same webhook arrives twice", async () => {
    const { sender, deps } = setup();
    await handleDialStatus(missedCall(), deps);
    await handleDialStatus(missedCall(), deps);
    expect(sender.sent).toHaveLength(1);
  });

  it("sends one text when duplicate webhooks arrive concurrently", async () => {
    const { sender, deps } = setup();
    await Promise.all([1, 2, 3].map(() => handleDialStatus(missedCall(), deps)));
    expect(sender.sent).toHaveLength(1);
  });

  it("never texts if the message was already claimed, even if the call outcome was lost", async () => {
    const { store, sender, deps } = setup();
    await handleDialStatus(missedCall(), deps);
    store.calls.clear(); // e.g. outcome write lost; the message ledger still holds
    await handleDialStatus(missedCall(), deps);
    expect(sender.sent).toHaveLength(1);
  });

  it("saves the lead but does not text until A2P is approved", async () => {
    const { store, sender, log, deps } = setup(
      new FakeStore(textingConfig({ messaging: { a2pStatus: "pending" } })),
    );
    await handleDialStatus(missedCall(), deps);
    expect(store.leads).toHaveLength(1);
    expect(sender.sent).toHaveLength(0);
    expect(store.messages.size).toBe(0);
    expect(log.lines.join()).toContain("a2p_not_approved");
  });

  it("does not text a caller who opted out", async () => {
    const store = new FakeStore();
    await store.addOptOut(TENANT_ID, CALLER);
    const { sender, deps } = setup(store);
    await handleDialStatus(missedCall(), deps);
    expect(sender.sent).toHaveLength(0);
    expect(store.leads).toHaveLength(1);
  });

  it("does not text the owner's own forwarding number", async () => {
    const { sender, deps } = setup();
    await handleDialStatus(missedCall({ from: OWNER_PHONE }), deps);
    expect(sender.sent).toHaveLength(0);
  });

  it.each(["anonymous", "restricted", "", "+1"])("skips lead and text for withheld caller ID %j", async (from) => {
    const { store, sender, deps } = setup();
    await handleDialStatus(missedCall({ from }), deps);
    expect(store.leads).toHaveLength(0);
    expect(sender.sent).toHaveLength(0);
    expect(store.calls.get(CALL_SID)?.outcome).toBe("missed");
  });

  it("ignores numbers no tenant owns", async () => {
    const { store, sender, deps } = setup();
    await handleDialStatus({ ...missedCall(), to: "+14235559999" }, deps);
    expect(store.calls.size).toBe(0);
    expect(sender.sent).toHaveLength(0);
  });

  it("marks a rejected send as failed and does not retry", async () => {
    const { store, sender, deps } = setup();
    sender.failWith = new SmsSendError("rejected", "21211", "invalid number");
    await handleDialStatus(missedCall(), deps);
    sender.failWith = null;
    await handleDialStatus(missedCall(), deps);
    expect(store.message()).toMatchObject({ status: "failed", detail: "21211" });
    expect(sender.sent).toHaveLength(0);
  });

  it("records a carrier opt-out when Twilio says the caller unsubscribed", async () => {
    const { store, sender, deps } = setup();
    sender.failWith = new SmsSendError("rejected", "21610", "unsubscribed");
    await handleDialStatus(missedCall(), deps);
    expect(await store.isOptedOut(TENANT_ID, CALLER)).toBe(true);
  });

  it("marks a timed-out send as unknown and never resends it", async () => {
    const { store, sender, log, deps } = setup();
    sender.failWith = new SmsSendError("unknown", "network", "timeout");
    const twiml = await handleDialStatus(missedCall(), deps);
    expect(store.message()?.status).toBe("unknown");
    expect(twiml).not.toContain("<Say>");

    sender.failWith = null;
    await handleDialStatus(missedCall(), deps);
    expect(sender.sent).toHaveLength(0);
    expect(log.events).toContain("textback.send_failed");
  });

  it("treats an unexpected sender error as unknown", async () => {
    const { store, sender, deps } = setup();
    sender.failWith = new Error("boom");
    await handleDialStatus(missedCall(), deps);
    expect(store.message()?.status).toBe("unknown");
  });

  it("does not send if the database is down before the message is claimed", async () => {
    const store = new FakeStore();
    store.failOn.add("claimOutboundMessage");
    const { sender, deps } = setup(store);
    await expect(handleDialStatus(missedCall(), deps)).rejects.toThrow();
    expect(sender.sent).toHaveLength(0);
  });

  it("never logs phone numbers or message text", async () => {
    const { log, deps, sender } = setup();
    await handleDialStatus(missedCall(), deps);
    const output = log.lines.join("\n");
    expect(output).not.toContain(CALLER.slice(2));
    expect(output).not.toContain(BUSINESS_NUMBER.slice(2));
    expect(output).not.toContain(sender.sent[0]?.body.slice(0, 20));
  });
});
