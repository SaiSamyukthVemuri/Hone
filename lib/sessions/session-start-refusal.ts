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
  "appointment_missing",
  // The PAGE's own lookup failed (transient DB/schema-cache error). Distinct
  // from "missing": a real appointment must never be offered an UNLINKED
  // session just because its check could not run.
  "check_failed",
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
  opts: { assigneeInactive?: boolean } = {},
): { title: string; body: string } {
  switch (code) {
    case "assigned_elsewhere": {
      const who = assignedName?.trim() ? assignedName.trim() : "another practitioner";
      if (opts.assigneeInactive) {
        // Team removal keeps a deactivated practitioner's appointments, but they
        // can no longer sign in, so "ask them" is not a recovery. Starting a
        // session WITHOUT linking this booking always is (the page links it).
        return {
          title: `This appointment is booked with ${who}, who no longer has access`,
          body:
            `${who} can no longer start this chart, and the booking cannot be linked to another ` +
            "practitioner's chart. You can start a session for this client without linking this appointment.",
        };
      }
      // DELIBERATELY no promise of reassignment. Whether Move can reassign this
      // booking to this person depends on the appointment's status and time, the
      // studio's capacity and booking flags, and service eligibility - all owned
      // by the calendar's Move flow. Restating that predicate here drifted three
      // times in review, so this page names only the recovery that ALWAYS exists
      // (the assigned practitioner charts it) and links to the appointment, where
      // Move shows itself when, and only when, it can actually be used.
      return {
        title: `This appointment is booked with ${who}`,
        body:
          `Only ${who} can start the chart for this appointment, so the treatment record stays with ` +
          `the person who performs it. Ask ${who} to open it and start the chart.`,
      };
    }
    case "other_client":
      return {
        title: "This appointment is for a different client",
        body: "Open the appointment from that client's record to start its chart.",
      };
    case "check_failed":
      return {
        title: "This appointment could not be checked just now",
        body: "Reload the page to try again. Nothing has been started or changed.",
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

type AssigneeEmbed = { display_name?: string | null; active?: boolean | null };

/** What the appointment lookup returns, as far as the decision needs it. */
export type StartAppointmentLookup = {
  studio_id: string;
  client_id: string;
  practitioner_id: string | null;
  practitioner?: AssigneeEmbed | AssigneeEmbed[] | null;
};

/**
 * The ONE decision, shared by the action and the page, so they cannot disagree. A missing appointment, one that is not visible to this person, and one in
 * ANOTHER studio are the SAME answer ("appointment_missing"): the code, the copy and the page are identical, so the response cannot tell a person whether
 * an appointment id exists in a studio they are not working in. Only an appointment in THIS studio may say more: it is another client's, or it is assigned
 * to a colleague (and then, and only then, the colleague's name is shown).
 */
export function classifyAppointmentForStart(
  appt: StartAppointmentLookup | null,
  ctx: { studioId: string; clientId: string; practitionerId: string },
): { refusal: SessionStartRefusal | null; assignedName: string | null; assigneeInactive: boolean } {
  if (!appt || appt.studio_id !== ctx.studioId) return { refusal: "appointment_missing", assignedName: null, assigneeInactive: false };
  if (appt.client_id !== ctx.clientId) return { refusal: "other_client", assignedName: null, assigneeInactive: false };
  if (appt.practitioner_id && appt.practitioner_id !== ctx.practitionerId) {
    const joined = appt.practitioner;
    const assignee = Array.isArray(joined) ? joined[0] : joined;
    return { refusal: "assigned_elsewhere", assignedName: assignee?.display_name ?? null, assigneeInactive: assignee?.active === false };
  }
  return { refusal: null, assignedName: null, assigneeInactive: false };
}
