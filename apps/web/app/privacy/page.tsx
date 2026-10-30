import { SITE, addressLabel, companyLabel, emailLabel } from "../../lib/site";
import { DraftNotice, SiteFooter } from "../site-footer";

export const metadata = {
  title: `Privacy policy · ${SITE.productName}`,
};

// DRAFT for legal review. Keep it in step with what the code actually does.
export default function Privacy() {
  const product = SITE.productName;
  return (
    <main className="page">
      <DraftNotice />
      <h1>Privacy policy</h1>
      <p>Last updated: {SITE.privacyLastUpdated}</p>
      <p>
        {product} is run by {companyLabel} (&quot;we&quot;). We provide it to local home services businesses (&quot;our
        clients&quot;) to answer missed calls by text and book estimates. This policy explains what we collect, why, who
        we share it with, and the choices you have.
      </p>

      <h2>If you call or text one of our clients</h2>
      <p>We collect:</p>
      <ul>
        <li>Your phone number, and when you called or texted.</li>
        <li>The text messages you send and the ones we send you.</li>
        <li>What you tell us about the job: the service you need, your area, how urgent it is, and the street address for an estimate.</li>
      </ul>
      <p>
        We use this only to reply to you on the business&apos;s behalf, pass your request to the business, and book an
        estimate if you ask for one. We don&apos;t record calls. The business you contacted can see your information.
      </p>
      <p>
        <strong>Texts.</strong> Reply STOP at any time to stop texts from that business. Reply HELP for help. Message and
        data rates may apply. We don&apos;t send marketing texts, and we never sell or share your phone number for anyone
        else&apos;s marketing.
      </p>
      <p>
        <strong>AI.</strong> Replies are handled by an AI assistant. It reads your messages to work out what you need;
        every text we send is a fixed, pre-approved message. Ask &quot;are you a bot?&quot; and it will tell you it&apos;s
        an AI assistant. Ask for a person at any time and the business will contact you.
      </p>

      <h2>If you&apos;re a business owner using {product}</h2>
      <p>
        We keep your business details, settings, and the contact details you give us for alerts. Leads and conversations
        belong to you; we process them on your behalf.
      </p>

      <h2>Google Calendar data</h2>
      <p>If you connect your Google Calendar, we ask for two permissions:</p>
      <ul>
        <li>
          <strong>See when you&apos;re busy</strong> (<code>calendar.freebusy</code>): start and end times only, so we
          offer customers times you&apos;re free. We can&apos;t see event titles, attendees or details.
        </li>
        <li>
          <strong>Create events on calendars you own</strong> (<code>calendar.events.owned</code>): to add an estimate a
          customer books. Each event shows the customer&apos;s phone number, the service, their area, and the address
          they gave.
        </li>
      </ul>
      <p>
        We store your Google access token encrypted, and use it only for these two things. We don&apos;t use Google data
        for advertising, don&apos;t sell it, don&apos;t use it to train AI models, and don&apos;t let people read it except
        when you ask us to, for security, or when the law requires it. The open times we offer a customer may be passed
        to our AI provider so it can understand which one they picked.
      </p>
      <p>
        {product}&apos;s use and transfer to any other app of information received from Google APIs will adhere to the{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>,
        including the Limited Use requirements.
      </p>
      <p>
        You can disconnect at any time from your Google Account at{" "}
        <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>. Email us and we&apos;ll
        delete your stored token.
      </p>

      <h2>Who we share data with</h2>
      <p>We use these service providers, only to run {product}:</p>
      <ul>
        <li>Twilio: phone calls and text messages.</li>
        <li>Anthropic: the AI that reads customer messages.</li>
        <li>Supabase: our database.</li>
        <li>Vercel: hosting.</li>
        <li>Resend: email alerts to business owners.</li>
        <li>Google: calendar, for owners who connect it.</li>
      </ul>
      <p>We don&apos;t sell personal information. We may disclose it if the law requires it.</p>

      <h2>How long we keep it</h2>
      <p>[Retention period to be confirmed.] Ask us to delete your information at any time and we will, unless the law requires us to keep it.</p>

      <h2>Security</h2>
      <p>
        Data is encrypted in transit. Each client&apos;s data is kept separate from every other client&apos;s, and calendar
        tokens are encrypted at rest.
      </p>

      <h2>Children</h2>
      <p>{product} isn&apos;t meant for children under 13, and we don&apos;t knowingly collect their information.</p>

      <h2>Changes</h2>
      <p>If we change this policy, we&apos;ll update the date at the top.</p>

      <h2>Contact</h2>
      <p>
        {companyLabel}, {addressLabel}. Email: <a href={`mailto:${SITE.contactEmail}`}>{emailLabel}</a>.
      </p>

      <SiteFooter />
    </main>
  );
}
