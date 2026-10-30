// QA: attempts to break the owner-notification flow. Fakes only; no real email.
// Tests that failed in the first QA pass were fixed; they now guard the behaviour.
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
import { cronRoute } from "./cron-route";
import { MAX_ATTEMPTS, sendDueNotifications, sendNotification } from "./dispatch";
import { createOwnerNotifier } from "./owner";
import { renderNewLeadEmail, renderTextbackFailedEmail } from "./templates";
import { EmailSendError, FakeEmail, FakeNotificationStore, manualSchedule, notificationDeps } from "./test-helpers";
import type { NewNotification, NotificationDeps } from "./types";

const OWNER_EMAIL = "owner@example.com";
const SECRET = "s".repeat(40);
const TENANT_B = "20000000-0000-0000-0000-000000000002";

const missed = (o: Partial<{ callSid: string; from: string; dialStatus: string }> = {}) => ({
  callSid: CALL_SID,
  from: CALLER,
  to: BUSINESS_NUMBER,
  dialStatus: "no-answer",
  ...o,
});

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

const row = (o: Partial<NewNotification> = {}): NewNotification => ({
  tenantId: TENANT_ID,
  kind: "new_lead",
  idempotencyKey: "new-lead:lead-1",
  leadId: "lead-1",
  recipientEmail: OWNER_EMAIL,
  subject: "Missed call",
  body: "Body",
  ...o,
});

// Email fake that behaves like Resend's idempotency: a repeated key returns
// the first result without delivering again.
class IdempotentEmail extends FakeEmail {
  delivered = new Map<string, string>();
  override async send(e: { to: string; subject: string; text: string; idempotencyKey: string }) {
    const prior = this.delivered.get(e.idempotencyKey);
    if (prior) return { id: prior };
    const r = await super.send(e);
    this.delivered.set(e.idempotencyKey, r.id);
    return r;
  }
}

// Fake store that models the real stale-lock rule in claim_notification.
class StaleLockStore extends FakeNotificationStore {
  lockedAt = new Map<string, number>();
  staleMs = 5 * 60_000;
  override async claim(id: string) {
    const r = this.get(id);
    const locked = this.lockedAt.get(id);
    if (r.status === "sending" && locked !== undefined && Date.now() - locked > this.staleMs) {
      r.status = "failed";
    }
    const c = await super.claim(id);
    if (c) this.lockedAt.set(id, Date.now());
    return c;
  }
}

describe("duplicates", () => {
  it("after() and cron racing on the same row send exactly one email", async () => {
    const { deps, store, email } = notificationDeps();
    const id = (await store.enqueue(row())) as string;
    await Promise.all([sendNotification(id, deps), sendDueNotifications(deps), sendDueNotifications(deps)]);
    expect(email.sent).toHaveLength(1);
  });

  it("same dial-status webhook delivered twice concurrently queues one email", async () => {
    const { deps, email, timer, outbox } = callFlow();
    await Promise.all([handleDialStatus(missed(), deps), handleDialStatus(missed(), deps)]);
    await timer.runAll();
    expect(outbox.rows).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
  });

  it("send succeeded but markSent failed: retry reuses the key and the provider dedupes", async () => {
    const { deps, store } = notificationDeps();
    const email = new IdempotentEmail();
    deps.email = email;
    const id = (await store.enqueue(row())) as string;
    const markSent = store.markSent.bind(store);
    store.markSent = async () => {
      throw new Error("db blip");
    };
    await sendNotification(id, deps);
    store.markSent = markSent;
    store.makeDue();
    await sendDueNotifications(deps);
    expect(email.sent).toHaveLength(1);
    expect(store.get(id).status).toBe("sent");
  });

  it("markSent failing on the last attempt must not mark a delivered email dead or alert ops", async () => {
    const { deps, store, email, alerts } = notificationDeps();
    const id = (await store.enqueue(row())) as string;
    email.failWith = new EmailSendError(true, "internal_server_error");
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      store.makeDue();
      await sendDueNotifications(deps);
    }
    email.failWith = null;
    store.markSent = async () => {
      throw new Error("db blip");
    };
    store.makeDue();
    await sendDueNotifications(deps);
    expect(email.sent).toHaveLength(1); // delivered
    expect(store.get(id).status).not.toBe("dead");
    expect(alerts.map((a) => a.event)).not.toContain("notification.dead");
  });
});

