# AI text conversation

After the missed-call text-back, the customer's replies go to an AI assistant
that learns the service, area and urgency, then hands the lead to the owner.

**The AI never writes what we send.** It only reads the customer's texts and
fills structured fields. Every text we send is a fixed template built from the
tenant's config (`packages/ai/src/templates/conversation.v1.ts`), so it can't
promise a price, time, warranty or availability, or be talked into saying
anything else.

## Emergencies (always, no AI needed)

Any customer text that matches the emergency word list
(`packages/ai/src/conversation/emergency.ts`): gas/propane smell, smoke, fire,
sparks, CO alarm, flooding, water through a ceiling or near electrical, power
line down, someone fainted, no heat/AC with a baby or elderly person, and some
Spanish phrases. This runs in every state: before or after a handoff, with or
without an AI key, even mixed with STOP.

- Customer: fixed text pointing to 911, if texting them is allowed (A2P approved,
  not opted out).
- Owner: text from the tenant's number ("EMERGENCY: (423) 555-0111 texted ...",
  no customer words), plus an "EMERGENCY" email with the conversation.
- The conversation is handed off.

The AI's safety check catches emergencies the word list misses.

## When the AI runs

Otherwise the customer's text is emailed to the owner. All must be true:

- `ANTHROPIC_API_KEY` is set
- The tenant can send texts (A2P approved, campaign id, `fromNumber` owned by the tenant)
- US/Canada number, not one of the tenant's own numbers, not opted out
- The text has words and isn't a keyword (STOP, HELP, CANCEL...)
- The conversation is active. After a handoff or completion, a person is in charge for 7 days.

## Each turn

1. **Safety check** (`claude-haiku-5-5`, `safety-classifier@v1`): emergency → emergency
   handling; upset or wants a person → fixed handoff; wrong number or spam → no text, owner told.
2. **Question limit**: after 6 questions, fixed handoff.
3. **Understanding** (`claude-sonnet-5-5`, `lead-understanding@v1`): service id (from the
   tenant's list only), area, urgency, FAQ id (from the tenant's FAQ only), whether they
   asked something else, need a service that isn't listed, or need a person. Details are
   remembered across turns.
4. **Decided in code:**
   - Needs a person / unlisted service → fixed handoff text
   - Area outside the service area (checked against the tenant's ZIPs and cities) → fixed
     "may be outside the area" text, handoff
   - Missing detail → the next fixed question (service, then area, then urgency), optionally
     after "Yes, I'm an AI assistant..." (once), an approved FAQ answer word for word, or
     "I'll pass that question to the team"
   - All known → if the owner's calendar is connected, offer estimate times and book one
     (see docs/runbooks/calendar.md); otherwise fixed "they'll reach out to set up a time",
     owner emailed "Lead ready"

Several texts in a row get one reply. Customer text is passed to the model as escaped
data inside tags, never as instructions.

## Never silent

| Situation | What happens |
| --- | --- |
| Claude down, timeout (15s per call), refusal, bad output | Fixed holding text, owner emailed "Needs you", handoff |
| Our text is rejected or fails | Owner emailed (our text didn't go through), handoff; Twilio 21610 records an opt-out |
| Customer replies STOP mid-turn | Nothing sent; owner emailed |
| Same message delivered twice | One reply (`conversation-reply:<MessageSid>`) |
| Another worker is busy with this customer | Wait up to 20s, then email the owner this message |
| Worker killed mid-turn (timeout, crash) | The cron (every 5 min) emails the owner any text with no decision after 3 min; ops alert |
| Anything else throws | `conversation.error` ops alert, and the text is emailed to the owner |

A message counts as answered only when it has a row in `conversation_turns`, never just
because we texted afterwards. Leases last 75s (longer than the 60s function limit) and can
only be released by their holder.

## Records

- `conversation_turns`: one row per customer message: action, reason, safety category,
  model, prompt version, token counts, outbound message id. Merged messages are `merged`.
- `conversations`: status, handoff reason, questions asked, and the details learned.
- App logs carry IDs, actions and categories only, never message text or numbers.

## Checking the real model

CI uses a fake model. To run a few real calls against the fake example tenant (costs a few cents):

```bash
LIVE_MODEL_TESTS=1 ANTHROPIC_API_KEY=... pnpm --filter @sc/ai exec vitest run live-model
```
