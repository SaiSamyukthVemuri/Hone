// STUDIO-READY-02d (#824): the receptionist's studio membership, resolved.
//
// A receptionist is a `studio_receptionists` row (migration 0216), never a
// `practitioners` row, so every existing guard already refuses one. This pure
// resolver is the receptionist's own equivalent of the practitioner
// resolution in lib/supabase/queries.ts, with the same three outcomes and the
// same selected-studio rule: the hone_selected_studio cookie is honoured ONLY
// when it names one of the caller's own active memberships, and is never
// trusted on its own.

export type ReceptionistMembershipRow = {
  id: string;
  studio_id: string;
  display_name: string;
};

export type ReceptionistMembership =
  | { kind: "none" }
  | { kind: "choose"; studioIds: string[] }
  | { kind: "one"; value: ReceptionistMembershipRow };

export function resolveReceptionistMembership(
  rows: readonly ReceptionistMembershipRow[],
  selectedStudioId: string | null,
): ReceptionistMembership {
  if (rows.length === 0) return { kind: "none" };
  if (rows.length === 1) return { kind: "one", value: rows[0] };
  const selected =
    selectedStudioId == null ? undefined : rows.find((r) => r.studio_id === selectedStudioId);
  if (selected) return { kind: "one", value: selected };
  return { kind: "choose", studioIds: rows.map((r) => r.studio_id) };
}

/** The only routes a receptionist-only user may reach. */
export const FRONT_DESK_PATH = "/front-desk";

export function isFrontDeskPath(pathname: string): boolean {
  return pathname === FRONT_DESK_PATH || pathname.startsWith(`${FRONT_DESK_PATH}/`);
}
