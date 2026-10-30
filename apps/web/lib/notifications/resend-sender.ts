import { Resend } from "resend";
import { EmailSendError, type EmailSender } from "./types";

export function createResendSender(apiKey: string, from: string): EmailSender {
  const resend = new Resend(apiKey);
  return {
    async send({ to, subject, text, idempotencyKey }) {
      let result: Awaited<ReturnType<typeof resend.emails.send>>;
      try {
        result = await resend.emails.send({ from, to, subject, text }, { idempotencyKey });
      } catch {
        // Network failure: unknown whether it was sent. The idempotency key
        // makes a retry safe.
        throw new EmailSendError(true, "network");
      }
      if (result.error) {
        const status = result.error.statusCode ?? 0;
        const retryable =
          status === 0 ||
          status === 429 ||
          status >= 500 ||
          result.error.name === "concurrent_idempotent_requests";
        throw new EmailSendError(retryable, result.error.name);
      }
      if (!result.data) throw new EmailSendError(true, "empty_response");
      return { id: result.data.id };
    },
  };
}
