# Owner notifications and system alerts

## What gets sent

| Event | To | Email |
| --- | --- | --- |
| Missed call creates a new lead | Tenant's `escalationContact.email` | "Missed call: (423) 555-0111", with what happened to the text-back |
| Repeat caller's text-back fails | Tenant's `escalationContact.email` | "Text-back failed: (423) 555-0111" |
| Database error while handling a missed call | `OPS_ALERT_EMAIL` | `dial_status.error` with the call SID |
| An owner email can't be delivered after retries | `OPS_ALERT_EMAIL` | `notification.dead` |
| An owner email can't even be queued | `OPS_ALERT_EMAIL` | `notification.enqueue_failed` |

One email per lead, however many times the caller rings. Emails are plain text.
If a tenant has no `escalationContact.email`, nothing is sent (logged as `no_owner_email`).

## How delivery works

1. The webhook writes a row to `notifications` with a unique key per event.
2. After Twilio has its answer, the app sends it (Next.js `after()`).
3. Anything not sent is retried by `GET /api/cron/notifications` every 5 minutes:
   after 1 min, 5 min, 15 min and 1 h. Then it's marked `dead` and you get an alert.
4. Only one sender can hold a row at a time, and Resend gets the same idempotency
   key on every attempt, so an owner never gets the same email twice.

## Setup

- Verify a sending domain in Resend and set `NOTIFICATIONS_FROM_EMAIL` on it.
- Set `RESEND_API_KEY`, `OPS_ALERT_EMAIL` and `CRON_SECRET` (see `.env.example`).
- The cron schedule is in `apps/web/vercel.json`. **Vercel's Hobby plan only runs
  crons once a day**, so retries would be daily there; Pro runs every 5 minutes.

## Checking on it

```sql
select status, count(*) from notifications group by status;
select * from notifications where status in ('failed', 'dead') order by created_at desc;
```

Logs carry tenant, lead and notification IDs and error codes, never email
addresses, subjects or bodies.
