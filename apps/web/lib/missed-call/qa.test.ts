// QA: break-it tests for the missed-call flow. Fakes only; nothing is sent.
import type { SupabaseClient } from "@supabase/supabase-js";
import twilio from "twilio";
import { describe, expect, it } from "vitest";
import { handleDialStatus, handleIncomingCall } from "./handle-call";
import { dialStatusRoute, voiceRoute, type RouteDeps } from "./routes";
import { createSupabaseStore } from "./supabase-store";
import {
  BASE_URL,
  BUSINESS_NUMBER,
  CALLER,
  CALL_SID,
  FakeSender,
  FakeStore,
  TENANT_ID,
  recordingLogger,
} from "./test-helpers";
import { SmsSendError, type MessageUpdate } from "./types";

const AUTH_TOKEN = "test-auth-token-not-real";
const VOICE = "/api/twilio/voice";
const STATUS = "/api/twilio/voice/status";
const sid = (c: string) => `CA${c.repeat(32)}`;

// FakeStore with one-shot or persistent failures on methods FakeStore can't fail.
class FlakyStore extends FakeStore {
  failOnce = new Set<string>();
  failAlways = new Set<string>();
  private trip(name: string) {
    if (this.failAlways.has(name)) throw new Error(`${name} unavailable`);
    if (this.failOnce.delete(name)) throw new Error(`${name} unavailable`);
  }
  override async markMessage(id: string, update: MessageUpdate) {
    this.trip("markMessage");
    return super.markMessage(id, update);
  }
  override async linkCallToLead(t: string, c: string, l: string) {
    this.trip("linkCallToLead");
    return super.linkCallToLead(t, c, l);
  }
  override async findOrCreateMissedCallLead(t: string, p: string) {
    this.trip("findOrCreateMissedCallLead");
    return super.findOrCreateMissedCallLead(t, p);
  }
}

function setup(store: FakeStore = new FakeStore()) {
  const sender = new FakeSender();
  const log = recordingLogger();
  const deps: RouteDeps = { store, sender, log, publicBaseUrl: BASE_URL, twilioAuthToken: AUTH_TOKEN };
  return { store, sender, log, deps };
}

const missed = (o: Partial<{ callSid: string; from: string; dialStatus: string }> = {}) => ({
  callSid: CALL_SID,
  from: CALLER,
  to: BUSINESS_NUMBER,
  dialStatus: "no-answer",
  ...o,
});

function signed(path: string, params: Record<string, string>) {
  return new Request(`http://internal.local${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${BASE_URL}${path}`, params),
    },
    body: new URLSearchParams(params).toString(),
  });
}

describe("QA: hostile / malformed Twilio params (signed)", () => {
  const base = { CallSid: CALL_SID, From: CALLER, To: BUSINESS_NUMBER, DialCallStatus: "no-answer" };
  it.each([
    ["empty body", {}],
    ["missing To", { CallSid: CALL_SID, From: CALLER, DialCallStatus: "no-answer" }],
    ["uppercase CallSid", { ...base, CallSid: `CA${"A".repeat(32)}` }],
    ["CallSid with SQL", { ...base, CallSid: `CA'; drop table calls;--` }],
    ["To not E.164", { ...base, To: "4235550150" }],
    ["To with trailing newline", { ...base, To: `${BUSINESS_NUMBER}\n` }],
    ["huge From", { ...base, From: "+1".padEnd(10_000, "9") }],
    ["huge DialCallStatus", { ...base, DialCallStatus: "x".repeat(5000) }],
    ["empty DialCallStatus", { ...base, DialCallStatus: "" }],
  ])("rejects %s with 400 and sends nothing", async (_n, params) => {
    const { deps, sender, store } = setup();
    const res = await dialStatusRoute(() => deps)(signed(STATUS, params as Record<string, string>));
    expect(res.status).toBe(400);
    expect(sender.sent).toHaveLength(0);
    expect(store.leads).toHaveLength(0);
  });

  it.each(["anonymous", "restricted", "😀📞", "+1 (423) 555-0111", `${CALLER}\n`, "+0123456789"])(
    "From=%j: logs the missed call, no lead, no text",
    async (from) => {
      const { deps, sender, store } = setup();
      const res = await dialStatusRoute(() => deps)(signed(STATUS, { ...base, From: from }));
      expect(res.status).toBe(200);
      expect(sender.sent).toHaveLength(0);
      expect(store.leads).toHaveLength(0);
    },
  );

  it("voice webhook returns 500 (so Twilio's fallback forwards) when tenant lookup is down", async () => {
    const store = new FakeStore();
    store.failOn.add("findTenantByNumber");
    const { deps } = setup(store);
    await expect(voiceRoute(() => deps)(signed(VOICE, base))).rejects.toThrow();
  });

  it("status webhook hangs up cleanly and sends nothing when tenant lookup is down", async () => {
    const store = new FakeStore();
    store.failOn.add("findTenantByNumber");
    const { deps, sender } = setup(store);
    const res = await dialStatusRoute(() => deps)(signed(STATUS, base));
    expect(await res.text()).toContain("<Hangup/>");
    expect(sender.sent).toHaveLength(0);
  });
});

