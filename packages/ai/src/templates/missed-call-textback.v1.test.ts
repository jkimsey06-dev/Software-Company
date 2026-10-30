import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTenantConfig } from "@sc/shared";
import { renderMissedCallTextbackV1 } from "./missed-call-textback.v1";

const example = JSON.parse(
  readFileSync(new URL("../../../../clients/example-hvac.json", import.meta.url), "utf8"),
);
const config = (messaging: Record<string, unknown> = {}) =>
  parseTenantConfig({ ...example, messaging: { ...example.messaging, ...messaging } });

describe("renderMissedCallTextbackV1", () => {
  it("discloses the AI assistant and includes opt-out wording by default", () => {
    const body = renderMissedCallTextbackV1(config());
    expect(body).toContain("AI assistant for Example Heating & Air");
    expect(body.endsWith("Reply STOP to opt out")).toBe(true);
  });

  it("omits the disclosure only when the tenant turns it off, but keeps opt-out", () => {
    const body = renderMissedCallTextbackV1(config({ aiDisclosureAtStart: false }));
    expect(body).not.toContain("AI assistant");
    expect(body).toContain("Reply STOP to opt out");
  });

  it("stays within two SMS segments", () => {
    expect(renderMissedCallTextbackV1(config()).length).toBeLessThanOrEqual(306);
  });
});
