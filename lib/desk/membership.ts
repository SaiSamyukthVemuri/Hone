// Pure resolution of a user's active RECEPTIONIST memberships. The desk's mirror of
// resolveActivePractitionerMembership (lib/supabase/queries.ts), and deliberately separate from
// it: that function must keep meaning "a practitioner with a studio" for every app page.
//
// The selected-studio cookie is only a HINT. It is honoured when, and only when, it names a studio
// in which the user holds an ACTIVE RECEPTIONIST row (the table this guard owns). A cookie naming a
// studio the user holds only as a practitioner, or not at all, is ignored (Privacy R4).

export type ReceptionistRow = { id: string; studio_id: string; display_name: string };

export type DeskMembership =
  | { kind: "none" }
  | { kind: "choose" }
  | { kind: "one" | "selected"; value: { studioId: string; receptionistId: string; displayName: string } };

function toValue(row: ReceptionistRow) {
  return { studioId: row.studio_id, receptionistId: row.id, displayName: row.display_name };
}

export function resolveDeskMembership(
  rows: readonly ReceptionistRow[],
  selectedStudioId: string | null,
): DeskMembership {
  if (rows.length === 0) return { kind: "none" };
  if (rows.length === 1) return { kind: "one", value: toValue(rows[0]) };
  if (selectedStudioId) {
    const match = rows.find((r) => r.studio_id === selectedStudioId);
    if (match) return { kind: "selected", value: toValue(match) };
  }
  // Two or more studios and no valid selection: never auto-pick.
  return { kind: "choose" };
}
