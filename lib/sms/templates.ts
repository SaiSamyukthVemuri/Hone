import { localLongDate, localTimeString } from "@/lib/booking/tz";

// Transactional SMS bodies for the three SMS types this PR ships:
//   - confirmation (sent inline from a successful booking)
//   - reminder_24h (sent by cron 24h before starts_at)
//   - reminder_2h  (sent by cron 2h before starts_at)
//
// All bodies share the same shape:
//   {Studio}: <event>. <intake link if applicable>. <reschedule link
//   if applicable>. <cancel link if applicable>. Do not reply here
//   except STOP to opt out.
//
// Constraints honored here:
//   - Short. Each builder targets a single SMS segment whenever
//     possible (160 GSM-7 chars / 70 UCS-2 chars). The shape is
//     intentionally minimal so studio names and URLs do not push us
//     into multi-segment territory; if a long studio name does, that
//     is acceptable Twilio behaviour, not an error.
//   - Transactional only. No marketing, no upsell, no review prompt.
//   - Date / time formatting reuses lib/booking/tz.ts helpers; we do
//     NOT invent a separate SMS formatter. The email day header and
//     the SMS day phrase therefore stay in sync by construction.
//   - Labels are accurate: "Reschedule:" and "Cancel:" are listed
//     separately because each links to a dedicated single-action page
//     (/reschedule/<token> and /cancel/<token>). The previous "Manage:"
//     label was misleading because it implied both actions were behind
//     one link; the reschedule page does NOT cancel and vice versa.
//   - Always ends with "Do not reply here except STOP to opt out."
//     STOP is a real supported reply (handled server-side by the
//     inbound webhook); anything else is not conversational, not
//     parsed, and not persisted. The disclosure tells the client both
//     facts in one line.

export type BookingConfirmationSmsInput = {
  studioName: string;
  startsAt: Date;
  timezone: string;
  intakeUrl: string | null;
  rescheduleUrl: string | null;
  cancelUrl: string | null;
};

export type ReminderSmsInput = {
  studioName: string;
  startsAt: Date;
  timezone: string;
  rescheduleUrl: string | null;
  cancelUrl: string | null;
};

// Compact phrase for the appointment moment used by every template:
// "Tuesday, June 3 at 14:30". We do not include the year (it adds
// length and noise; the client booked recently).
function appointmentMoment(startsAt: Date, timezone: string): string {
  const long = localLongDate(startsAt, timezone);
  // Strip the year suffix ("Tuesday, June 3, 2026" -> "Tuesday, June 3").
  // The Intl format we use always ends with ", YYYY" so a comma split
  // is safe.
  const withoutYear = long.replace(/,\s*\d{4}$/, "");
  const time = localTimeString(startsAt, timezone);
  return `${withoutYear} at ${time}`;
}

// Append a phrase only when its value is truthy; keeps the templates
// from emitting "Intake: . Cancel:" when a URL is null. The SMS body
// assembler joins parts with ". " and a trailing period. The closing
// disclosure ("Do not reply here except STOP to opt out.") is added
// by the caller so it always sits last.
function joinParts(parts: ReadonlyArray<string | null>): string {
  const filtered = parts.filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  return filtered.join(". ");
}

// STOP is the only inbound message the system reacts to; everything
// else is ignored. The disclosure spells that out in one line so a
// client who replies "thanks" understands no one will see it.
const REPLY_DISCLOSURE = "Do not reply here except STOP to opt out.";

export function buildBookingConfirmationSms(
  p: BookingConfirmationSmsInput,
): string {
  const moment = appointmentMoment(p.startsAt, p.timezone);
  const head = `${p.studioName}: confirmed for ${moment}`;
  const intake = p.intakeUrl ? `Intake: ${p.intakeUrl}` : null;
  const reschedule = p.rescheduleUrl
    ? `Reschedule: ${p.rescheduleUrl}`
    : null;
  const cancel = p.cancelUrl ? `Cancel: ${p.cancelUrl}` : null;
  const body = joinParts([head, intake, reschedule, cancel]);
  return `${body}. ${REPLY_DISCLOSURE}`;
}

export function build24hReminderSms(p: ReminderSmsInput): string {
  const moment = appointmentMoment(p.startsAt, p.timezone);
  const head = `Reminder from ${p.studioName}: appointment ${moment}`;
  const reschedule = p.rescheduleUrl
    ? `Reschedule: ${p.rescheduleUrl}`
    : null;
  const cancel = p.cancelUrl ? `Cancel: ${p.cancelUrl}` : null;
  const body = joinParts([head, reschedule, cancel]);
  return `${body}. ${REPLY_DISCLOSURE}`;
}

export function build2hReminderSms(p: ReminderSmsInput): string {
  // For the same-day reminder, the date is redundant; only the time
  // matters. The 24h variant carries the full moment.
  const head = `Today's appointment with ${p.studioName} is at ${
    localTimeString(p.startsAt, p.timezone)
  }`;
  const reschedule = p.rescheduleUrl
    ? `Reschedule: ${p.rescheduleUrl}`
    : null;
  const cancel = p.cancelUrl ? `Cancel: ${p.cancelUrl}` : null;
  const body = joinParts([head, reschedule, cancel]);
  return `${body}. ${REPLY_DISCLOSURE}`;
}
