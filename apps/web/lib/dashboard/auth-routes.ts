import { z } from "zod";

const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

export function parseEmail(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const r = emailSchema.safeParse(value);
  return r.success ? r.data : null;
}

// Supabase email-link tokens are URL-safe strings; anything else is refused
// before it gets anywhere near a query.
export function parseTokenHash(value: string | null): string | null {
  return value && /^[A-Za-z0-9_-]{8,200}$/.test(value) ? value : null;
}

// State-changing POSTs must come from our own pages.
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}
