// The studio-facing TEXT of a practitioner notification, built in one pure place.
//
// Privacy rule (see tests/lib/notifications/notification-content-guard.test.ts): every row of the practitioner notification table is readable by every
// studio member, so a notification may carry ONLY a client's display name, a service name, a time, a staff display name and, for owner-only card
// events, a brand and last four. This module takes exactly those fields as parameters and nothing else: no row, no client record, no free text
// from a visitor. A caller that wants new content must change this signature in review, which a textual scan of call sites could never force.
//
// Pure on purpose (no server-only, no database, no clock): behaviour is pinned by tests/lib/notifications/notification-text.test.ts, which
// asserts the property directly, instead of a source tripwire that can only match spellings. Card events keep their own builder in
// lib/billing/card-change-notification.ts (buildCardChangeNotification), the same shape.

export type NotificationText = { title: string; body: string };

/** A client's own booking (public page or portal rebook). Day and time arrive already formatted in the STUDIO's timezone. */
export function buildBookedText(input: { clientName: string; serviceName: string; dayLabel: string; timeLabel: string }): NotificationText {
  return {
    title: "New booking",
    body: `${input.clientName} booked ${input.serviceName} for ${input.dayLabel} at ${input.timeLabel}.`,
  };
}

/** A client rescheduled through their link. Both labels arrive already formatted in the studio's timezone. */
export function buildRescheduledText(input: { clientName: string; fromLabel: string; toLabel: string }): NotificationText {
  return {
    title: "Appointment rescheduled",
    body: `${input.clientName} rescheduled from ${input.fromLabel} to ${input.toLabel}.`,
  };
}

/** An intake submission. Names the client only; never an answer. A missing name keeps the generic wording. */
export function buildIntakeSubmittedText(input: { clientName: string | null }): NotificationText {
  const name = input.clientName?.trim();
  return {
    title: "Intake submitted",
    body: name ? `${name} submitted an intake form.` : "A client submitted an intake form.",
  };
}

/**
 * A cancellation. `staffName` is set when a practitioner cancelled in the app (a null or empty name reads "A team member"); `null` means the client
 * cancelled through their link. `when` is omitted when the time or timezone is unknown. A staff cancel names the staff member, the client and the
 * service; a client's own cancel names the client.
 */
export function buildCancelledText(input: {
  staffName: string | null | undefined;
  byStaff: boolean;
  clientName: string | null;
  serviceName: string;
  when: { dayLabel: string; timeLabel: string } | null;
  reasonLabel: string | null;
}): NotificationText {
  const when = input.when ? ` on ${input.when.dayLabel} at ${input.when.timeLabel}` : "";
  const reason = input.reasonLabel ? ` Reason: ${input.reasonLabel}.` : "";
  const body = input.byStaff
    ? `${input.staffName || "A team member"} cancelled ${input.clientName ? `${input.clientName}'s ` : "a client's "}${input.serviceName}${when}.${reason}`
    : `${input.clientName ?? "A client"} cancelled ${input.serviceName}${when}.${reason}`;
  return { title: "Appointment cancelled", body };
}
