// The dashboard talks to Supabase as the signed-in owner, with the public
// (anon) key only. The service role key is never used here.
export function readSupabasePublicEnv(env: Record<string, string | undefined> = process.env): { url: string; anonKey: string } | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}
