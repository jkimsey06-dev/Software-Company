// Public business details shown on the homepage and privacy policy.
// Fill these in before deploying; pages show a draft notice until then.
export const SITE = {
  // Your company's legal or trading name.
  companyName: "",
  // Product name shown to owners and on Google's consent screen.
  productName: "Front Office",
  contactEmail: "",
  mailingAddress: "",
  privacyLastUpdated: "2026-10-30",
};

export const siteIsDraft = !SITE.companyName || !SITE.contactEmail || !SITE.mailingAddress;

export const companyLabel = SITE.companyName || "[Company name]";
export const emailLabel = SITE.contactEmail || "[contact email]";
export const addressLabel = SITE.mailingAddress || "[mailing address]";
