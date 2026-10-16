// Expected refusals when a session is started FROM an appointment.
//
// Starting a chart against an appointment is refused when the appointment is
// not this studio's, is another client's, or is assigned to a DIFFERENT
// practitioner (PR #156 lineage; re-enforced inside start_session, 0167/0181).
// Those refusals are correct and stay exactly as strict. What changes here is
// how they reach the person: they used to be THROWN from the form action, so a
// practitioner (or an owner opening a colleague's booking) saw the generic
// error boundary instead of a sentence saying what happened and what to do.
//
// One code list, one copy table: the action redirects with a code, and the
// new-session page renders the matching copy (and also pre-checks the
// appointment so the picker is never offered for a chart it would refuse).

export const SESSION_START_REFUSALS = [
  "assigned_elsewhere",
  "other_client",
  "other_studio",
  "appointment_missing",
] as const;

export type SessionStartRefusal = (typeof SESSION_START_REFUSALS)[number];

export function parseSessionStartRefusal(value: unknown): SessionStartRefusal | null {
  return typeof value === "string" &&
    (SESSION_START_REFUSALS as readonly string[]).includes(value)
    ? (value as SessionStartRefusal)
    : null;
}

/** The message the start_session command raises for an assigned-elsewhere appointment. */
export const ASSIGNED_ELSEWHERE_RAISED = "Appointment is assigned to a different practitioner.";

export function sessionStartRefusalCopy(
  code: SessionStartRefusal,
  assignedName: string | null,
  opts: { canReassign?: boolean } = {},
): { title: string; body: string } {
  switch (code) {
    case "assigned_elsewhere": {
      const who = assignedName?.trim() ? assignedName.trim() : "another practitioner";
      const base =
        `Only ${who} can start the chart for this appointment, so the treatment record stays with ` +
        "the person who performs it.";
      // Move (owner reassignment) is offered ONLY for a confirmed future
      // appointment; for a past or settled one it does not exist, so the copy
      // names the recovery that does: the assigned practitioner charts it.
      return {
        title: `This appointment is booked with ${who}`,
        body: opts.canReassign
          ? `${base} To chart it yourself, a studio owner can first reassign it to you with Move on the appointment's calendar page.`
          : `${base} Ask ${who} to open it and start the chart.`,
      };
    }
    case "other_client":
      return {
        title: "This appointment is for a different client",
        body: "Open the appointment from that client's record to start its chart.",
      };
    case "other_studio":
      return {
        title: "This appointment is not in your current studio",
        body: "Switch to the studio the appointment belongs to, then start the chart from there.",
      };
    case "appointment_missing":
      return {
        title: "That appointment could not be found",
        body: "It may have been cancelled or removed. Start a session without an appointment, or open the calendar.",
      };
  }
}

export function sessionStartRefusalHref(
  clientId: string,
  appointmentId: string,
  code: SessionStartRefusal,
): string {
  const q = new URLSearchParams({ appointment_id: appointmentId, refused: code });
  return `/clients/${encodeURIComponent(clientId)}/sessions/new?${q.toString()}`;
}
