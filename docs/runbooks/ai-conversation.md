# AI text conversation

After the missed-call text-back, the customer's replies go to an AI assistant
that learns the service, area and urgency, then hands the lead to the owner.

## When it runs

All of these must be true, otherwise the customer's text is emailed to the owner:

- `ANTHROPIC_API_KEY` is set
- The tenant can send texts (A2P approved, campaign id, `fromNumber` owned by the tenant)
- The customer is a US/Canada number, isn't one of the tenant's own numbers, and hasn't opted out
- The message has words and isn't a keyword (STOP, HELP, CANCEL...) or an opt-out phrase
- The customer's conversation is active. After a handoff or completion, a person is in
  charge for 7 days and the AI stays out.

## Each message, in order

1. **Emergency words** (no AI): gas smell, smoke, fire, sparks, CO alarm, flooding, water
   near electrical, no heat/AC with a baby or elderly person... Fixed text pointing to 911,
   owner texted and emailed, conversation handed off.
2. **"Are you a bot?"** Fixed honest answer; conversation continues.
3. **Reply limit**: after 6 AI replies, fixed handoff text.
4. **Safety check** (`claude-haiku-5-5`, `safety-classifier@v1`): emergency, upset,
   wants a person, wrong number, spam, or normal. Anything but normal stops the AI.
5. **Reply** (`claude-sonnet-5-5`, `missed-call-qualifier@v1`): structured output with the
   reply text and the details it learned. Only the tenant's services, area and approved FAQ
   are in the prompt; customer text is passed as escaped data.
6. **Reply check** (`packages/ai/src/conversation/guard.ts`): no prices, discounts, free,
   warranties, clock times, "within N hours", arrival promises, availability, claiming to be
   human, links, phone numbers, markup, or over 320 characters. A failing reply is never sent:
   a fixed holding text goes instead and the owner takes over.
7. When service, area and urgency are all known: fixed "they'll reach out to set up a time"
   text, conversation completed, owner emailed "Lead ready".

Prices, times and availability are never quoted. Calendar booking comes in a later PR.

## Failure handling

| Situation | What happens |
| --- | --- |
| Claude down, timeout, refusal, bad output | Fixed holding text, owner emailed "Needs you", handed off |
| Customer texts several times quickly | One reply covering all of them |
| Same message delivered twice | One reply (key `conversation-reply:<MessageSid>`) |
| Two messages processed at once | One worker holds the conversation lease; the other's message is picked up before release |
| Customer replies STOP mid-turn | Checked again right before sending |
| Owner emergency text fails | Owner still emailed; `conversation.owner_alert_failed` ops alert |
| Anything else throws | `conversation.error` ops alert, and the text is emailed to the owner |

## Logs and records

- `conversation_turns`: one row per customer message: action, safety category, model,
  prompt version, reply-check violations, token counts, outbound message id.
- `outbound_messages.template_version`: `missed-call-qualifier@v1/claude-sonnet-5-5` for AI
  replies, `conversation-templates@v1` for fixed texts.
- App logs carry IDs, actions and categories only, never message text or numbers.

## Checking the real model

CI uses a fake model. To run a few real calls against the fake example tenant (costs a few cents):

```bash
LIVE_MODEL_TESTS=1 ANTHROPIC_API_KEY=... pnpm --filter @sc/ai exec vitest run live-model
```
