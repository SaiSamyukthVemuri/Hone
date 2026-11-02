// "Check the practitioner" (Sam 1 Nov): the OPEN appointments (confirmed: future, or started and
// unfinished) whose assignee MAY be wrong, for the OWNER to review. Pure classification; it never
// changes an assignment. An assignment changes only when the owner explicitly confirms a correction.
//   a  no practitioner;
//   b  assigned to an active OWNER in a studio with more than one active practitioner;
//   c  assigned to the practitioner who BOOKED it while a linked session was performed by someone else.
// The performing practitioner of a linked session is shown as a SUGGESTION, never applied.

export type CheckReason = "no_practitioner" | "owner_default" | "booker_session_differs";

export type OpenAppointment = {
  id: string;
  startsAt: string;
  practitionerId: string | null;
  createdByPractitionerId: string | null;
  /** performed_by_practitioner_id of every linked (non-deleted) session */
  performedBy: string[];
  /**
   * Number of linked, non-deleted sessions. A session is the RECORD that treatment began; a past appointment date alone is
   * not (Sam, 2 Nov: old appointments were wrongly described as "already started"). Absent means none.
   */
  linkedSessionCount?: number;
  /** Earliest recorded started_at among the linked, non-deleted sessions. */
  treatmentStartedAt?: string | null;
};

export type PractitionerLite = {
  id: string;
  role: string;
  active: boolean;
  /** display_name as stored; may be blank or the generic placeholder */
  displayName: string;
  email?: string | null;
};

/**
 *  upcoming            the date is ahead and NO treatment is recorded: the owner can change the practitioner here;
 *  date_passed         the date has passed and NO treatment is recorded: shown for review only;
 *  treatment_recorded  a session records the treatment, whatever the date: shown for review only.
 */
export type AssignmentPhase = "upcoming" | "date_passed" | "treatment_recorded";

export type CheckItem = {
  id: string;
  startsAt: string;
  isFuture: boolean;
  phase: AssignmentPhase;
  treatmentStartedAt: string | null;
  reasons: CheckReason[];
  currentPractitionerId: string | null;
  createdByPractitionerId: string | null;
  /** distinct, sorted performing practitioners of the linked (non-deleted) sessions */
  performedBy: string[];
  suggestionPractitionerId: string | null;
};

export function classifyForCheck(
  rows: OpenAppointment[],
  practitioners: PractitionerLite[],
  now: Date,
): CheckItem[] {
  const active = practitioners.filter((p) => p.active);
  const activeOwnerIds = new Set(active.filter((p) => p.role === "owner").map((p) => p.id));
  const multi = active.length > 1;
  const items: CheckItem[] = [];
  for (const r of rows) {
    const reasons: CheckReason[] = [];
    if (r.practitionerId === null) reasons.push("no_practitioner");
    if (r.practitionerId !== null && multi && activeOwnerIds.has(r.practitionerId)) reasons.push("owner_default");
    const other = r.performedBy.find((id) => id !== r.practitionerId) ?? null;
    if (r.practitionerId !== null && r.createdByPractitionerId === r.practitionerId && other !== null) {
      reasons.push("booker_session_differs");
    }
    if (reasons.length === 0) continue;
    const suggestion = other && active.some((p) => p.id === other) ? other : null;
    const isFuture = new Date(r.startsAt).getTime() > now.getTime();
    // A linked live session is the RECORD that treatment began, whatever the appointment date says (an early start, a mis-dated
    // or rebooked row). It decides the phase first, so a row with a chart is never offered for reassignment.
    const phase: AssignmentPhase = (r.linkedSessionCount ?? 0) > 0 ? "treatment_recorded" : isFuture ? "upcoming" : "date_passed";
    items.push({
      id: r.id,
      startsAt: r.startsAt,
      isFuture,
      phase,
      treatmentStartedAt: r.treatmentStartedAt ?? null,
      reasons,
      currentPractitionerId: r.practitionerId,
      createdByPractitionerId: r.createdByPractitionerId,
      performedBy: [...new Set(r.performedBy)].sort(),
      suggestionPractitionerId: suggestion,
    });
  }
  return items.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

export const CHECK_REASON_TEXT: Record<CheckReason, string> = {
  no_practitioner: "No practitioner is recorded.",
  owner_default: "Assigned to the owner; your studio has other practitioners.",
  booker_session_differs: "Assigned to whoever booked it, but the chart was written by someone else.",
};

// ---- names ------------------------------------------------------------------------------------------------------------------

const GENERIC_NAMES = new Set(["", "practitioner", "unknown"]);

/** A practitioner's display name where there is one; the email stands in only when there is no real name. */
export function practitionerLabel(p: { displayName?: string | null; email?: string | null }): { name: string; email: string | null } {
  const name = (p.displayName ?? "").trim();
  const email = (p.email ?? "").trim() || null;
  if (!GENERIC_NAMES.has(name.toLowerCase())) return { name, email };
  return { name: email ?? "Practitioner", email: null };
}

export const PHASE_TEXT: Record<AssignmentPhase, { heading: string; explain: string }> = {
  upcoming: {
    heading: "Can be reassigned now",
    explain: "These have not started. You can change the practitioner here.",
  },
  date_passed: {
    heading: "Date has passed, no treatment recorded",
    explain:
      "The appointment date is in the past and no treatment is recorded for it. Its practitioner is not changed here. Open the appointment to complete it or mark it a no-show.",
  },
  treatment_recorded: {
    heading: "Treatment recorded",
    explain:
      "A treatment record exists for these, whatever the appointment date. Their practitioner is not changed here, so the chart and the appointment cannot disagree. Open the appointment to complete it.",
  },
};
