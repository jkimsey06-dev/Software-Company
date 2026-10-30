import twilio from "twilio";
import { SmsSendError, type SmsSender } from "./types";

export function createTwilioSender(accountSid: string, authToken: string): SmsSender {
  // Short timeout: this runs inside a voice webhook that Twilio waits on.
  const client = twilio(accountSid, authToken, { timeout: 8000 });
  return {
    async send({ from, to, body }) {
      try {
        const message = await client.messages.create({ from, to, body });
        return { sid: message.sid };
      } catch (err) {
        const status = (err as { status?: number }).status;
        const code = (err as { code?: number }).code;
        // A 4xx from Twilio means the request was refused: nothing was sent.
        // Anything else (5xx, timeout, network) might have gone through.
        if (typeof status === "number" && status >= 400 && status < 500) {
          throw new SmsSendError("rejected", String(code ?? status), "Twilio rejected the message");
        }
        throw new SmsSendError("unknown", status ? String(status) : "network", String(err));
      }
    },
  };
}
