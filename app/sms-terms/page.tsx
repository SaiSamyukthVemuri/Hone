import type { Metadata } from "next";
import { H2, P, UL, PolicyLayout } from "@/app/_components/PolicyLayout";
import { marketingMetadata } from "@/lib/marketing/metadata";
import {
  APPOINTMENT_SMS_CONSENT_VERSION,
  APPOINTMENT_SMS_PROGRAM_NAME,
  APPOINTMENT_SMS_SUPPORT_EMAIL,
  APPOINTMENT_SMS_FREQUENCY,
  WAITLIST_SMS_FREQUENCY,
} from "@/lib/sms/appointment-sms-copy";

// PUBLIC, no login. The SMS program terms a carrier or reviewer can open. Wording comes from the same constants the form, the route and
// /sms-consent use. Not indexed, not in the sitemap.
export const metadata: Metadata = marketingMetadata("/sms-terms");

export default function SmsTermsPage() {
  return (
    <PolicyLayout
      title="Hone SMS Terms"
      effectiveDate={`From the release of ${APPOINTMENT_SMS_CONSENT_VERSION}`}
      lastUpdated="November 22, 2026"
    >
      <H2 id="program">The program</H2>
      <P>
        {APPOINTMENT_SMS_PROGRAM_NAME} are text messages that Hone sends on behalf of a studio that uses Hone, to a person who opted in on
        that studio&rsquo;s booking or waitlist page. They are not marketing messages.
      </P>
      <UL>
        <li>
          <strong>Appointment texts:</strong> confirmations and reminders about a booking: {APPOINTMENT_SMS_FREQUENCY}.
        </li>
        <li>
          <strong>Waitlist texts:</strong> only if you said Yes on a studio&rsquo;s waitlist form, and only for that studio: {WAITLIST_SMS_FREQUENCY}.
        </li>
      </UL>
      <H2 id="opt-in">Opting in</H2>
      <P>
        Opting in is optional and never pre-selected. Consent is not a condition of booking or of joining a waitlist. You can see the exact
        opt-in steps on the{" "}
        <a className="underline" href="/sms-consent">
          opt-in evidence page
        </a>
        .
      </P>
      <H2 id="rates-help-stop">Rates, help and opting out</H2>
      <UL>
        <li>Message and data rates may apply.</li>
        <li>
          Reply <strong>HELP</strong> for help, or email{" "}
          <a className="underline" href={`mailto:${APPOINTMENT_SMS_SUPPORT_EMAIL}`}>
            {APPOINTMENT_SMS_SUPPORT_EMAIL}
          </a>
          .
        </li>
        <li>
          Reply <strong>STOP</strong> (or STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT) to opt out. STOP applies to Hone texts from every studio to
          that number. Email may still be used.
        </li>
      </UL>
      <H2 id="carriers">Carriers and delivery</H2>
      <P>
        Carriers are not liable for delayed or undelivered messages. Messages are delivered through Twilio, our service provider.
      </P>
      <H2 id="privacy">Privacy</H2>
      <P>
        Mobile numbers and text-message consent are not sold, and are not shared with third parties for marketing or promotional purposes. See the{" "}
        <a className="underline" href="/privacy#appointment-text-messages">
          Privacy Policy
        </a>{" "}
        and the{" "}
        <a className="underline" href="/terms#appointment-text-messages">
          Terms
        </a>
        .
      </P>
    </PolicyLayout>
  );
}
