import type { Metadata } from "next";
import { H2, H3, P, UL, PolicyLayout } from "@/app/_components/PolicyLayout";
import { marketingMetadata } from "@/lib/marketing/metadata";
import { AppointmentSmsConsent } from "@/components/sms/AppointmentSmsConsent";
import {
  APPOINTMENT_SMS_CONSENT_V1,
  APPOINTMENT_SMS_CONSENT_VERSION,
  APPOINTMENT_SMS_CONSENT_VERSION_V1,
  APPOINTMENT_SMS_HELP_REPLY,
  APPOINTMENT_SMS_PROGRAM_NAME,
  APPOINTMENT_SMS_STOP_REPLY,
  APPOINTMENT_SMS_SUPPORT_EMAIL,
} from "@/lib/sms/appointment-sms-copy";
import {
  build24hReminderSms,
  build2hReminderSms,
  buildBookingConfirmationSms,
} from "@/lib/sms/templates";

// PUBLIC, no login. The evidence of how a person opts in to Hone appointment texts, for carriers and reviewers.
// EVERYTHING HERE COMES FROM THE SAME CODE THE PRODUCT RUNS: the checkbox is the real component (disabled, with a synthetic studio
// name), the disclosure and the HELP / STOP replies are the constants the inbound route sends, and the sample messages are built by the
// real template functions from synthetic inputs. No real studio, client, phone number or link appears.

export const metadata: Metadata = marketingMetadata("/sms-consent");

const SYNTHETIC_STUDIO = "Example Studio";
// 2030-06-04 is a Tuesday; the moment is synthetic.
const SYNTHETIC_START = new Date("2030-06-04T18:30:00Z");
const TZ = "America/Toronto";
const EXAMPLE_LINK = "https://hone.care/example";

const samples: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Confirmation, sent after booking (and again if the appointment is rescheduled)",
    body: buildBookingConfirmationSms({
      studioName: SYNTHETIC_STUDIO,
      startsAt: SYNTHETIC_START,
      timezone: TZ,
      intakeUrl: null,
      manageUrl: EXAMPLE_LINK,
    }),
  },
  {
    title: "Reminder, about 24 hours before",
    body: build24hReminderSms({
      studioName: SYNTHETIC_STUDIO,
      startsAt: SYNTHETIC_START,
      timezone: TZ,
      manageUrl: EXAMPLE_LINK,
    }),
  },
  {
    title: "Reminder, a few hours before",
    body: build2hReminderSms({
      studioName: SYNTHETIC_STUDIO,
      startsAt: SYNTHETIC_START,
      timezone: TZ,
      manageUrl: EXAMPLE_LINK,
    }),
  },
];

export default function SmsConsentPage() {
  return (
    <PolicyLayout
      title="Hone appointment text messages: how people opt in"
      effectiveDate={`From the release of ${APPOINTMENT_SMS_CONSENT_VERSION}`}
      lastUpdated="November 22, 2026"
    >
      <P>
        Hone is software that studios use to manage appointments. When a client books online with a studio, they can choose to receive
        appointment confirmations and reminders by text message. This page shows exactly how that choice is offered, what is sent, and how
        to get help or stop. It uses a made-up studio, &ldquo;{SYNTHETIC_STUDIO}&rdquo;, and no real person&rsquo;s details.
      </P>

      <H2 id="program">The program</H2>
      <UL>
        <li>
          <strong>Name:</strong> {APPOINTMENT_SMS_PROGRAM_NAME}. Sent by Hone, a single Hone platform number, on behalf of the studio the
          client booked with.
        </li>
        <li>
          <strong>Purpose:</strong> appointment confirmations and reminders only. No marketing or promotional texts.
        </li>
        <li>
          <strong>Frequency:</strong> usually up to 3 messages per appointment, plus a confirmation if the appointment is rescheduled.
        </li>
        <li>
          <strong>Rates:</strong> message and data rates may apply.
        </li>
        <li>
          <strong>Help and opt-out:</strong> reply HELP for help, or STOP to opt out. STOP stops appointment texts from every studio on Hone
          to that number.
        </li>
        <li>
          <strong>Not part of this program:</strong> waitlist texts. They are a separate matter with their own consent and are not covered
          by this page.
        </li>
      </UL>

      <H2 id="opt-in">Where and how a person opts in</H2>
      <P>
        On the studio&rsquo;s public booking page, in the booking form, the client sees the following optional box next to the phone number
        they enter. It is never pre-ticked, it is not required, and the client can book without it. This is the real form component, shown
        here read-only with a made-up studio name.
      </P>
      <div
        role="img"
        aria-label="The appointment text-message opt-in box exactly as shown on the booking form, unticked"
        className="rounded-md border p-4"
        style={{ borderColor: "var(--color-hairline-strong)" }}
      >
        <AppointmentSmsConsent studioName={SYNTHETIC_STUDIO} checked={false} preview />
      </div>
      <P>
        Consent wording version: <strong>{APPOINTMENT_SMS_CONSENT_VERSION}</strong>. It applies to consents given from that release onward.
      </P>

      <H3 id="earlier-wording">Wording shown before this version</H3>
      <P>
        Consent given before this version was given under <strong>{APPOINTMENT_SMS_CONSENT_VERSION_V1}</strong>, which read: &ldquo;
        {APPOINTMENT_SMS_CONSENT_V1.label}&rdquo; with the note &ldquo;{APPOINTMENT_SMS_CONSENT_V1.helper}&rdquo; That earlier consent is
        not widened by the newer wording.
      </P>

      <H2 id="sample-messages">Sample messages</H2>
      <P>These are produced by the same code that sends the real messages, from made-up details.</P>
      {samples.map((m) => (
        <div key={m.title}>
          <H3 id={m.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}>{m.title}</H3>
          <P>
            <span className="block rounded-md border p-3 font-mono text-[0.9375rem]" style={{ borderColor: "var(--color-hairline-strong)" }}>
              {m.body}
            </span>
          </P>
        </div>
      ))}

      <H2 id="help-and-stop">Replying HELP and STOP</H2>
      <H3 id="reply-help">A person replies HELP (or INFO)</H3>
      <P>
        <span className="block rounded-md border p-3 font-mono text-[0.9375rem]" style={{ borderColor: "var(--color-hairline-strong)" }}>
          {APPOINTMENT_SMS_HELP_REPLY}
        </span>
      </P>
      <H3 id="reply-stop">A person replies STOP (or STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT)</H3>
      <P>
        <span className="block rounded-md border p-3 font-mono text-[0.9375rem]" style={{ borderColor: "var(--color-hairline-strong)" }}>
          {APPOINTMENT_SMS_STOP_REPLY}
        </span>
      </P>
      <P>
        After STOP, no further appointment texts are sent to that number. Questions can also be sent to{" "}
        <a className="underline" href={`mailto:${APPOINTMENT_SMS_SUPPORT_EMAIL}`}>
          {APPOINTMENT_SMS_SUPPORT_EMAIL}
        </a>
        .
      </P>

      <H2 id="policies">Policies</H2>
      <P>
        <a className="underline" href="/privacy#appointment-text-messages">
          Privacy Policy: appointment text messages
        </a>
        {" · "}
        <a className="underline" href="/terms#appointment-text-messages">
          Terms: appointment text messages
        </a>
      </P>
    </PolicyLayout>
  );
}
