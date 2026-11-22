// THE ONE SOURCE for the appointment-SMS program's wording that a client is shown or sent outside a template:
//   - the opt-in text beside the booking form's checkbox (and its version),
//   - the HELP / INFO auto-reply and the STOP auto-reply,
//   - the program facts the public page /sms-consent prints.
// The booking form, the inbound SMS route and /sms-consent all import from here, so the evidence page cannot drift from what the client
// actually sees and is actually sent (tests/lib/sms/appointment-sms-copy.test.ts pins the wiring).
//
// SCOPE. Appointment confirmations and reminders ONLY (the three bodies in lib/sms/templates.ts). Waitlist texts are a different
// program with their own consent text and are NOT covered by anything here.
//
// VERSIONS. The text version is recorded here, in the PR and on the evidence page; clients.* has no text-version column (a later,
// separate change). A consent given before this wording shipped was given under V1 and is NOT widened: it is provably earlier by its
// `sms_consent_at` timestamp. New wording applies only to consents given from now on.

/** The wording shown with the checkbox from the release that introduced this file. */
export const APPOINTMENT_SMS_CONSENT_VERSION = "appointment_sms_consent_v2";

/** The wording every consent given before that release was given under (kept so the evidence page can show it). */
export const APPOINTMENT_SMS_CONSENT_VERSION_V1 = "appointment_sms_consent_v1";
export const APPOINTMENT_SMS_CONSENT_V1 = {
  label: "Text me appointment confirmations and reminders.",
  helper: "You can reply STOP at any time. Email will still be used for appointment messages.",
} as const;

/** The program, named once. */
export const APPOINTMENT_SMS_PROGRAM_NAME = "Hone appointment and waitlist texts";

/** The one contact a client is pointed to for help. A real mailbox the product already names for support. */
export const APPOINTMENT_SMS_SUPPORT_EMAIL = "support@hone.care";

/** Where the client can read the policies. Same-origin paths, never form input. */
export const APPOINTMENT_SMS_PRIVACY_PATH = "/privacy#appointment-text-messages";
export const APPOINTMENT_SMS_TERMS_PATH = "/terms#appointment-text-messages";
/** The short public SMS terms page (program, frequency, rates, HELP/STOP, support). */
export const SMS_TERMS_PATH = "/sms-terms";

/** Waitlist opt-in: a notice shown BESIDE the stored v2 question (the question text itself is unchanged). */
export const WAITLIST_SMS_FREQUENCY = "usually one text when you join and one for each invitation to book";
/** Who appointment texts and waitlist texts go to, in one sentence each. The pages and policies say exactly this. */
export const APPOINTMENT_SMS_AUDIENCE =
  "Appointment texts go to clients who opted in on that studio's booking form; they then cover that client's appointments at that studio, including ones the studio books for them.";
export const WAITLIST_SMS_AUDIENCE =
  "Waitlist texts are sent only to people who agreed: either by answering Yes on the studio's waitlist form, or by telling the studio they agree, which the studio then records in Hone for that studio's waitlist only.";

export const WAITLIST_SMS_NOTICE_LINES: ReadonlyArray<string> = [
  `Texts come from Hone on behalf of the studio you are joining, about this waitlist only: ${WAITLIST_SMS_FREQUENCY}.`,
  "Msg & data rates may apply. Reply HELP for help, STOP to opt out. This applies to this studio's waitlist only.",
  "Consent isn't a condition of joining. If you say No, we email you instead and your place is the same.",
];

/** The checkbox label. `studioName` is the server-resolved studio name, never form input. */
export function appointmentSmsConsentLabel(studioName: string): string {
  const studio = studioName.trim() || "your clinic";
  return `Text me appointment confirmations and reminders from Hone on behalf of ${studio}.`;
}

/** The disclosure lines under the label, in order. */
/** Frequency, in one place: the form, the evidence page and the policies' wording all follow this. A reschedule creates a new booking with its own reminders. */
export const APPOINTMENT_SMS_FREQUENCY =
  "usually up to 3 messages per booking (a confirmation and two reminders); a rescheduled booking starts again";

export const APPOINTMENT_SMS_CONSENT_DISCLOSURE: ReadonlyArray<string> = [
  `Appointment confirmations and reminders only. Messages: ${APPOINTMENT_SMS_FREQUENCY}.`,
  "Msg & data rates may apply. Reply HELP for help, STOP to opt out.",
  "Consent isn't a condition of booking. Email will still be used for appointment messages.",
];

/** Reply to HELP and INFO. One GSM-7 segment (checked by a test). */
export const APPOINTMENT_SMS_HELP_REPLY =
  `${APPOINTMENT_SMS_PROGRAM_NAME}: sent by Hone on behalf of your studio. ` +
  `Msg & data rates may apply. Reply STOP to opt out. Help: ${APPOINTMENT_SMS_SUPPORT_EMAIL}`;
