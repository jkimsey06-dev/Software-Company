// QA: flow bugs in run-turn.ts found with the fake store and fake model.
// All were fixed; these now guard the behavior.
import { describe, expect, it } from "vitest";
import { BUSINESS_NUMBER, CALLER, TENANT_ID, FakeSender, recordingLogger, textingConfig } from "../missed-call/test-helpers";
import { SmsSendError } from "../missed-call/types";
import { notificationDeps } from "../notifications/test-helpers";
import { MAX_AI_REPLIES, handleCustomerMessage } from "./run-turn";
import { FakeConversationStore, FakeModel, understood } from "./test-helpers";

const TEXTBACK = "Hi, this is the AI assistant for Example Heating & Air. Sorry we missed your call! Reply STOP to opt out";

function setup() {
  const config = textingConfig();
  const store = new FakeConversationStore();
  store.ownedNumbers.set(BUSINESS_NUMBER, TENANT_ID);
  store.businessSaid(TENANT_ID, CALLER, TEXTBACK);
  const model = new FakeModel();
  const sender = new FakeSender();
  const n = notificationDeps();
  const deps = { store, sender, modelFor: () => model, notifications: n.deps, log: recordingLogger(), leaseWaitMs: 0 };
  let sid = 0;
  const say = async (text: string) => {
    sid += 1;
    const messageSid = `SM${String(sid).padStart(32, "0")}`;
    store.customerSays(TENANT_ID, CALLER, text, messageSid);
    return handleCustomerMessage(
      { tenantId: TENANT_ID, config, customerPhone: CALLER, businessNumber: BUSINESS_NUMBER, leadId: "lead-1", messageSid, body: text },
      deps,
    );
  };
  return { store, model, sender, email: n.email, say, conv: () => store.conversations[0]! };
}

describe("QA flow: details and completion", () => {
  it("passes details learned in earlier turns to the model as `known`", async () => {
    const s = setup();
    s.model.understandings.push(understood({ details: { serviceId: "ac-repair" } }));
    await s.say("AC repair please");
    await s.say("Cleveland");
    expect(s.model.knownSeen[1]?.serviceId).toBe("ac-repair");
  });

  it("completes when the three details arrive over separate turns", async () => {
    const s = setup();
    s.model.understandings.push(understood({ details: { serviceId: "ac-repair" } }));
    s.model.understandings.push(understood({ details: { area: "Cleveland" } }));
    s.model.understandings.push(understood({ details: { urgency: "soon" } }));
    await s.say("AC repair");
    await s.say("Cleveland");
    await s.say("this week");
    expect(s.conv().status).toBe("completed");
  });

  it("does not tell an out-of-area customer 'they'll reach out to set up a time'", async () => {
    const s = setup();
    s.model.understandings.push(understood({ details: { serviceId: "ac-repair", area: "Nashville", urgency: "soon" } }));
    await s.say("AC repair in Nashville this week");
    expect(s.sender.sent[0]?.body).not.toContain("set up a time");
  });
});

describe("QA flow: silence and uninformed owner", () => {
  it("rejected send: customer got nothing, so the owner must hear about it", async () => {
    const s = setup();
    s.sender.failWith = new SmsSendError("rejected", "30003", "unreachable");
    await s.say("my AC is out");
    expect(s.email.sent.length).toBeGreaterThan(0);
  });

  it("rejected send: the model is not called again and replies are not over-counted", async () => {
    const s = setup();
    s.sender.failWith = new SmsSendError("rejected", "30003", "unreachable");
    await s.say("my AC is out");
    expect(s.model.understandCalls).toBe(1);
    expect(s.conv().aiReplies).toBeLessThanOrEqual(1);
  });

  it("STOP arriving mid-turn: no extra model calls, no inflated reply count", async () => {
    const s = setup();
    s.model.onClassify = () => s.store.optedOut.add(`${TENANT_ID}:${CALLER}`);
    await s.say("my AC is out");
    expect(s.sender.sent).toHaveLength(0);
    expect(s.model.classifyCalls).toBe(1);
    expect(s.conv().aiReplies).toBe(0);
  });

  it("a failed lease release doesn't swallow the customer's next text", async () => {
    const s = setup();
    s.store.failReleaseOnce = true;
    await s.say("my AC is out");
    await s.say("hello? anyone?");
    const answered = s.sender.sent.length === 2;
    const ownerTold = s.email.sent.length > 0;
    expect(answered || ownerTold).toBe(true);
  });

  it("an emergency after the conversation completed still gets the 911 text", async () => {
    const s = setup();
    s.model.understandings.push(understood({ details: { serviceId: "ac-repair", area: "Cleveland", urgency: "soon" } }));
    await s.say("AC repair in Cleveland, soon");
    await s.say("now I smell gas in the kitchen");
    expect(s.sender.sent.map((m) => m.body).some((b) => b.includes("call 911"))).toBe(true);
  });
});

describe("QA flow: loops and caps", () => {
  it("repeated 'are you a bot?' is capped like other replies", async () => {
    const s = setup();
    for (let i = 0; i < MAX_AI_REPLIES + 4; i++) await s.say("are you a bot?");
    expect(s.sender.sent.length).toBeLessThanOrEqual(MAX_AI_REPLIES + 1);
  });

  it("same message delivered twice concurrently: one reply", async () => {
    const s = setup();
    s.store.customerSays(TENANT_ID, CALLER, "AC out", "SMdup");
    const msg = { tenantId: TENANT_ID, config: textingConfig(), customerPhone: CALLER, businessNumber: BUSINESS_NUMBER, leadId: "lead-1", messageSid: "SMdup", body: "AC out" };
    const deps = { store: s.store, sender: s.sender, modelFor: () => s.model, notifications: null, log: recordingLogger(), leaseWaitMs: 0 };
    await Promise.all([handleCustomerMessage(msg, deps), handleCustomerMessage(msg, deps)]);
    expect(s.sender.sent).toHaveLength(1);
  });

  it("emergency with Twilio down: owner still emailed", async () => {
    const s = setup();
    s.sender.failWith = new SmsSendError("unknown", "timeout", "timeout");
    await s.say("I smell gas");
    expect(s.email.sent[0]?.subject).toContain("EMERGENCY");
  });
});
