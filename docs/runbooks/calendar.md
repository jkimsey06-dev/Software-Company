# Calendar booking

When the assistant has a lead's service, area and urgency, it offers estimate
times from the owner's Google Calendar, takes the customer's pick and street
address, and books it on the calendar.

## One-time setup (you)

1. In Google Cloud, create a project and enable the **Google Calendar API**.
2. OAuth consent screen: External, app name and support email. Add these scopes:
   - `https://www.googleapis.com/auth/calendar.freebusy`
   - `https://www.googleapis.com/auth/calendar.events.owned`
   These are "sensitive" scopes: until Google verifies the app, only test users you
   list can connect, and they'll see an "unverified app" warning. Submit for
   verification before onboarding real clients (free, can take a few weeks).
3. Create an OAuth client (Web application). Authorized redirect URI:
   `https://<PUBLIC_BASE_URL>/api/calendar/callback`
4. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CALENDAR_TOKEN_KEY` and
   `CALENDAR_LINK_SECRET` (see `.env.example`).

## Connecting a client's calendar

```bash
CALENDAR_LINK_SECRET=... PUBLIC_BASE_URL=https://... pnpm --filter @sc/web calendar:link <tenant-id>
```

This prints a link. **It sends nothing**: you send it to the owner. The link works
once and expires in 7 days. A link made before the calendar's current connection
is refused, so an old forwarded link can't swap in someone else's calendar. Replacing
a connection with a newer link sends a `calendar.connection_replaced` ops alert. The owner signs in with Google, allows the two
permissions, and sees "Your calendar is connected". Events go on their primary calendar.

The refresh token is encrypted (AES-256-GCM, key only in `CALENDAR_TOKEN_KEY`, bound
to the tenant) before it's stored in `calendar_connections`. Owners can see whether
their calendar is connected, never the token.

## How times are chosen

From the tenant config: business hours (in the tenant's time zone, DST-safe),
`calendar.estimateDurationMinutes`, `bookingWindowDays`, `slotsToOffer`. Slots start
at least 2 hours from now, keep 30 minutes free around busy events, and are spread
across days. Emergency-urgency leads are never put on the calendar.

## The conversation

| Customer says | What happens |
| --- | --- |
| A number ("2", "#2", "option 2") | Read by code, no model |
| "the Tuesday one" | Small model picks the option |
| Unclear | Same options again (question limit applies) |
| "None of those work" | Handoff: "I'll have the team reach out to find a time" |
| A street address | Time held (`estimate_holds`, so two customers can't take the same time), calendar checked again, event created (id derived from conversation + time, so a retry never double-books), fixed confirmation, owner emailed "Estimate booked" |
| Unclear address | Asked once more (per pick), then handoff |
| PO box, link, phone number | Not accepted as an address |
| Time taken meanwhile | New times offered once (address kept, not asked again), then handoff |
| Picked time now under 2 hours away (or under 1 hour by the time they give the address) | New times offered once, then handoff |

Emergencies, "talk to a person" and STOP still come first at every step.

## When the calendar can't be used

| Situation | What happens |
| --- | --- |
| Not connected / calendar settings missing | "They'll reach out to set up a time", owner emailed as before |
| Calendar full in the booking window | Same |
| Google down when offering | Same |
| Google down when checking the time | No confirmation; handoff, owner asked to call about the time |
| Google times out while creating the event | It may have been created: handoff, owner told to check their calendar |
| Event created but the confirmation text fails (or they texted STOP) | Owner emailed: it's on your calendar but they haven't been told |
| Crash after the event was created | The retry finishes the same booking (stage `booking`), one event |
| The owner deleted the event and the same time is picked again | Not put back; handoff |
| Access revoked (owner removed the app, password reset...) | Connection marked revoked, `calendar.revoked` ops alert, owner emailed (once a day) to reconnect; leads go to the owner as before |

To reconnect, send a new link (same command).
