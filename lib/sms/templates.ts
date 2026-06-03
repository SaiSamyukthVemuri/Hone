import { localLongDate, localTimeString } from "@/lib/booking/tz";

// Transactional SMS bodies for the three SMS types this codebase ships:
//   - confirmation (sent inline from a successful booking)
//   - reminder_24h (sent by cron 24h before starts_at)
//   - reminder_2h  (sent by cron 2h before starts_at)
//
// All bodies share the same shape:
//   {Studio}: <event>. <intake link if applicable>. <manage link if
//   applicable>. Do not reply here except STOP to opt out.
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
//   - One neutral "Manage appointment:" link only. Earlier copy split
//     this into separate "Reschedule:" and "Cancel:" lines, which the
//     pilot review found felt like an active invitation to cancel.
//     The manage URL resolves to /manage/<token>, a public landing
//     page that surfaces both options after reminding the client of
//     the studio's cancellation and no-show policies. SMS still
//     carries an explicit intake link when one is outstanding.
//   - Always ends with "Do not reply here except STOP to opt out."
//     STOP is a real supported reply (handled server-side by the
//     inbound webhook); anything else is not conversational, not
//     parsed, and not persisted.

export type BookingConfirmationSmsInput = {
  studioName: string;
  startsAt: Date;
  timezone: string;
  intakeUrl: string | null;
  manageUrl: string | null;
};

export type ReminderSmsInput = {
  studioName: string;
  startsAt: Date;
  timezone: string;
  manageUrl: string | null;
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
// from emitting "Intake: . Manage appointment:" when a URL is null.
// The SMS body assembler joins parts with ". " and a trailing period.
// The closing disclosure ("Do not reply here except STOP to opt
// out.") is added by the caller so it always sits last.
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
  const manage = p.manageUrl ? `Manage appointment: ${p.manageUrl}` : null;
  const body = joinParts([head, intake, manage]);
  return `${body}. ${REPLY_DISCLOSURE}`;
}

export function build24hReminderSms(p: ReminderSmsInput): string {
  const moment = appointmentMoment(p.startsAt, p.timezone);
  const head = `Reminder from ${p.studioName}: appointment ${moment}`;
  const manage = p.manageUrl ? `Manage appointment: ${p.manageUrl}` : null;
  const body = joinParts([head, manage]);
  return `${body}. ${REPLY_DISCLOSURE}`;
}

export function build2hReminderSms(p: ReminderSmsInput): string {
  // For the same-day reminder, the date is redundant; only the time
  // matters. The 24h variant carries the full moment.
  const head = `Today's appointment with ${p.studioName} is at ${
    localTimeString(p.startsAt, p.timezone)
  }`;
  const manage = p.manageUrl ? `Manage appointment: ${p.manageUrl}` : null;
  const body = joinParts([head, manage]);
  return `${body}. ${REPLY_DISCLOSURE}`;
}
