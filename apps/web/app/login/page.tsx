import { SITE } from "../../lib/site";

export const metadata = { title: `Sign in · ${SITE.productName}`, robots: { index: false } };

const ERRORS: Record<string, string> = {
  bad_email: "That doesn't look like an email address.",
  slow_down: "Please wait a minute before asking for another link.",
  link_expired: "That link has expired or was already used. Request a new one.",
  no_access: "That account isn't linked to a business yet. Ask us to add you.",
  not_configured: "Sign-in isn't set up yet.",
};

export default async function Login({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? ERRORS[params.error] : undefined;
  const sent = params.sent === "1";
  return (
    <main className="page narrow">
      <h1>Sign in</h1>
      {sent ? (
        <p className="notice ok">If that email belongs to a {SITE.productName} account, a sign-in link is on its way. It works once.</p>
      ) : (
        <>
          {error && <p className="notice">{error}</p>}
          <p className="lead">Enter your email and we&apos;ll send you a link. No password needed.</p>
          <form method="post" action="/auth/login" className="stack">
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" autoComplete="email" required maxLength={254} />
            <button type="submit">Email me a link</button>
          </form>
        </>
      )}
      {params.error === "no_access" && (
        <form method="post" action="/auth/signout">
          <button type="submit" className="link">Sign out</button>
        </form>
      )}
    </main>
  );
}
