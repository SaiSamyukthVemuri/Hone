// Who may mark an appointment COMPLETED (Sam, decision 3, 1 Nov): an owner may complete any
// appointment in their studio; a practitioner only an appointment ASSIGNED to them. Completion
// never implies payment, so nothing here reads or grants anything financial. Any other role
// (a receptionist is not a practitioner row at all) has no path.
//
// An UNASSIGNED appointment (practitioner_id null) is owner-only: "assigned to them" cannot be
// true of a row assigned to nobody.
export function canCompleteAppointment(
  actor: { id: string; role: string | null | undefined },
  assignedPractitionerId: string | null | undefined,
): boolean {
  if (actor.role === "owner") return true;
  if (actor.role !== "practitioner") return false;
  return typeof assignedPractitionerId === "string" && assignedPractitionerId === actor.id;
}
