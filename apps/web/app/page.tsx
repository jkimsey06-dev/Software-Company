import { SITE, companyLabel } from "../lib/site";
import { DraftNotice, SiteFooter } from "./site-footer";

export default function Home() {
  return (
    <main className="page">
      <DraftNotice />
      <h1>{SITE.productName}</h1>
      <p className="lead">
        A front office for local home services businesses: HVAC, plumbing, electrical, roofing, pest control, garage
        doors and landscaping.
      </p>

      <h2>What it does</h2>
      <p>
        When a business misses a call, {SITE.productName} texts the caller back within seconds from the business&apos;s own
        number. An AI assistant asks what service they need, where they are and how urgent it is. If the owner has
        connected their Google Calendar, it offers open estimate times and books the one the customer picks. The owner
        gets an email with the lead and the conversation.
      </p>
      <p>
        Customers can reply STOP at any time to stop texts. Emergencies are sent straight to the owner, and the customer
        is told to call 911.
      </p>

      <h2>Google Calendar</h2>
      <p>
        Business owners can connect their Google Calendar so customers can book estimates. We only check when the owner is
        busy and add booked estimates to calendars the owner owns. We never read the details of other events. See our{" "}
        <a href="/privacy">privacy policy</a> for how we handle this data.
      </p>

      <h2>Who runs it</h2>
      <p>
        {SITE.productName} is run by {companyLabel} for businesses in the Chattanooga and Cleveland, Tennessee area.
      </p>

      <SiteFooter />
    </main>
  );
}
