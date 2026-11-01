// CLIENTS DIRECTORY: who sees what, as ONE pure function of (role, row fields).
//
// ONE DEFINITION FOR THE MATCHABLE AND THE RENDERED SET (Privacy S1). The fields a
// row DISPLAYS to a viewer are exactly the fields a search may match, a sort may
// order by and a count may include. `projectStaffRow` below returns them, and
// nothing else in the directory reads a name, email or phone from the source row.
// A result a viewer cannot explain from what the row shows would be an oracle.
//
// WHAT A VIEWER SEES AND SEARCHES (first release, OPS ruling):
//   display identity  the preferred name, else the stored name. The stored name is
//                     NOT matched, sorted on or counted when a preferred name is
//                     displayed, for any role.
//   contact           the email and phone the row shows.
//   pronouns          owners and practitioners only (shown, never searched). The
//                     receptionist list is contact, booking and form status (R-1).
// Legal identity is never read, projected, searched or sorted here.
//
// ROLES (Privacy S7, R1). The rules are a pure function of the role. An unknown or
// missing role gets the receptionist (most restrictive) rules. The receptionist
// projection is specified and tested here but has NO caller outside tests: the app
// has no receptionist surface, and the source-contract test refuses any caller, so
// it cannot become a live path by accident. The page uses `projectStaffRow` only,
// after its own owner/practitioner check.
//
// Pure. No I/O, no logging, nothing imported from the identity modules.

export type DirectoryRole = "owner" | "practitioner" | "receptionist";

/** The columns the directory selects. An explicit list: never `*`, no address. */
export type DirectorySourceClient = {
  id: string;
  name: string;
  preferred_name?: string | null;
  pronouns: string | null;
  email: string | null;
  phone: string | null;
  archived_at: string | null;
};

/** What a viewer's row shows. `searchable` is derived from it, never from the source. */
export type DirectoryIdentityRow = {
  id: string;
  displayName: string;
  /** True when the shown name is the stored name with no preferred name (labelled "Name on file"). */
  nameOnFile: boolean;
  pronouns: string | null;
  email: string | null;
  phone: string | null;
  archivedAt: string | null;
};

export const NAME_ON_FILE_LABEL = "Name on file";

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** The default-deny role gate: anything that is not exactly a known role is the receptionist. */
export function normalizeDirectoryRole(role: unknown): DirectoryRole {
  return role === "owner" || role === "practitioner" ? role : "receptionist";
}

export function isStaffRole(role: unknown): role is "owner" | "practitioner" {
  return role === "owner" || role === "practitioner";
}

function project(c: DirectorySourceClient): DirectoryIdentityRow {
  const preferred = clean(c.preferred_name);
  const stored = clean(c.name);
  return {
    id: c.id,
    displayName: preferred || stored,
    nameOnFile: preferred.length === 0,
    pronouns: c.pronouns,
    email: c.email,
    phone: c.phone,
    archivedAt: c.archived_at,
  };
}

/** The owner and practitioner rows (the only projection a page may call). */
export function projectStaffRow(c: DirectorySourceClient): DirectoryIdentityRow {
  return project(c);
}

/**
 * The receptionist rows: the same display identity ("Name on file" when no
 * preferred name), the permitted contact, and nothing else: no pronouns (Privacy R-1,
 * OPS ruling). Specified and tested; deliberately unwired, and it must stay unwired from
 * this module (R-2): the receptionist reads through the held desk RPC (0274), not rows
 * the app selects from clients.
 */
export function projectReceptionistRow(c: DirectorySourceClient): DirectoryIdentityRow {
  const row = project(c);
  return { ...row, pronouns: null };
}

/** Role in, rows out; unknown role = receptionist rules. Tested; unwired. */
export function projectRowForRole(role: unknown, c: DirectorySourceClient): DirectoryIdentityRow {
  return normalizeDirectoryRole(role) === "receptionist" ? projectReceptionistRow(c) : projectStaffRow(c);
}