describe("QA: duplicates and out-of-order webhooks", () => {
  it("status before voice webhook: one text, late voice webhook does not reset the outcome", async () => {
    const { deps, store, sender } = setup();
    await handleDialStatus(missed(), deps);
    await handleIncomingCall({ callSid: CALL_SID, from: CALLER, to: BUSINESS_NUMBER }, deps);
    await handleDialStatus(missed(), deps);
    expect(sender.sent).toHaveLength(1);
    expect(store.calls.get(CALL_SID)?.outcome).toBe("missed");
  });

  it("10 concurrent duplicate status webhooks: exactly one text, one lead, one message", async () => {
    const { deps, store, sender } = setup();
    await Promise.all(Array.from({ length: 10 }, () => handleDialStatus(missed(), deps)));
    expect(sender.sent).toHaveLength(1);
    expect(store.leads).toHaveLength(1);
    expect(store.messages.size).toBe(1);
  });

  it("answered then a late 'no-answer' for the same call: no text", async () => {
    const { deps, sender } = setup();
    await handleDialStatus(missed({ dialStatus: "completed" }), deps);
    await handleDialStatus(missed({ dialStatus: "no-answer" }), deps);
    expect(sender.sent).toHaveLength(0);
  });

  it("status for a call to a number no tenant owns: nothing recorded or sent", async () => {
    const { deps, store, sender } = setup();
    await handleDialStatus({ ...missed(), to: "+14235559999" }, deps);
    expect(store.calls.size).toBe(0);
    expect(sender.sent).toHaveLength(0);
  });

  // FINDING (policy): each missed call is its own idempotency key, so a caller
  // who redials 3 times in 2 minutes gets 3 identical texts.
  it("same caller missing 3 times in a row gets one text-back, not three", async () => {
    const { deps, store, sender } = setup();
    for (const c of ["b", "c", "d"]) await handleDialStatus(missed({ callSid: sid(c) }), deps);
    expect(store.leads).toHaveLength(1);
    expect(sender.sent).toHaveLength(1);
  });
});

describe("QA: provider/database outages mid-flow", () => {
  // FINDING: setCallOutcome commits before the lead is created. If the lead
  // insert fails, the route returns 200 <Hangup/>, Twilio never retries, and any
  // redelivery is treated as a duplicate. The lead is lost and nobody hears.
  it("a lead-insert blip does not permanently lose the lead on redelivery", async () => {
    const store = new FlakyStore();
    store.failOnce.add("findOrCreateMissedCallLead");
    const { deps, sender } = setup(store);
    await expect(handleDialStatus(missed(), deps)).rejects.toThrow();
    await handleDialStatus(missed(), deps); // redelivery after recovery
    expect(store.leads).toHaveLength(1);
    expect(sender.sent).toHaveLength(1);
  });

  it("a linkCallToLead blip does not permanently skip the text-back on redelivery", async () => {
    const store = new FlakyStore();
    store.failOnce.add("linkCallToLead");
    const { deps, sender } = setup(store);
    await expect(handleDialStatus(missed(), deps)).rejects.toThrow();
    await handleDialStatus(missed(), deps);
    expect(sender.sent).toHaveLength(1);
  });

  it("isOptedOut down: no text (fail closed)", async () => {
    const store = new FakeStore();
    store.failOn.add("isOptedOut");
    const { deps, sender } = setup(store);
    await expect(handleDialStatus(missed(), deps)).rejects.toThrow();
    expect(sender.sent).toHaveLength(0);
  });

  // FINDING: markMessage('sent') is inside the try around send(). If it throws
  // after Twilio accepted the text, the catch block relabels a delivered text as
  // 'unknown'/'unexpected' and drops the provider SID.
  it("markMessage blip after a successful send keeps status 'sent' with the SID", async () => {
    const store = new FlakyStore();
    store.failOnce.add("markMessage");
    const { deps, sender, log } = setup(store);
    await handleDialStatus(missed(), deps).catch(() => undefined);
    expect(sender.sent).toHaveLength(1);
    expect(store.message()?.status).toBe("sent");
    expect(log.events).not.toContain("textback.send_failed");
  });

  it("markMessage down after a successful send: still exactly one text, even on redelivery", async () => {
    const store = new FlakyStore();
    store.failAlways.add("markMessage");
    const { deps, sender } = setup(store);
    const res = await dialStatusRoute(() => deps)(
      signed(STATUS, { CallSid: CALL_SID, From: CALLER, To: BUSINESS_NUMBER, DialCallStatus: "no-answer" }),
    );
    expect(await res.text()).toContain("<Hangup/>");
    await handleDialStatus(missed(), deps).catch(() => undefined);
    expect(sender.sent).toHaveLength(1);
  });

  // FINDING: if markMessage fails on the 21610 path, addOptOut is never reached.
  it("carrier opt-out (21610) is recorded even if marking the message fails", async () => {
    const store = new FlakyStore();
    store.failOnce.add("markMessage");
    const { deps, sender } = setup(store);
    sender.failWith = new SmsSendError("rejected", "21610", "unsubscribed");
    await handleDialStatus(missed(), deps).catch(() => undefined);
    expect(store.optOuts.has(`${TENANT_ID}:${CALLER}`)).toBe(true);
  });

  it("opted-out caller is never texted on any missed status or redelivery", async () => {
    const { deps, store, sender } = setup();
    store.optOuts.add(`${TENANT_ID}:${CALLER}`);
    const statuses = ["no-answer", "busy", "failed", "canceled"];
    for (const [i, s] of statuses.entries()) {
      await handleDialStatus(missed({ callSid: sid(String(i + 1)), dialStatus: s }), deps);
    }
    expect(sender.sent).toHaveLength(0);
  });
});

