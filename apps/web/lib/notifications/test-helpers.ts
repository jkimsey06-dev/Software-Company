import { EmailSendError, type ClaimedNotification, type EmailSender, type NewNotification, type NotificationDeps, type NotificationStore } from "./types";
import { recordingLogger } from "../missed-call/test-helpers";

interface Row extends NewNotification {
  id: string;
  status: "pending" | "sending" | "sent" | "failed" | "dead";
  attempts: number;
  nextAttemptAt: number;
  providerId?: string;
  lastErrorCode?: string;
}

// In-memory outbox with the same rules as the notifications table and its
// claim_notification / due_notifications functions.
export class FakeNotificationStore implements NotificationStore {
  rows: Row[] = [];
  failEnqueue = false;

  async enqueue(n: NewNotification) {
    if (this.failEnqueue) throw new Error("enqueue unavailable");
    if (this.rows.some((r) => r.tenantId === n.tenantId && r.idempotencyKey === n.idempotencyKey)) {
      return null;
    }
    const id = `notif-${this.rows.length + 1}`;
    this.rows.push({ ...n, id, status: "pending", attempts: 0, nextAttemptAt: 0 });
    return id;
  }

  async claim(id: string): Promise<ClaimedNotification | null> {
    const row = this.rows.find((r) => r.id === id);
    if (!row || row.nextAttemptAt > Date.now()) return null;
    if (row.status !== "pending" && row.status !== "failed") return null;
    row.status = "sending";
    row.attempts += 1;
    return { id: row.id, tenantId: row.tenantId, recipientEmail: row.recipientEmail, subject: row.subject, body: row.body, attempts: row.attempts };
  }

  async markSent(id: string, providerId: string) {
    const row = this.get(id);
    row.status = "sent";
    row.providerId = providerId;
  }

  async markFailed(id: string, code: string, retryAt: Date | null) {
    const row = this.get(id);
    row.status = retryAt ? "failed" : "dead";
    row.lastErrorCode = code;
    row.nextAttemptAt = retryAt ? retryAt.getTime() : Date.now();
  }

  async due(limit: number) {
    return this.rows
      .filter((r) => (r.status === "pending" || r.status === "failed") && r.nextAttemptAt <= Date.now())
      .slice(0, limit)
      .map((r) => r.id);
  }

  get(id: string): Row {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error(`no row ${id}`);
    return row;
  }

  // Lets a test fast-forward past a retry delay.
  makeDue() {
    for (const r of this.rows) r.nextAttemptAt = 0;
  }
}

export class FakeEmail implements EmailSender {
  sent: { to: string; subject: string; text: string; idempotencyKey: string }[] = [];
  failWith: EmailSendError | Error | null = null;

  async send(email: { to: string; subject: string; text: string; idempotencyKey: string }) {
    // Simulate a little latency so concurrent sends interleave.
    await new Promise((r) => setTimeout(r, 1));
    if (this.failWith) throw this.failWith;
    this.sent.push(email);
    return { id: `email-${this.sent.length}` };
  }
}

export function notificationDeps() {
  const store = new FakeNotificationStore();
  const email = new FakeEmail();
  const alerts: { event: string; fields: Record<string, string> }[] = [];
  const log = recordingLogger();
  const deps: NotificationDeps = {
    store,
    email,
    log,
    opsAlert: async (event, fields) => {
      alerts.push({ event, fields });
    },
  };
  return { store, email, alerts, log, deps };
}

// Collects scheduled work so a test can run it when it wants to.
export function manualSchedule() {
  const tasks: (() => Promise<void>)[] = [];
  return {
    schedule: (task: () => Promise<void>) => {
      tasks.push(task);
    },
    async runAll() {
      while (tasks.length) await tasks.shift()?.();
    },
    get pending() {
      return tasks.length;
    },
  };
}

export { EmailSendError };
