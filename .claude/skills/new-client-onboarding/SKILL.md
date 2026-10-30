---
name: new-client-onboarding
description: Onboard a new home services client onto the missed-call machine. Use when a client has signed and needs a tenant, config, A2P registration, calendar connection and launch QA.
---

# New client onboarding

Work through these in order. Stop and ask the owner before anything that costs
money, touches production, or sends a message to a real person.

## 1. Intake
Collect from the client (record answers, not secrets):
- Business name, trade, timezone, service area (zip codes and/or cities)
- Services offered, and which count as emergencies
- Business hours, estimate length, how far ahead to book
- Tone (friendly, professional, casual) and anything to avoid saying
- Escalation contact: name, mobile, email
- Approved knowledge base: FAQs and answers they sign off on. Nothing about prices,
  warranties or arrival times unless they give exact approved wording.
- Whether texts must open with an AI disclosure (default yes)

## 2. Tenant config
- Create `/clients/<slug>.json` from `/clients/example-hvac.json`.
- Validate it: it must pass `tenantConfigSchema` (`packages/shared`).
- Set `messaging.a2pStatus` to `not_started`. Texting stays off until approved.
- Create the tenant row in `dev` and add the owner as a `tenant_members` owner.
  Staging and prod are done by the owner, not by you.

## 3. A2P 10DLC registration
- Prepare the brand and campaign details for the client's own registration. Show
  them to the owner before submitting. Fees are passed through at cost plus margin.
- Update `a2pStatus` to `pending`, then `approved` with `a2pCampaignId` and
  `fromNumber` once approved. `canSendTexts` stays false until all three are set.
- Flag anything in the campaign description or sample messages that looks like a
  compliance risk for the owner to check with a lawyer.

## 4. Calendar connection
- The client connects Google Calendar through the OAuth flow. Never ask for a password.
- Record the `calendar.calendarId`. Confirm free/busy reads work with a test query.

## 5. Launch QA
Run the `launch-qa` skill. Do not mark the client live until it passes.
