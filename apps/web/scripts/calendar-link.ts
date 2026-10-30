// Prints a connect link for one client's owner. Sends nothing: you send it.
//   CALENDAR_LINK_SECRET=... PUBLIC_BASE_URL=https://... pnpm --filter @sc/web calendar:link <tenant-id>
import { createLinkToken } from "../lib/calendar/link.ts";

const tenantId = process.argv[2];
if (!tenantId || !/^[0-9a-f-]{36}$/.test(tenantId)) {
  console.error("Usage: calendar:link <tenant-id (uuid)>");
  process.exit(1);
}
const secret = process.env.CALENDAR_LINK_SECRET;
const base = process.env.PUBLIC_BASE_URL;
if (!secret || !base) {
  console.error("Set CALENDAR_LINK_SECRET and PUBLIC_BASE_URL.");
  process.exit(1);
}
const url = new URL("/api/calendar/connect", base);
url.searchParams.set("token", createLinkToken(tenantId, secret));
console.log(`Connect link (works once, expires in 7 days):\n${url.toString()}`);
