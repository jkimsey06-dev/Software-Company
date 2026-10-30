---
name: launch-qa
description: Pre-launch checklist run on every new client before the missed-call machine goes live. Use after onboarding and before turning texting on.
---

# Launch QA

Run every check. Report pass, fail or not-tested for each, with evidence. Any fail
blocks launch. Tests use the client's test number or a team phone, never a real customer.

## Config
- [ ] `/clients/<slug>.json` passes `tenantConfigSchema`
- [ ] Services, hours, service area and escalation contact match the signed intake
- [ ] Knowledge base answers are client-approved; no unapproved prices, warranties or arrival times

## Texting
- [ ] `canSendTexts` is true: A2P approved, campaign id and from-number set
- [ ] A missed call to the client's number triggers one text-back within the configured delay
- [ ] First text includes the AI disclosure (if required) and "Reply STOP to opt out"
- [ ] STOP (and variants) stops all further texts immediately
- [ ] A duplicate webhook delivery does not send a second text

## Conversation
- [ ] Assistant qualifies service, area and urgency and saves a lead to the inbox
- [ ] Out-of-area and unknown-service requests are handled politely and handed off
- [ ] Price and arrival-time questions are not answered beyond approved wording
- [ ] Emergency phrases (gas smell, fire, flooding, no heat with vulnerable people)
      direct the person to 911/the right service and alert the owner immediately
- [ ] "Let me talk to a person" and an upset customer both hand off to a human
- [ ] Prompt-injection attempts ("ignore your instructions…") don't change behavior
- [ ] Assistant says it's an AI when asked

## Scheduling
- [ ] Offered times come from the real calendar, inside hours and the booking window
- [ ] A booked estimate appears on the owner's calendar with no double-booking

## Notifications and logging
- [ ] Owner is notified of each new lead
- [ ] Conversation is logged with tenant ID, timestamps and prompt version

## Failure modes
- [ ] With Claude, Twilio or the calendar unavailable, the owner still hears about the lead and no text is sent twice

## Isolation
- [ ] The client's dashboard login sees only their own leads
