import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canSendTexts, parseTenantConfig, tenantConfigSchema } from "./tenant-config";

const example = JSON.parse(
  readFileSync(new URL("../../../clients/example-hvac.json", import.meta.url), "utf8"),
);

const withChanges = (patch: Record<string, unknown>) => ({ ...example, ...patch });
const isValid = (input: unknown) => tenantConfigSchema.safeParse(input).success;

describe("tenantConfigSchema", () => {
  it("accepts the example client and fills defaults", () => {
    const config = parseTenantConfig(example);
    expect(config.messaging.optOutText).toBe("Reply STOP to opt out");
    expect(config.messaging.aiDisclosureAtStart).toBe(true);
    expect(config.calendar.slotsToOffer).toBe(3);
  });

  it("rejects empty and non-object input", () => {
    expect(isValid(undefined)).toBe(false);
    expect(isValid({})).toBe(false);
    expect(isValid("config")).toBe(false);
  });

  it("rejects phone numbers that are not E.164", () => {
    expect(
      isValid(withChanges({ escalationContact: { name: "A", phone: "423-555-0100" } })),
    ).toBe(false);
  });

  it("rejects an invalid timezone", () => {
    expect(isValid(withChanges({ timezone: "Eastern" }))).toBe(false);
  });

  it("rejects hours where open is not before close", () => {
    expect(isValid(withChanges({ hours: { mon: [{ open: "17:00", close: "08:00" }] } }))).toBe(
      false,
    );
  });

  it("requires at least one service and a non-empty service area", () => {
    expect(isValid(withChanges({ services: [] }))).toBe(false);
    expect(isValid(withChanges({ serviceArea: { zipCodes: [], cities: [] } }))).toBe(false);
  });

  it("rejects duplicate service ids", () => {
    const dup = { id: "ac-repair", name: "Duplicate" };
    expect(isValid(withChanges({ services: [...example.services, dup] }))).toBe(false);
  });

  it("rejects an unsafe slug", () => {
    expect(isValid(withChanges({ slug: "../other-tenant" }))).toBe(false);
    expect(isValid(withChanges({ slug: "Example HVAC" }))).toBe(false);
  });
});

describe("canSendTexts", () => {
  const messaging = (m: Record<string, unknown>) =>
    parseTenantConfig(withChanges({ messaging: m }));

  it("is false until A2P is approved with a campaign and number", () => {
    expect(canSendTexts(messaging({ a2pStatus: "not_started" }))).toBe(false);
    expect(
      canSendTexts(
        messaging({ a2pStatus: "pending", a2pCampaignId: "CX1", fromNumber: "+14235550199" }),
      ),
    ).toBe(false);
    expect(canSendTexts(messaging({ a2pStatus: "approved", fromNumber: "+14235550199" }))).toBe(
      false,
    );
    expect(canSendTexts(messaging({ a2pStatus: "approved", a2pCampaignId: "CX1" }))).toBe(false);
  });

  it("is true when approved with a campaign and number", () => {
    expect(
      canSendTexts(
        messaging({ a2pStatus: "approved", a2pCampaignId: "CX1", fromNumber: "+14235550199" }),
      ),
    ).toBe(true);
  });
});
