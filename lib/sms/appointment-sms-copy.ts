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
export const APPOINTMENT_SMS_PROGRAM_NAME = "Hone appointment texts";

/** The one contact a client is pointed to for help. A real mailbox the product already names for support. */
export const APPOINTMENT_SMS_SUPPORT_EMAIL = "support@hone.care";

/** Where the client can read the policies. Same-origin paths, never form input. */
export const APPOINTMENT_SMS_PRIVACY_PATH = "/privacy#appointment-text-messages";
export const APPOINTMENT_SMS_TERMS_PATH = "/terms#appointment-text-messages";

/** The checkbox label. `studioName` is the server-resolved studio name, never form input. */
export function appointmentSmsConsentLabel(studioName: string): string {
  const studio = studioName.trim() || "your clinic";
  return `Text me appointment confirmations and reminders from Hone on behalf of ${studio}.`;
}

/** The disclosure lines under the label, in order. */
export const APPOINTMENT_SMS_CONSENT_DISCLOSURE: ReadonlyArray<string> = [
  "Appointment confirmations and reminders only. Usually up to 3 messages per appointment, plus a confirmation if it's rescheduled.",
  "Msg & data rates may apply. Reply HELP for help, STOP to opt out.",
  "Consent isn't a condition of booking. Email will still be used for appointment messages.",
];

/** Reply to HELP and INFO. One GSM-7 segment (checked by a test). */
export const APPOINTMENT_SMS_HELP_REPLY =
  `${APPOINTMENT_SMS_PROGRAM_NAME}: confirmations and reminders for your booking. ` +
  `Msg & data rates may apply. Reply STOP to opt out. Help: ${APPOINTMENT_SMS_SUPPORT_EMAIL}`;

/** Reply to STOP (the existing text, moved here unchanged). */
export const APPOINTMENT_SMS_STOP_REPLY =
  `You have been opted out of ${APPOINTMENT_SMS_PROGRAM_NAME}. Email reminders may still be sent.`;
