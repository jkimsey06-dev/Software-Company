import { SITE, addressLabel, companyLabel, emailLabel, siteIsDraft } from "../lib/site";

export function DraftNotice() {
  if (!siteIsDraft) return null;
  return <p className="notice">Draft: business details are not filled in yet (apps/web/lib/site.ts).</p>;
}

export function SiteFooter() {
  return (
    <footer className="footer">
      <p>
        {SITE.productName} by {companyLabel} · {addressLabel} · <a href={`mailto:${SITE.contactEmail}`}>{emailLabel}</a>
      </p>
      <p>
        <a href="/">Home</a> · <a href="/privacy">Privacy policy</a>
      </p>
    </footer>
  );
}
