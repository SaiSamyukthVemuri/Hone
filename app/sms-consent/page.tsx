import type { Metadata } from "next";
import { H2, H3, P, UL, PolicyLayout } from "@/app/_components/PolicyLayout";
import { marketingMetadata } from "@/lib/marketing/metadata";
import { AppointmentSmsConsent } from "@/components/sms/AppointmentSmsConsent";
import { WaitlistSmsConsentFieldset } from "@/components/sms/WaitlistSmsConsentFieldset";
import {
  APPOINTMENT_SMS_CONSENT_V1,
  APPOINTMENT_SMS_FREQUENCY,
  WAITLIST_SMS_FREQUENCY,
  APPOINTMENT_SMS_AUDIENCE,
  WAITLIST_SMS_AUDIENCE,
  APPOINTMENT_SMS_CONSENT_VERSION,
  APPOINTMENT_SMS_CONSENT_VERSION_V1,
  APPOINTMENT_SMS_HELP_REPLY,
  APPOINTMENT_SMS_PROGRAM_NAME,
  APPOINTMENT_SMS_SUPPORT_EMAIL,
} from "@/lib/sms/appointment-sms-copy";
import {
  build24hReminderSms,
  build2hReminderSms,
  buildBookingConfirmationSms,
  buildWaitlistInvitationSms,
  buildWaitlistJoinAckSms,
} from "@/lib/sms/templates";
import { SMS_JOIN_CONSENT_TEXT_VERSION, SMS_OPERATIONAL_CONSENT_TEXT_VERSION } from "@/lib/waitlist/prospect-sms-consent";

// PUBLIC, no login. The evidence of how a person opts in to Hone appointment texts, for carriers and reviewers.
// EVERYTHING HERE COMES FROM THE SAME CODE THE PRODUCT RUNS: the checkbox is the real component (disabled, with a synthetic studio
// name), the disclosure and the HELP reply is the constant the inbound route sends (STOP gets no Hone reply: the carrier's is the only one), and the sample messages are built by the
// real template functions from synthetic inputs. No real studio, client, phone number or link appears.

export const metadata: Metadata = marketingMetadata("/sms-consent");

const SYNTHETIC_STUDIO = "Example Studio";
// 2030-06-04 is a Tuesday; the moment is synthetic.
const SYNTHETIC_START = new Date("2030-06-04T18:30:00Z");
const TZ = "America/Toronto";
const EXAMPLE_LINK = "https://hone.care/example";

const samples: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Confirmation, sent after booking (a rescheduled booking starts again)",
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
    title: "Reminder, a few hours before (when a studio turns it on)",
    body: build2hReminderSms({
      studioName: SYNTHETIC_STUDIO,
      startsAt: SYNTHETIC_START,
      timezone: TZ,
      manageUrl: EXAMPLE_LINK,
    }),
  },
];

const waitlistSamples: ReadonlyArray<{ title: string; body: string }> = [
  { title: "Waitlist: acknowledgement, sent when someone who said Yes joins", body: buildWaitlistJoinAckSms({ studioName: SYNTHETIC_STUDIO }) },
  {
    title: "Waitlist: invitation to book, sent beside the invitation email",
    body: buildWaitlistInvitationSms({
      studioName: SYNTHETIC_STUDIO,
      invitationUrl: "https://hone.care/invitation/example",
      expiresAtLabel: "Friday, June 7 at 5:00 PM",
    }),
  },
];

const SCREENSHOTS: ReadonlyArray<{ file: string; alt: string; caption: string; width: number; height: number }> = [
  { file: "booking-form-sms-optin-unticked.png", alt: "The public booking form with the appointment text-message box, not ticked", caption: "Booking form: the appointment text-message box, never pre-ticked, with its disclosure and links.", width: 980, height: 1799 },
  { file: "booking-form-sms-optin-ticked.png", alt: "The public booking form with the appointment text-message box ticked by the client", caption: "Booking form: the same box after the client ticks it.", width: 980, height: 1799 },
  { file: "waitlist-join-form-sms-question.png", alt: "The waitlist join form with the text-message Yes/No question, neither chosen", caption: "Waitlist join form: the Yes/No question with neither answer chosen, and the notice beside it.", width: 980, height: 1500 },
  { file: "waitlist-join-form-sms-yes.png", alt: "The waitlist join form with Yes chosen", caption: "Waitlist join form: after the person answers Yes.", width: 980, height: 1500 },
  { file: "owner-record-consent-form.png", alt: "The studio owner's screen for recording consent a person gave the studio outside Hone", caption: "Studio owner screen: recording that a person told the studio they agree to waitlist texts, with where the evidence is and the day (or that the day is not known).", width: 631, height: 551 },
];

