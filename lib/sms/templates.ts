import { localLongDate, localTimeString } from "@/lib/booking/tz";

// Transactional SMS bodies for the three SMS types this PR ships:
//   - confirmation (sent inline from a successful booking)
//   - reminder_24h (sent by cron 24h before starts_at)
//   - reminder_2h  (sent by cron 2h before starts_at)
//
// All bodies share the same shape:
//   {Studio}: <event>. <intake link if applicable>. <manage link if
//   applicable>. Reply STOP to opt out.
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
//   - Always ends with "Reply STOP to opt out." This is the disclosure
//     Twilio expects on any transactional SMS even though the inbound
//     webhook handles STOP server-side via Twilio's HMAC signature.

export type BookingConfirmationSmsInput = {
  studioName: string;
  startsAt: Date;
  timezone: string;
  intakeUrl: string | null;
  rescheduleUrl: string | null;
};

export type ReminderSmsInput = {
  studioName: string;
  startsAt: Date;
  timezone: string;
  rescheduleUrl: string | null;
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
// from emitting "Intake: . Manage: ..." when intakeUrl is null. The
// SMS body assembler joins parts with ". " and a trailing period.
function joinParts(parts: ReadonlyArray<string | null>): string {
  const filtered = parts.filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  // Each part already ends without a period; we append the period
  // separator. The final "Reply STOP to opt out." is added by the
  // caller so the STOP disclosure always sits last.
  return filtered.join(". ");
}

const STOP_DISCLOSURE = "Reply STOP to opt out.";

export function buildBookingConfirmationSms(
  p: BookingConfirmationSmsInput,
): string {
  const moment = appointmentMoment(p.startsAt, p.timezone);
  const head = `${p.studioName}: confirmed for ${moment}`;
  const intake = p.intakeUrl ? `Intake: ${p.intakeUrl}` : null;
  const manage = p.rescheduleUrl ? `Manage: ${p.rescheduleUrl}` : null;
  const body = joinParts([head, intake, manage]);
  return `${body}. ${STOP_DISCLOSURE}`;
}

export function build24hReminderSms(p: ReminderSmsInput): string {
  const moment = appointmentMoment(p.startsAt, p.timezone);
  const head = `Reminder from ${p.studioName}: appointment ${moment}`;
  const manage = p.rescheduleUrl ? `Manage: ${p.rescheduleUrl}` : null;
  const body = joinParts([head, manage]);
  return `${body}. ${STOP_DISCLOSURE}`;
}

export function build2hReminderSms(p: ReminderSmsInput): string {
  const moment = appointmentMoment(p.startsAt, p.timezone);
  // Same shape as 24h; the difference is purely the prefix so the
  // client immediately understands which reminder they are reading.
  const head = `Today's appointment with ${p.studioName} is at ${
    localTimeString(p.startsAt, p.timezone)
  }`;
  const manage = p.rescheduleUrl ? `Manage: ${p.rescheduleUrl}` : null;
  // moment is intentionally unused for the 2h variant; the date is
  // redundant when the appointment is today. Keeping the import live
  // for the helper above (and for the parallel 24h shape) is fine.
  void moment;
  const body = joinParts([head, manage]);
  return `${body}. ${STOP_DISCLOSURE}`;
}
