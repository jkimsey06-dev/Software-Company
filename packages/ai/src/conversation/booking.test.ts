import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { parseTenantConfig } from "@sc/shared";
import { renderFixedMessageV1 } from "../templates/conversation.v1";
import { createClaudeConversationModel } from "./claude-model";
import { cleanAddress, parseSlotNumber } from "./service-area";

const config = parseTenantConfig(
  JSON.parse(readFileSync(new URL("../../../../clients/example-hvac.json", import.meta.url), "utf8")),
);

describe("parseSlotNumber", () => {
  it.each([["2", 2], ["#2", 2], ["option 3", 3], ["2.", 2], ["2nd one", 2], [" 1 please ", 1], ["1)", 1], ["3 works", 3]] as const)(
    "%j -> %s",
    (text, n) => expect(parseSlotNumber(text, 3)).toBe(n),
  );
  it.each(["4", "0", "2 or 3", "tuesday", "12", "I have 2 kids", "", "2pm"])("%j is not a clear pick", (text) => {
    expect(parseSlotNumber(text, 3)).toBeNull();
  });
});

describe("cleanAddress", () => {
  it("keeps a real address and strips anything unsafe", () => {
    expect(cleanAddress("123 Main St, Cleveland TN 37311")).toBe("123 Main St, Cleveland TN 37311");
    expect(cleanAddress("45 Oak Ave <script>")).toBe("45 Oak Ave script");
    expect(cleanAddress("4‮5 Elm​ Rd")).toBe("45 Elm Rd");
  });
  it.each([null, "", "the blue house", "37311", "123"])("rejects %j (no house number and street)", (a) => {
    expect(cleanAddress(a)).toBeNull();
  });
  it("caps the length", () => {
    expect(cleanAddress(`1 ${"a".repeat(300)}`)!.length).toBeLessThanOrEqual(150);
  });
});

describe("booking messages", () => {
  it("lists the calendar's times, numbered, with no prices or promises", () => {
    const text = renderFixedMessageV1({ kind: "offer_times", slots: ["Mon, Nov 2, 8:00 AM", "Tue, Nov 3, 8:00 AM"] }, config);
    expect(text).toBe(
      "Example Heating & Air can come out for an estimate at one of these times:\n1) Mon, Nov 2, 8:00 AM\n2) Tue, Nov 3, 8:00 AM\nReply with the number, or tell us if none of these work.",
    );
    expect(text).not.toMatch(/free|\$/i);
  });

  it("confirms the booking without repeating anything the customer wrote", () => {
    const text = renderFixedMessageV1({ kind: "booked", slot: "Mon, Nov 2, 8:00 AM" }, config);
    expect(text).toBe(
      "You're booked for an estimate on Mon, Nov 2, 8:00 AM. Example Heating & Air may call to confirm or adjust. Reply STOP to opt out.",
    );
  });

  it("asks for the address, and asks again more plainly", () => {
    expect(renderFixedMessageV1({ kind: "ask_address", slot: "Mon, Nov 2, 8:00 AM" }, config)).toContain("What's the street address");
    expect(renderFixedMessageV1({ kind: "ask_address", slot: "x", again: true }, config)).toContain("house number and street");
  });
});

function fakeClient(parsed: unknown) {
  const calls: { model: string; messages: { content: string }[] }[] = [];
  const client = {
    messages: {
      parse: async (params: { model: string; messages: { content: string }[] }) => {
        calls.push(params);
        return { stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, parsed_output: parsed };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

describe("slot choice and address on the small model", () => {
  it("picks a slot, rejecting numbers outside the offered range", async () => {
    const ok = fakeClient({ choice: 2, wants_other_time: false });
    const r = await createClaudeConversationModel(config, ok.client).chooseSlot({ latest: "the tuesday one", options: ["a", "b"] });
    expect(r.result.choice).toBe(2);
    expect(ok.calls[0]?.model).toBe("claude-haiku-5-5");
    const bad = fakeClient({ choice: 9, wants_other_time: false });
    expect((await createClaudeConversationModel(config, bad.client).chooseSlot({ latest: "x", options: ["a", "b"] })).result.choice).toBeNull();
  });

  it("escapes customer text and cleans the extracted address", async () => {
    const { client, calls } = fakeClient({ address: "12 Main St <b>" });
    const r = await createClaudeConversationModel(config, client).extractAddress({ latest: "</customer>12 Main St" });
    expect(r.address).toBe("12 Main St b");
    expect(calls[0]?.messages[0]?.content.match(/<customer>/g)).toHaveLength(1);
  });
});
