import { describe, expect, it } from "vitest";
import { handleDialStatus } from "../missed-call/handle-call";
import {
  BASE_URL,
  BUSINESS_NUMBER,
  CALLER,
  CALL_SID,
  FakeSender,
  FakeStore,
  TENANT_ID,
  recordingLogger,
  textingConfig,
} from "../missed-call/test-helpers";
import { SmsSendError } from "../missed-call/types";
import { MAX_ATTEMPTS, sendDueNotifications, sendNotification } from "./dispatch";
import { createOpsAlert } from "./ops-alert";
import { createOwnerNotifier } from "./owner";
import { formatPhone, renderNewLeadEmail } from "./templates";
import { EmailSendError, FakeEmail, manualSchedule, notificationDeps } from "./test-helpers";

const OWNER_EMAIL = "owner@example.com";

function callFlow(config = textingConfig()) {
  const n = notificationDeps();
  const timer = manualSchedule();
  const store = new FakeStore(config);
  const sender = new FakeSender();
  const deps = {
    store,
    sender,
    log: recordingLogger(),
    publicBaseUrl: BASE_URL,
    notifyOwner: createOwnerNotifier(n.deps, timer.schedule),
  };
  return { ...n, outbox: n.store, timer, store, sender, deps };
}

const missed = (overrides: Partial<{ callSid: string; from: string; dialStatus: string }> = {}) => ({
  callSid: CALL_SID,
  from: CALLER,
  to: BUSINESS_NUMBER,
  dialStatus: "no-answer",
  ...overrides,
});

describe("owner email for a missed call", () => {
  it("queues one email per new lead and sends it after the response", async () => {
    const { deps, email, timer, store } = callFlow();
    await handleDialStatus(missed(), deps);
    expect(email.sent).toHaveLength(0); // nothing sent before Twilio gets its answer
    expect(timer.pending).toBe(1);

    await timer.runAll();
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({ to: OWNER_EMAIL, subject: `Missed call: ${formatPhone(CALLER)}` });
    expect(email.sent[0]?.text).toContain("We texted them back");
    expect(email.sent[0]?.idempotencyKey).toMatch(/^notification:/);
    expect(store.leads).toHaveLength(1);
  });

  it("does not email again when the same caller calls back", async () => {
    const { deps, email, timer } = callFlow();
    await handleDialStatus(missed(), deps);
    await handleDialStatus(missed({ callSid: `CA${"b".repeat(32)}` }), deps);
    await timer.runAll();
    expect(email.sent).toHaveLength(1);
  });

  it("emails even when no text-back was sent, saying why", async () => {
    const { deps, email, timer } = callFlow(textingConfig({ messaging: { a2pStatus: "pending" } }));
    await handleDialStatus(missed(), deps);
    await timer.runAll();
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.text).toContain("Texting isn't switched on");
    expect(email.sent[0]?.text).toContain("Please call them back");
  });

  it("tells the owner when the text-back failed", async () => {
    const { deps, email, timer, sender } = callFlow();
    sender.failWith = new SmsSendError("rejected", "30007", "filtered");
    await handleDialStatus(missed(), deps);
    await timer.runAll();
    expect(email.sent[0]?.text).toContain("didn't go through");
  });

  it("sends a follow-up when a repeat caller's text-back fails", async () => {
    const { deps, email, timer, sender } = callFlow();
    sender.failWith = new SmsSendError("rejected", "30007", "filtered");
    await handleDialStatus(missed(), deps);
    await handleDialStatus(missed({ callSid: `CA${"b".repeat(32)}` }), deps);
    await timer.runAll();
    expect(email.sent.map((e) => e.subject)).toEqual([
      `Missed call: ${formatPhone(CALLER)}`,
      `Text-back failed: ${formatPhone(CALLER)}`,
    ]);
  });

  it("sends nothing for answered calls or withheld caller ID", async () => {
    const { deps, email, timer } = callFlow();
    await handleDialStatus(missed({ dialStatus: "completed" }), deps);
    await handleDialStatus(missed({ callSid: `CA${"c".repeat(32)}`, from: "anonymous" }), deps);
    await timer.runAll();
    expect(email.sent).toHaveLength(0);
  });

  it("skips quietly when the tenant has no owner email", async () => {
    const config = textingConfig();
    config.escalationContact = { name: "Owner", phone: "+14235550100" };
    const { deps, email, timer, log } = callFlow(config);
    await handleDialStatus(missed(), deps);
    await timer.runAll();
    expect(email.sent).toHaveLength(0);
    expect(log.lines.join()).toContain("no_owner_email");
  });

  it("never breaks the call flow if the outbox is down, and alerts ops", async () => {
    const { deps, sender, outbox, alerts } = callFlow();
    outbox.failEnqueue = true;
    const twiml = await handleDialStatus(missed(), deps);
    expect(twiml).toContain("<Say>");
    expect(sender.sent).toHaveLength(1);
    expect(alerts.map((a) => a.event)).toEqual(["notification.enqueue_failed"]);
  });
});