export default function SmsConsentPage() {
  return (
    <PolicyLayout
      title="Hone appointment text messages: how people opt in"
      effectiveDate={`From the release of ${APPOINTMENT_SMS_CONSENT_VERSION}`}
      lastUpdated="November 22, 2026"
    >
      <P>
        Hone is software, operated by Hone Care, Inc., a Delaware corporation, that studios use to manage appointments. When a client books online with a studio, they can choose to receive
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
          <strong>Purpose:</strong> appointment confirmations and reminders, and waitlist updates from a studio. No marketing or promotional texts.
        </li>
        <li>{APPOINTMENT_SMS_AUDIENCE}</li>
        <li>
          {WAITLIST_SMS_AUDIENCE} The join acknowledgement text goes only to people who answered Yes on the form.
        </li>
        <li>
          <strong>Frequency:</strong> appointment texts, {APPOINTMENT_SMS_FREQUENCY}. Waitlist texts, {WAITLIST_SMS_FREQUENCY}.
        </li>
        <li>
          <strong>Rates:</strong> message and data rates may apply.
        </li>
        <li>
          <strong>Help and opt-out:</strong> reply HELP for help, or STOP to opt out. STOP opts that number out of every matching client and waitlist record at that time, across studios.
        </li>
        <li>
          <strong>Studio-specific consent:</strong> saying Yes on one studio&rsquo;s waitlist covers that studio&rsquo;s waitlist only; it does
          not subscribe anyone to other studios.
        </li>
        <li>
          <strong>Terms:</strong>{" "}
          <a className="underline" href="/sms-terms">
            SMS Terms
          </a>
          .
        </li>
      </UL>

      <H2 id="opt-in">Where and how a person opts in: appointment texts</H2>
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

      <H2 id="waitlist-opt-in">Where and how a person opts in: waitlist texts</H2>
      <P>
        When a studio runs a waitlist for new clients, the join form asks the question below. Neither answer is preselected, and answering No
        still joins the waitlist with the same place in the queue. This is the real form component, shown read-only (nothing can be submitted
        from this page) with a made-up studio name.
      </P>
      <div
        role="img"
        aria-label="The waitlist text-message question exactly as shown on the join form, with no answer selected"
        className="rounded-md border p-4"
        style={{ borderColor: "var(--color-hairline-strong)" }}
      >
        <WaitlistSmsConsentFieldset questionId="sms-consent-preview-question" answer={null} preview />
      </div>
      <P>
        The consent text that is stored with a Yes is <strong>{SMS_JOIN_CONSENT_TEXT_VERSION}</strong>: the question above. The notice under the
        question (sender, frequency, rates, HELP and STOP, and the links) sits next to that stored text; it does not change it. Earlier waitlist
        consents were given under {SMS_OPERATIONAL_CONSENT_TEXT_VERSION} or the same question, and are not widened.
      </P>

      <H3 id="studio-recorded">Waitlist consent recorded by the studio</H3>
      <P>
        A person can also tell a studio, outside Hone, that they agree to waitlist texts. A studio owner can then record that in Hone on the
        person&rsquo;s waitlist entry. The owner states that the person agreed to texts about this waitlist and any appointment offered from it,
        gives a short reference to where that agreement is recorded, and gives the day they agreed or says the day is not known. Hone stores
        that consent on that entry only, marked as recorded by the practitioner and limited to that purpose, so it covers that studio&rsquo;s
        waitlist only. Only an owner of that studio can record it, and a number that has already replied STOP is refused. The person can reply
        STOP at any time, which ends it.
      </P>

      <H2 id="screenshots">Screenshots of the real screens</H2>
      <P>
        These were captured from the real application, running against a test database, with a made-up studio (&ldquo;Example Studio&rdquo;) and made-up
        people. They contain no real client or studio data.
      </P>
      {SCREENSHOTS.map((shot) => (
        <figure key={shot.file} className="my-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/sms-consent/${shot.file}`} alt={shot.alt} width={shot.width} height={shot.height} className="h-auto w-full max-w-[640px] border" loading="lazy" />
          <figcaption className="mt-1 text-[13px]">{shot.caption}</figcaption>
        </figure>
      ))}

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
      <H3 id="waitlist-samples">Waitlist texts</H3>
      {waitlistSamples.map((m) => (
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
      <P>
        On the toll-free number, HELP is answered by Twilio&rsquo;s standard toll-free response; the reply shown here is Hone&rsquo;s own and is used
        where HELP reaches Hone.
      </P>
      <H3 id="reply-stop">A person replies STOP (or STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT)</H3>
      <P>
        The confirmation a person receives after STOP is the standard reply from their carrier and Twilio; Hone does not send its own. Hone records
        the opt-out against every matching client and waitlist record at that time, across studios.
      </P>
      <P>
        After STOP, no further texts are sent to that number. Questions can also be sent to{" "}
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
        <a className="underline" href="/sms-terms">
          SMS Terms
        </a>
        {" · "}
        <a className="underline" href="/terms#appointment-text-messages">
          Terms: appointment text messages
        </a>
      </P>
    </PolicyLayout>
  );
}
