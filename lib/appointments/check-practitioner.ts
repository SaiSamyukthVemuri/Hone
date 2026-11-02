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
  /** performed_by_practitioner_id of every linked session */
  performedBy: string[];
};

export type PractitionerLite = { id: string; role: string; active: boolean; displayName: string };

export type CheckItem = {
  id: string;
  startsAt: string;
  isFuture: boolean;
  reasons: CheckReason[];
  currentPractitionerId: string | null;
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
    items.push({
      id: r.id,
      startsAt: r.startsAt,
      isFuture: new Date(r.startsAt).getTime() > now.getTime(),
      reasons,
      currentPractitionerId: r.practitionerId,
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
