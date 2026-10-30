import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Google refresh tokens are encrypted with AES-256-GCM before they reach the
// database, using a key that lives only in the server environment
// (CALENDAR_TOKEN_KEY, 32 random bytes, base64). A database leak alone doesn't
// expose any calendar. The tenant id is bound in as associated data, so a
// token copied onto another tenant's row fails to decrypt.

const VERSION = "v1";
const TAG_BYTES = 16;

export function parseKey(base64: string | undefined): Buffer {
  const key = Buffer.from(base64 ?? "", "base64");
  if (key.length !== 32) throw new Error("CALENDAR_TOKEN_KEY must be 32 bytes, base64-encoded");
  return key;
}

export function encryptToken(plaintext: string, key: Buffer, tenantId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(tenantId));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

export function decryptToken(sealed: string, key: Buffer, tenantId: string): string {
  const parts = sealed.split(".");
  const [version, iv, tag, data] = parts;
  if (parts.length !== 4 || version !== VERSION || !iv || !tag || !data) throw new Error("unrecognized token format");
  const authTag = Buffer.from(tag, "base64url");
  // A short tag would weaken the check: accept exactly 16 bytes.
  if (authTag.length !== TAG_BYTES) throw new Error("unrecognized token format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"), { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(tenantId));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}
