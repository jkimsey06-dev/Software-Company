# Twilio: missed-call machine

## Setting up a client's number

1. Buy or port the number into the Twilio account. It must be on the client's own
   approved A2P 10DLC campaign before any text is sent.
2. Voice configuration on the number:
   - **A call comes in**: Webhook, `POST https://<PUBLIC_BASE_URL>/api/twilio/voice`
   - **Primary handler fails**: a TwiML Bin that forwards straight to the owner:
     ```xml
     <Response><Dial timeout="25"><Number>+1OWNERNUMBER</Number></Dial></Response>
     ```
     If our app or Supabase is down, calls still reach the owner (no text-back).
3. Add the number to `tenant_phone_numbers` for the tenant (dev only; staging/prod
   are done by the owner).
4. Set `calls.forwardToNumber` in the client config. Keep `calls.ringSeconds` below
   the owner's carrier voicemail pickup, or voicemail answers and the call counts
   as answered (no text-back). Test it with a real call during launch QA.
5. Set `messaging.a2pStatus`, `a2pCampaignId` and `fromNumber` only once the
   campaign is approved. Until then calls are logged and leads saved, but no texts.

## How it behaves

| Situation | What happens |
| --- | --- |
| Owner answers | Call logged as answered. Nothing else. |
| No answer / busy / failed / caller hangs up | Call logged as missed, lead saved, one text-back. |
| Caller ID withheld | Call logged as missed. No lead, no text. |
| Caller opted out (STOP) | Lead saved, no text. |
| A2P not approved | Lead saved, no text. |
| Same webhook delivered twice | Second one does nothing. |
| Twilio rejects the text (4xx) | Message marked `failed`. Not retried. Error 21610 also records an opt-out. |
| Twilio times out / 5xx | Message marked `unknown`. **Never retried automatically**: it may have been sent. Review by hand. |
| Our database is down during the dial-status webhook | Call ends cleanly, nothing sent, error logged. |

## Checking on failures

Messages with `status in ('failed', 'unknown')` in `outbound_messages` need a look.
Logs are JSON lines with `event`, `tenantId` and `callSid`, never phone numbers or
message text.
