# Your action items

Everything waiting on you, collected from PRs 1–7. Tick items off as you go.
Last updated: 2026-10-30.

## 1. GitHub

- [ ] Confirm the `main` ruleset has **Require status checks to pass** turned on, with the **test** check added.

## 2. Supabase

### Owner sign-in (magic link): do this on dev first, then staging and prod

Owners sign in with an emailed link. It won't work until you change these settings in the Supabase dashboard, under **Authentication**. More detail: `docs/runbooks/dashboard.md`.

- [ ] **Sign In / Providers → Email:** keep Email on and turn **off** "Allow new users to sign up". Owners are added by us, never self-registered.
- [ ] **URL Configuration:** set **Site URL** to the app's public address (the same value as `PUBLIC_BASE_URL`).
- [ ] **Email Templates → Magic link:** change the link so it goes to our confirm page. Replace `{{ .ConfirmationURL }}` with exactly:

  ```
  {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}
  ```

  Without this the emailed link won't sign anyone in.
- [ ] Before real clients: **Project Settings → Authentication → SMTP**, send login emails through Resend's SMTP with your verified domain. Supabase's built-in sender is for testing only and is rate-limited.
- [ ] Add rate limiting in front of `/auth/login` (a Vercel Firewall rule, for example). Supabase limits repeat emails to one address, but nothing limits requests per visitor.
- [ ] For each client, add their people with `pnpm --filter @sc/web owner:add <tenant-id> <email>` (a dry run; add `--apply` to do it). It sends no email: tell them to open `/login` and ask for a link. See `docs/runbooks/dashboard.md`.
- [ ] Try one real sign-in on dev. It's the one thing I couldn't test: add a test owner with the script above, request a link, click it, and check you land on `/dashboard`.

### Staging and prod databases

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

Before you can submit for verification:
- [ ] Fill in your company name, contact email and mailing address in `apps/web/lib/site.ts`. Until you do, the homepage and privacy page show a "Draft" notice.
- [ ] Have your lawyer review the draft privacy policy (`/privacy`, source in `apps/web/app/privacy/page.tsx`), including the retention period, which is still a placeholder.
- [ ] Deploy to your own domain (not `*.vercel.app`) and verify that domain in Google Search Console.
- [ ] Use the homepage and `/privacy` URLs on the consent screen.
- [ ] Record a demo video (unlisted on YouTube) showing the consent screen and a booking landing on the calendar.

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
