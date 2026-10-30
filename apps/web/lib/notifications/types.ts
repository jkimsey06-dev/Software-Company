import type { Logger } from "../missed-call/types";

export type NotificationKind =
  | "new_lead"
  | "textback_failed"
  | "customer_reply"
  | "conversation_update"
  | "emergency";

export interface NewNotification {
  tenantId: string;
  kind: NotificationKind;
  idempotencyKey: string;
  leadId: string | null;
  recipientEmail: string;
  subject: string;
  body: string;
}

export interface ClaimedNotification {
  id: string;
  tenantId: string;
  recipientEmail: string;
  subject: string;
  body: string;
  attempts: number;
}

// Outbox for owner emails. The Supabase implementation runs with the service
// role, server-side only.
export interface NotificationStore {
  // Inserts the row if its idempotency key is new. Returns the id, or null if
  // this event was already queued.
  enqueue(notification: NewNotification): Promise<string | null>;
  // Takes the row for sending. Null if it's sent, dead, not due, or held by
  // another live sender. Only the caller that gets the row may send it.
  claim(id: string): Promise<ClaimedNotification | null>;
  // Both only apply while this sender still holds the claim (same attempt), so
  // a slow sender can't overwrite the result of one that retook its lock.
  markSent(id: string, attempt: number, providerId: string): Promise<void>;
  markFailed(id: string, attempt: number, errorCode: string, retryAt: Date | null): Promise<void>;
  due(limit: number): Promise<string[]>;
  // Marks rows too old to send ('dead', 'expired'). Returns how many. A late
  // email is worse than none, and the provider's idempotency window is 24h.
  expireOld(): Promise<number>;
}

export class EmailSendError extends Error {
  constructor(
    // retryable: worth another attempt later (rate limit, 5xx, network).
    readonly retryable: boolean,
    readonly code: string,
  ) {
    super(`email send failed (${code})`);
    this.name = "EmailSendError";
  }
}

export interface EmailSender {
  // The idempotency key makes the provider drop a repeat of the same email.
  // Throws EmailSendError on failure.
  send(email: {
    to: string;
    subject: string;
    text: string;
    idempotencyKey: string;
  }): Promise<{ id: string }>;
}

// Alerts about the system itself (outages, stuck notifications), sent to the
// operator, not to a client. Never throws.
export type OpsAlert = (event: string, fields: Record<string, string>) => Promise<void>;

export interface NotificationDeps {
  store: NotificationStore;
  email: EmailSender;
  opsAlert: OpsAlert;
  log: Logger;
}
