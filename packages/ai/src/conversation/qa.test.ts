// QA: phrasings and replies that try to slip past emergency.ts and guard.ts.
// Tests that fail document a gap; see the QA report for the product call.
import { describe, expect, it } from "vitest";
import { asksIfAi, looksLikeEmergency } from "./emergency";
import { checkReply } from "./guard";

describe("QA emergency: real emergencies the word list misses", () => {
  it.each([
    "i smell natural gas in the basement",
    "smel gas by the stove", // typo
    "propane leak at the tank",
    "huele a gas en la cocina", // Spanish: smells like gas
    "hay una fuga de gas", // Spanish: gas leak
    "hay humo saliendo del horno", // Spanish: smoke from the furnace
    "se inunda el sotano", // Spanish: basement flooding
    "water pouring through the ceiling light",
    "no heat and my mother is 90 years old",
    "furnace is out and I have a 2 month old",
    "no heat, it's 15 degrees inside and my wife is on chemo",
    "the breaker panel is buzzing and hot to the touch",
    "g​as leak", // zero-width space inside a word
  ])("%j is an emergency", (text) => {
    expect(looksLikeEmergency(text)).toBe(true);
  });
});

describe("QA emergency: ordinary requests wrongly flagged", () => {
  // A false alarm hands the lead off with a 911 text and texts the owner
  // EMERGENCY. Safety-biased by design, but these are clearly routine.
  it.each([
    "my gas furnace needs a tune up",
    "can you fire up my grill's gas line hookup",
    "we're getting flooded with calls, just want a quote for a new roof",
    "smoke detector is chirping, needs a battery",
    "no rush, the AC is a little noisy. we have a baby so mornings are best",
    "need a quote for a fire pit gas line",
    "I'm not smoking, there's no smoke, just a weird noise",
  ])("%j is not an emergency", (text) => {
    expect(looksLikeEmergency(text)).toBe(false);
  });
});

describe("QA asksIfAi", () => {
  it.each(["is this automated?", "u a bot?", "is this a bot or a real person", "am i texting a human"])(
    "%j asks if it's an AI",
    (text) => {
      expect(asksIfAi(text)).toBe(true);
    },
  );
  it("'are you real busy this week?' is not asking if it's an AI", () => {
    expect(asksIfAi("are you real busy this week?")).toBe(false);
  });
});

describe("QA guard: promises that get through", () => {
  it.each([
    ["spelled-out price", "A service call usually runs about eighty nine dollars."],
    ["hundred", "Most repairs are under two hundred."],
    ["tmrw", "A tech can come out tmrw morning."],
    ["weekday", "We can have someone out first thing Monday."],
    ["be out", "Our tech can be out this afternoon."],
    ["by 3", "We'll have someone there by 3."],
    ["openings (plural)", "We have openings Monday and Tuesday."],
    ["slots (plural)", "We have slots open this week."],
    ["schedule", "I can get you on the schedule for Thursday."],
    ["claims human", "This is Sarah from the office, happy to help."],
    ["claims human 2", "Nope, real human here!"],
    ["link spelled", "Book at example dot com."],
    ["price no symbol", "Diagnostic fee is 89."],
  ])("%s: %j is blocked", (_label, text) => {
    expect(checkReply(text).ok).toBe(false);
  });
});

describe("QA guard: legitimate questions wrongly blocked", () => {
  // Every block ends the AI conversation (fixed holding text + handoff).
  it.each([
    "Is it a gas or electric furnace?",
    "What's the ZIP code for the job?",
    "Feel free to send a photo of the unit.",
    "Is the outdoor spigot a frost-free one?",
    "Is it 100% out or just weak?",
    "Sorry you're dealing with that. Is water still running?",
    "Is it the upstairs or downstairs unit?",
    "Sorry, we deal with a lot of these. Which room is it in?",
  ])("%j is allowed", (text) => {
    expect(checkReply(text)).toEqual({ ok: true, violations: [] });
  });
});