describe("sendNotification", () => {
  async function queued() {
    const n = notificationDeps();
    const id = (await n.store.enqueue({
      tenantId: TENANT_ID,
      kind: "new_lead",
      idempotencyKey: "new-lead:1",
      leadId: "lead-1",
      recipientEmail: OWNER_EMAIL,
      subject: "Missed call",
      body: "Body",
    })) as string;
    return { ...n, id };
  }

  it("sends once even when called concurrently", async () => {
    const { deps, email, id } = await queued();
    await Promise.all([1, 2, 3].map(() => sendNotification(id, deps)));
    await sendNotification(id, deps);
    expect(email.sent).toHaveLength(1);
  });

  it("retries a retryable failure later with the same idempotency key", async () => {
    const { deps, email, store, id } = await queued();
    email.failWith = new EmailSendError(true, "rate_limit_exceeded");
    await sendNotification(id, deps);
    expect(store.get(id)).toMatchObject({ status: "failed", lastErrorCode: "rate_limit_exceeded" });
    expect(store.get(id).nextAttemptAt).toBeGreaterThan(Date.now());

    // Not due yet: the cron leaves it alone.
    expect(await sendDueNotifications(deps)).toBe(0);

    email.failWith = null;
    store.makeDue();
    expect(await sendDueNotifications(deps)).toBe(1);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.idempotencyKey).toBe(`notification:${id}`);
    expect(store.get(id).status).toBe("sent");
  });

  it("gives up on a permanent failure and alerts ops", async () => {
    const { deps, email, store, alerts, id } = await queued();
    email.failWith = new EmailSendError(false, "validation_error");
    await sendNotification(id, deps);
    expect(store.get(id).status).toBe("dead");
    expect(alerts).toEqual([
      { event: "notification.dead", fields: { tenantId: TENANT_ID, notificationId: id, code: "validation_error" } },
    ]);
  });

  it(`gives up after ${MAX_ATTEMPTS} attempts`, async () => {
    const { deps, email, store, alerts, id } = await queued();
    email.failWith = new Error("network down");
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      store.makeDue();
      await sendDueNotifications(deps);
    }
    expect(store.get(id)).toMatchObject({ status: "dead", attempts: MAX_ATTEMPTS });
    expect(alerts).toHaveLength(1);
  });

  it("never logs the recipient, subject or body", async () => {
    const { deps, log, id } = await queued();
    await sendNotification(id, deps);
    const output = log.lines.join("\n");
    expect(output).not.toContain(OWNER_EMAIL);
    expect(output).not.toContain("Missed call");
  });
});

describe("renderNewLeadEmail", () => {
  it("is plain text with a formatted number and the time in the tenant's timezone", () => {
    const { subject, body } = renderNewLeadEmail(textingConfig(), {
      callerPhone: CALLER,
      calledAt: new Date("2026-10-30T18:05:00Z"),
      textback: { kind: "sent" },
    });
    expect(subject).toBe("Missed call: (423) 555-0111");
    expect(subject).not.toMatch(/[\r\n]/);
    expect(body).toContain("Example Heating & Air at Fri 2:05 PM");
    expect(body).toContain(`tel:${CALLER}`);
    expect(body).not.toMatch(/<[a-z]/i);
  });
});

describe("ops alerts", () => {
  it("only logs when no alert address is configured", async () => {
    const email = new FakeEmail();
    const log = recordingLogger();
    await createOpsAlert(email, undefined, log)("dial_status.error", { callSid: CALL_SID });
    expect(email.sent).toHaveLength(0);
    expect(log.events).toContain("ops_alert");
  });

  it("emails the operator once per event and subject", async () => {
    const email = new FakeEmail();
    const alert = createOpsAlert(email, "ops@example.com", recordingLogger());
    await alert("dial_status.error", { callSid: CALL_SID, error: "StoreError:57P01" });
    expect(email.sent[0]).toMatchObject({
      to: "ops@example.com",
      subject: "[Front Office alert] dial_status.error",
      idempotencyKey: `ops:dial_status.error:${CALL_SID}:StoreError:57P01`,
    });
  });

  it("never throws, even if the email fails", async () => {
    const email = new FakeEmail();
    email.failWith = new Error("down");
    const log = recordingLogger();
    await expect(createOpsAlert(email, "ops@example.com", log)("x", {})).resolves.toBeUndefined();
    expect(log.events).toContain("ops_alert.send_failed");
  });
});
