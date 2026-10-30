import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken, parseKey } from "./crypto";
import { eventIdFor } from "./google";
import { createLinkToken, verifyLinkToken } from "./link";

const TENANT = "10000000-0000-4000-8000-000000000001";
const OTHER = "10000000-0000-4000-8000-000000000002";
const SECRET = "s".repeat(40);

describe("token encryption", () => {
  const key = randomBytes(32);

  it("round-trips and never stores the token in the clear", () => {
    const sealed = encryptToken("1//refresh-token", key, TENANT);
    expect(sealed).not.toContain("refresh-token");
    expect(decryptToken(sealed, key, TENANT)).toBe("1//refresh-token");
  });

  it("fails for another tenant, a wrong key, or a tampered value", () => {
    const sealed = encryptToken("1//refresh-token", key, TENANT);
    expect(() => decryptToken(sealed, key, OTHER)).toThrow();
    expect(() => decryptToken(sealed, randomBytes(32), TENANT)).toThrow();
    const parts = sealed.split(".");
    parts[3] = Buffer.from("x").toString("base64url") + parts[3]!.slice(2);
    expect(() => decryptToken(parts.join("."), key, TENANT)).toThrow();
  });

  it("requires a 32-byte key", () => {
    expect(() => parseKey(undefined)).toThrow();
    expect(() => parseKey(randomBytes(16).toString("base64"))).toThrow();
    expect(parseKey(randomBytes(32).toString("base64"))).toHaveLength(32);
  });
});

describe("connect link", () => {
  const now = Date.parse("2026-10-30T18:00:00Z");

  it("verifies for its tenant until it expires", () => {
    const token = createLinkToken(TENANT, SECRET, now);
    expect(verifyLinkToken(token, SECRET, now + 1000)?.tenantId).toBe(TENANT);
    expect(verifyLinkToken(token, SECRET, now + 8 * 24 * 3_600_000)).toBeNull();
  });

  it("rejects a forged, edited or wrongly signed token", () => {
    const token = createLinkToken(TENANT, SECRET, now);
    const [body, mac] = token.split(".");
    const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), t: OTHER })).toString("base64url");
    expect(verifyLinkToken(`${edited}.${mac}`, SECRET, now)).toBeNull();
    expect(verifyLinkToken(token, "x".repeat(40), now)).toBeNull();
    expect(verifyLinkToken("garbage", SECRET, now)).toBeNull();
    expect(verifyLinkToken(null, SECRET, now)).toBeNull();
    expect(verifyLinkToken(token, undefined, now)).toBeNull();
  });

  it("refuses a short secret", () => {
    expect(() => createLinkToken(TENANT, "short", now)).toThrow();
    expect(verifyLinkToken(createLinkToken(TENANT, SECRET, now), "short", now)).toBeNull();
  });
});

describe("eventIdFor", () => {
  it("is deterministic and valid base32hex for Google", () => {
    const id = eventIdFor("3f2a9c1e-0000-4000-8000-00000000abcd", new Date("2026-11-02T13:00:00Z"));
    expect(id).toBe(eventIdFor("3f2a9c1e-0000-4000-8000-00000000abcd", new Date("2026-11-02T13:00:00Z")));
    expect(id).toMatch(/^[0-9a-v]{5,1024}$/);
  });
});