describe("lost emails", () => {
  it("crash between claim and send: a stale lock is retaken and the email still goes out", async () => {
    const n = notificationDeps();
    const store = new StaleLockStore();
    const deps: NotificationDeps = { ...n.deps, store };
    const id = (await store.enqueue(row())) as string;
    await store.claim(id); // sender dies here
    expect(await sendDueNotifications(deps)).toBe(0);
    store.lockedAt.set(id, Date.now() - 6 * 60_000);
    await sendNotification(id, deps);
    expect(n.email.sent).toHaveLength(1);
  });

  it("markFailed throwing on a permanent failure still alerts ops", async () => {
    const { deps, store, email, alerts } = notificationDeps();
    const id = (await store.enqueue(row())) as string;
    email.failWith = new EmailSendError(false, "validation_error");
    store.markFailed = async () => {
      throw new Error("db down");
    };
    await sendNotification(id, deps).catch(() => undefined);
    expect(alerts.map((a) => a.event)).toContain("notification.dead");
  });

  it.each(["isOptedOut", "claimTextback"] as const)(
    "owner is still emailed about a saved lead when %s throws during text-back",
    async (method) => {
      const { deps, email, timer, store } = callFlow();
      store.failOn.add(method);
      await handleDialStatus(missed(), deps).catch(() => undefined);
      await timer.runAll();
      expect(store.leads).toHaveLength(1);
      expect(email.sent).toHaveLength(1);
    },
  );

  it("owner is still emailed when recording a failed text-back throws", async () => {
    const { deps, email, timer, store, sender } = callFlow();
    sender.failWith = new Error("twilio 503");
    store.markMessage = async () => {
      throw new Error("db down");
    };
    await handleDialStatus(missed(), deps).catch(() => undefined);
    await timer.runAll();
    expect(email.sent).toHaveLength(1);
  });
});

describe("call latency", () => {
  const within = <T>(p: Promise<T>, ms: number) =>
    Promise.race([p.then(() => "done"), new Promise((r) => setTimeout(() => r("timeout"), ms))]);

  it("enqueue failure does not hold up the TwiML response while the ops email is sent", async () => {
    const { deps, outbox } = callFlow();
    outbox.failEnqueue = true;
    const n = notificationDeps();
    n.store.failEnqueue = true;
    const slowOps: NotificationDeps = { ...n.deps, opsAlert: () => new Promise(() => {}) };
    deps.notifyOwner = createOwnerNotifier(slowOps, manualSchedule().schedule);
    expect(await within(handleDialStatus(missed(), deps), 200)).toBe("done");
  });

  it("a hanging Supabase enqueue does not hang the TwiML response", async () => {
    const { deps } = callFlow();
    const n = notificationDeps();
    n.store.enqueue = () => new Promise(() => {});
    deps.notifyOwner = createOwnerNotifier(n.deps, manualSchedule().schedule);
    expect(await within(handleDialStatus(missed(), deps), 200)).toBe("done");
  });
});

describe("templates", () => {
  const at = new Date("2026-10-30T18:05:00Z");

  it("non-NANP caller: raw E.164 in subject, no CR/LF, within DB limits", () => {
    for (const callerPhone of ["+442071838750", "+861012345678901"]) {
      const { subject, body } = renderNewLeadEmail(textingConfig(), {
        callerPhone,
        calledAt: at,
        textback: { kind: "skipped", reason: "non_us_number" },
      });
      expect(subject).toBe(`Missed call: ${callerPhone}`);
      expect(subject).not.toMatch(/[\r\n]/);
      expect(body).toContain("not a US or Canada number");
    }
  });

  it("max-length (120) business name with emoji stays within DB checks", () => {
    const config = textingConfig({ businessName: `${"\u{1F525}".repeat(30)}${"A".repeat(60)}` });
    for (const r of [
      renderNewLeadEmail(config, { callerPhone: CALLER, calledAt: at, textback: { kind: "unknown" } }),
      renderTextbackFailedEmail(config, { callerPhone: CALLER, calledAt: at }),
    ]) {
      expect(r.subject.length).toBeLessThanOrEqual(200);
      expect(r.subject).not.toMatch(/[\r\n]/);
      expect(r.body.length).toBeLessThanOrEqual(5000);
    }
  });

  it("unknown skip reason falls back to generic wording", () => {
    const { body } = renderNewLeadEmail(textingConfig(), {
      callerPhone: CALLER,
      calledAt: at,
      textback: { kind: "skipped", reason: "from_number_not_owned" },
    });
    expect(body).toContain("We didn't text them. Please call them back.");
  });

  it("DST fall-back (Nov 1 2026) 1:30 AM EDT and 1:30 AM EST render distinguishably", () => {
    const render = (iso: string) =>
      renderNewLeadEmail(textingConfig(), { callerPhone: CALLER, calledAt: new Date(iso), textback: { kind: "sent" } }).body;
    expect(render("2026-11-01T05:30:00Z")).not.toBe(render("2026-11-01T06:30:00Z"));
  });
});

