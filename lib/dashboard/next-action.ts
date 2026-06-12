// Dashboard Today next-action resolver (PR #236). Pure: decides the
// ONE primary action for a Today appointment row from facts the
// dashboard already loads (status, prior charted history) plus the
// linked-session facts (does a session exist; does it have at least
// one treatment area). Existing routes only; no new write paths.
//
// Safe wording only: "Charting needed", "Charted", "No prior
// treatment history yet". Never scores, never monitors, never
// recommends treatment.

export type NextActionInput = {
  status: string; // appointment status: confirmed/completed/cancelled/no_show
  clientId: string;
  appointmentId: string;
  // Prior charted history exists for this client (Before Today).
  hasHistory: boolean;
  // Linked, non-deleted session for THIS appointment, if any.
  sessionId: string | null;
  // That session has at least one non-deleted treatment area.
  hasChartedArea: boolean;
};

export type NextAction = {
  label:
    | "Review Before Today"
    | "Open client"
    | "Chart appointment"
    | "Continue charting"
    | "View session";
  href: string;
  // Optional charting-state chip for the row.
  chip: "Charting needed" | "Charted" | null;
};

export function resolveNextAction(input: NextActionInput): NextAction {
  const clientHref = `/clients/${input.clientId}`;

  // A linked session decides first, regardless of appointment status:
  // charting is in flight or done, so point at it.
  if (input.sessionId) {
    if (input.hasChartedArea) {
      return {
        label: "View session",
        href: `${clientHref}/sessions/${input.sessionId}`,
        chip: "Charted",
      };
    }
    return {
      label: "Continue charting",
      href: `${clientHref}/sessions/${input.sessionId}`,
      chip: null,
    };
  }

  // Completed without any charting: the record is the gap.
  if (input.status === "completed") {
    return {
      label: "Chart appointment",
      href: `${clientHref}/sessions/new?appointment_id=${input.appointmentId}`,
      chip: "Charting needed",
    };
  }

  // Cancelled / no-show: nothing to chart; quiet client link.
  if (input.status === "cancelled" || input.status === "no_show") {
    return { label: "Open client", href: clientHref, chip: null };
  }

  // Upcoming: returning clients get the memory review; brand-new
  // clients get the profile.
  if (input.hasHistory) {
    return { label: "Review Before Today", href: clientHref, chip: null };
  }
  return { label: "Open client", href: clientHref, chip: null };
}