describe("QA: status classification", () => {
  // FINDING: an unrecognized DialCallStatus is stored as outcome 'answered',
  // so the call disappears from missed-call reporting and no lead is saved.
  it("an unrecognized dial status is not recorded as 'answered'", async () => {
    const { deps, store, sender } = setup();
    await handleDialStatus(missed({ dialStatus: "something-new" }), deps);
    expect(sender.sent).toHaveLength(0);
    expect(store.calls.get(CALL_SID)?.outcome).not.toBe("answered");
  });

  // FINDING (minor): only forwardToNumber is excluded; a call from the
  // tenant's own business/texting number would be texted back.
  it("does not text the tenant's own business number", async () => {
    const { deps, sender } = setup();
    await handleDialStatus(missed({ from: BUSINESS_NUMBER }), deps);
    expect(sender.sent).toHaveLength(0);
  });
});

// Minimal chainable stand-in for the Supabase query builder.
function stubDb(row: unknown): SupabaseClient {
  const chain: Record<string, unknown> = {};
  const self = new Proxy(chain, {
    get: (_t, prop) =>
      prop === "maybeSingle" ? async () => ({ data: row, error: null }) : () => self,
  });
  return { from: () => self } as unknown as SupabaseClient;
}

describe("QA: invalid tenant config", () => {
  // FINDING: supabase-store returns null for an invalid config, so the voice
  // webhook answers 200 "this number is not in service" and hangs up. Twilio's
  // fallback (forward to owner) never fires; a config typo drops every call.
  it("a tenant with an invalid config still has calls reach the owner (or errors to fallback)", async () => {
    const log = recordingLogger();
    const store = createSupabaseStore(
      stubDb({ tenant_id: TENANT_ID, tenants: { config: { schemaVersion: 1, slug: "Bad Slug" } } }),
      log,
    );
    const deps = { store, sender: new FakeSender(), log, publicBaseUrl: BASE_URL };
    let twiml: string | undefined;
    try {
      twiml = await handleIncomingCall({ callSid: CALL_SID, from: CALLER, to: BUSINESS_NUMBER }, deps);
    } catch {
      return; // throwing => 500 => Twilio fallback forwards to owner: acceptable
    }
    expect(twiml).not.toContain("not in service");
  });

  it("a tenant with an invalid config never gets a text sent", async () => {
    const log = recordingLogger();
    const store = createSupabaseStore(stubDb({ tenant_id: TENANT_ID, tenants: { config: {} } }), log);
    const sender = new FakeSender();
    await handleDialStatus(missed(), { store, sender, log, publicBaseUrl: BASE_URL }).catch(() => undefined);
    expect(sender.sent).toHaveLength(0);
    expect(log.events).toContain("tenant.config_invalid");
  });
});
