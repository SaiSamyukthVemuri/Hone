// ONE shape for every loader that reads data behind a permission (Roles clinical-read gating, Part B).
//
//   ok          the viewer holds the key and the read succeeded; `value` may legitimately be empty
//   restricted  the viewer does NOT hold the key; NOTHING was read. A surface renders RestrictedNote and nothing derived from the record:
//               no count, no name, no date, no list, no "none", "Not completed", "up to date" or any other all-clear
//   unavailable the viewer holds the key but the read failed; a surface says it could not be read, never an empty state
//
// A loader that did not read returns `restricted`, never an empty `ok`: "not read" is not "none".
export type Gated<T> = { kind: "ok"; value: T } | { kind: "restricted" } | { kind: "unavailable" };

export const gatedOk = <T,>(value: T): Gated<T> => ({ kind: "ok", value });
export const GATED_RESTRICTED: Gated<never> = { kind: "restricted" };
export const GATED_UNAVAILABLE: Gated<never> = { kind: "unavailable" };

/** The one wording for a restricted surface. Call sites import it (or the RestrictedNote component); none invents its own. */
export const RESTRICTED_COPY = "Not available to your role.";

/** Narrowing helper: the value when ok, else null. A caller that needs to tell restricted from unavailable matches on `kind` instead. */
export const gatedValue = <T,>(g: Gated<T>): T | null => (g.kind === "ok" ? g.value : null);
