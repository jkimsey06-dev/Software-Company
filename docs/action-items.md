# Your action items

Everything waiting on you, collected from PRs 1–7. Tick items off as you go.
Last updated: 2026-10-30.

## 1. GitHub

- [ ] Confirm the `main` ruleset has **Require status checks to pass** turned on, with the **test** check added.

## 2. Supabase (staging and prod)

All migrations are applied to **dev** only. You promote them yourself.

- [ ] Apply every migration in `supabase/migrations/` to staging, then prod, in filename order.
- [ ] Run the Supabase security and performance advisors on each environment afterwards.
  - Expected: one note that `calendar_link_uses` has no policies. That's on purpose (server only).

## 3. Vercel

- [ ] Choose a plan. The retry job (`/api/cron/notifications`) runs every 5 minutes, which needs **Vercel Pro**. Hobby only runs crons once a day and may reject the deploy.
- [ ] Set the environment variables (full list in `.env.example`; server-only unless noted):

| Variable | What it is |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase project (browser-safe) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service key. Server only, never in browser code |
| `PUBLIC_BASE_URL` | The app's public URL, used to check Twilio signatures and to build calendar links |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Twilio account |
| `ANTHROPIC_API_KEY` | Turns the AI conversation on. Without it, emergencies are still handled and other texts go to the owner |
| `RESEND_API_KEY`, `NOTIFICATIONS_FROM_EMAIL` | Owner emails |
| `OPS_ALERT_EMAIL` | Where system alerts go (probably you) |
| `CRON_SECRET` | 32+ random characters: `openssl rand -hex 32` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Calendar OAuth client |
| `CALENDAR_TOKEN_KEY` | `openssl rand -base64 32`. Never rotate it without reconnecting every calendar |
| `CALENDAR_LINK_SECRET` | `openssl rand -hex 32` |

## 4. Resend (email)

- [ ] Verify a sending domain in Resend.
- [ ] Set `NOTIFICATIONS_FROM_EMAIL` to an address on that domain.

## 5. Google Cloud (calendar booking)

Full steps: `docs/runbooks/calendar.md`.

- [ ] Create a project and enable the **Google Calendar API**.
- [ ] Set up the OAuth consent screen (External) with the two scopes: `calendar.freebusy` and `calendar.events.owned`.
- [ ] Create a Web OAuth client with redirect URI `https://<PUBLIC_BASE_URL>/api/calendar/callback`.
- [ ] **Submit the app for Google verification.** It's free but can take weeks. Until it's verified, only listed test users can connect, and they'll see an "unverified app" warning.

## 6. Twilio (per client)

Full steps: `docs/runbooks/twilio.md`.

- [ ] Register each client's A2P 10DLC brand and campaign. Don't text from a number until it's approved.
- [ ] Point the number's voice webhook at `/api/twilio/voice` and its SMS webhook at `/api/twilio/sms`.
- [ ] Add a fallback TwiML Bin that forwards calls straight to the owner if the app is down.
- [ ] Turn on **Advanced Opt-Out** on the client's Messaging Service.
- [ ] At launch QA, make a real test call to check the owner's voicemail doesn't pick up before `calls.ringSeconds` runs out.

## 7. Questions for your lawyer

**Texting (missed-call text-back)**
- [ ] Automatically texting every unanswered caller, with no separate consent record.
- [ ] Texting at any hour. There's no quiet-hours check, so a 2 a.m. call gets a 2 a.m. text.
- [ ] Whether 24 hours between text-backs to the same person is enough.
- [ ] "Wrong number", "stop calling me" and Spanish words like ALTO, BAJA or cancelar are forwarded to the owner, not treated as opt-outs. Should any of them be?

**AI conversation**
- [ ] Sending owner alerts and follow-up questions under each client's A2P campaign.
- [ ] Follow-up questions don't repeat "Reply STOP to opt out" (only the first text and the booking confirmation include it).
- [ ] The assistant only replies in English.
- [ ] Whether saying "I'm an AI assistant" only in the first text, and when asked, is enough.

**Data and privacy**
- [ ] Owner emails send callers' phone numbers (and now addresses) through Resend, and a copy is kept in the database. Do your privacy policy and client agreement cover this?
- [ ] How long to keep customer street addresses.

**Calendar booking**
- [ ] Google API User Data Policy and its Limited Use requirements.
- [ ] The confirmation wording: "You're booked for an estimate on … {business} may call to confirm or adjust."
- [ ] Deleting a client's stored calendar access when they leave.

## 8. Decisions to confirm

- [ ] I added `@supabase/supabase-js` (the official Supabase client) without asking you directly. Keep it, or switch?
- [ ] Booking choices I made. Change any of them if you like:
  - PO boxes are rejected as estimate addresses.
  - If the confirmation text fails, the estimate stays on the calendar and the owner is told.
  - Times are offered at least 2 hours ahead. A time under 1 hour away when the address comes in isn't booked.
  - A question asked while choosing a time gets the times again, not an answer.
  - `bookingWindowDays` counts calendar days, not business days.

## Optional

- [ ] Try the real model on the fake example client (costs a few cents):

```bash
LIVE_MODEL_TESTS=1 ANTHROPIC_API_KEY=... pnpm --filter @sc/ai exec vitest run live-model
```
