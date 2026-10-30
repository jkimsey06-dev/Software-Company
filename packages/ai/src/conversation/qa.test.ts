// QA: phrasings that try to slip past emergency.ts and asksIfAi. The reply
// guard was removed: every text sent is now a fixed template.
import { describe, expect, it } from "vitest";
import { asksIfAi, looksLikeEmergency } from "./emergency";

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