describe("cron", () => {
  const req = () =>
    new Request("http://internal.local/api/cron/notifications", { headers: { authorization: `Bearer ${SECRET}` } });

  it("no due rows: processed 0, no email", async () => {
    const { deps, email } = notificationDeps();
    const res = await cronRoute(() => SECRET, () => deps)(req());
    expect(await res.json()).toEqual({ ok: true, processed: 0 });
    expect(email.sent).toHaveLength(0);
  });

  it("120 due rows: 50 per run, all sent after three runs, none twice", async () => {
    const { deps, store, email } = notificationDeps();
    for (let i = 0; i < 120; i++) await store.enqueue(row({ idempotencyKey: `new-lead:${i}` }));
    const route = cronRoute(() => SECRET, () => deps);
    const counts = [];
    for (let i = 0; i < 4; i++) counts.push((await (await route(req())).json()).processed);
    expect(counts).toEqual([50, 50, 20, 0]);
    expect(new Set(email.sent.map((e) => e.idempotencyKey)).size).toBe(120);
    expect(email.sent).toHaveLength(120);
  });

  it("one row whose claim throws does not block the rest", async () => {
    const { deps, store, email } = notificationDeps();
    const a = (await store.enqueue(row({ idempotencyKey: "a" }))) as string;
    await store.enqueue(row({ idempotencyKey: "b" }));
    const claim = store.claim.bind(store);
    store.claim = async (id) => {
      if (id === a) throw new Error("bad row");
      return claim(id);
    };
    await sendDueNotifications(deps);
    expect(email.sent).toHaveLength(1);
  });

  it("Supabase down during cron returns a clean 5xx and alerts ops", async () => {
    const { deps, store, alerts } = notificationDeps();
    store.due = async () => {
      throw new Error("supabase 503");
    };
    const res = await cronRoute(() => SECRET, () => deps)(req()).catch(() => null);
    expect(res?.status).toBe(500);
    expect(alerts.length).toBeGreaterThan(0);
  });
});

describe("tenant isolation and recipients", () => {
  it("same idempotency key in two tenants queues two rows, each to its own owner", async () => {
    const { deps, store, email } = notificationDeps();
    await store.enqueue(row());
    await store.enqueue(row({ tenantId: TENANT_B, recipientEmail: "b-owner@example.com" }));
    await sendDueNotifications(deps);
    expect(email.sent.map((e) => e.to).sort()).toEqual(["b-owner@example.com", OWNER_EMAIL]);
  });

  it("emails the tenant's escalation contact, never the caller", async () => {
    const { deps, email, timer } = callFlow();
    await handleDialStatus(missed(), deps);
    await timer.runAll();
    expect(email.sent.map((e) => e.to)).toEqual([OWNER_EMAIL]);
  });

  it("Resend outage past the retry window: dead after 5 attempts, about 81 minutes", async () => {
    const { deps, store, email, alerts } = notificationDeps();
    const id = (await store.enqueue(row())) as string;
    email.failWith = new EmailSendError(true, "internal_server_error");
    let total = 0;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const before = Date.now();
      store.makeDue();
      await sendDueNotifications(deps);
      if (store.get(id).status === "failed") total += store.get(id).nextAttemptAt - before;
    }
    expect(store.get(id).status).toBe("dead");
    expect(alerts.map((a) => a.event)).toEqual(["notification.dead"]);
    expect(Math.round(total / 60_000)).toBeLessThanOrEqual(82);
  });
});
