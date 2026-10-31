// HON-48 calendar sidebar: which practitioners' calendars a viewer is LOOKING AT.
//
// VIEW-ONLY. The selection is read by the calendar page to decide which already-loaded rows to
// draw. It never reaches slot generation, conflict checks, booking permissions or any server
// action, and it never widens what a viewer may see: the candidate list is the active
// practitioners the page already loaded with its existing studio-scoped read
// (getPractitionersForStudio), the same list the Day view uses. A selection can only NARROW it.
// tests/lib/calendar/practitioner-selection.test.ts pins that it is imported by the calendar's
// display code and nowhere in lib/booking or an action.
//
// State: the URL param `people` (shareable, survives date and view changes) plus a per-viewer
// local preference (restores it when a link has no param). No database write.
//
//   absent                -> everyone (no filter at all: unassigned and former-practitioner rows
//                            still show, exactly as before the sidebar)
//   "none"                -> nobody: the empty-selection message, never silently everyone
//   "id1,id2"             -> exactly those listed practitioners that still exist
//
// Everyone-checked serialises back to "absent", so checking every box is the unfiltered view.

export const SELECTION_PARAM = "people";
export const EMPTY_SELECTION_MESSAGE = "Select a practitioner to view their calendar.";

export type SelectionMode = "all" | "some" | "none";

export type PractitionerSelection = {
  mode: SelectionMode;
  /** Listed practitioner ids that are selected (every listed id when mode is "all"). */
  ids: ReadonlySet<string>;
};

const NONE = "none";

function splitIds(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * @param raw the `people` search param (first value if repeated)
 * @param listedIds the practitioners the viewer may see, in display order
 */
export function parseSelection(
  raw: string | string[] | null | undefined,
  listedIds: ReadonlyArray<string>,
): PractitionerSelection {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const listed = new Set(listedIds);
  if (value === undefined || value === null || value.trim() === "") {
    return { mode: "all", ids: listed };
  }
  if (value.trim() === NONE) return { mode: "none", ids: new Set() };
  // Unknown ids (a removed or deactivated practitioner, or a hand-edited link) are dropped, so a
  // link can never select someone the viewer is not offered.
  const picked = splitIds(value).filter((id) => listed.has(id));
  if (picked.length === 0) return { mode: "none", ids: new Set() };
  if (picked.length >= listed.size) return { mode: "all", ids: listed };
  return { mode: "some", ids: new Set(picked) };
}

/** The param value for a set of selected ids, or undefined when it is everyone (omit the param). */
export function serializeSelection(
  selectedIds: Iterable<string>,
  listedIds: ReadonlyArray<string>,
): string | undefined {
  const listed = new Set(listedIds);
  const picked = [...new Set(selectedIds)].filter((id) => listed.has(id));
  if (picked.length === 0) return NONE;
  if (picked.length >= listed.size) return undefined;
  return listedIds.filter((id) => picked.includes(id)).join(",");
}

export function isSelected(selection: PractitionerSelection, practitionerId: string | null): boolean {
  if (selection.mode === "all") return true;
  return practitionerId !== null && selection.ids.has(practitionerId);
}

/** Display filter. Everyone selected returns the input untouched (unassigned rows included). */
export function filterBySelection<T extends { practitioner_id: string | null }>(
  rows: ReadonlyArray<T>,
  selection: PractitionerSelection,
): T[] {
  if (selection.mode === "all") return rows as T[];
  if (selection.mode === "none") return [];
  return rows.filter((r) => r.practitioner_id !== null && selection.ids.has(r.practitioner_id));
}

/** The listed practitioners that are selected, in list order. */
export function selectedPractitioners<T extends { id: string }>(
  listed: ReadonlyArray<T>,
  selection: PractitionerSelection,
): T[] {
  return listed.filter((p) => isSelected(selection, p.id));
}

/** Add the selection to a /calendar href, keeping every other param. */
export function withSelection(href: string, param: string | undefined): string {
  if (param === undefined) return href;
  const [path, query = ""] = href.split("?");
  const params = new URLSearchParams(query);
  params.set(SELECTION_PARAM, param);
  return `${path}?${params.toString()}`;
}

// ---- per-viewer local preference (no DB write) --------------------------------------------

export const SELECTION_STORAGE_PREFIX = "hone:calendar:selection:v1:";
export const SIDEBAR_STORAGE_KEY = "hone:calendar:sidebar:v1";
const ID_RE = /^[0-9a-zA-Z-]+$/;
const ALL = "all";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** A stored value is only ever "all", "none" or a comma list of id-shaped tokens; anything else is dropped. */
export function sanitizeStoredSelection(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw === ALL || raw === NONE) return raw;
  const ids = splitIds(raw);
  if (ids.length === 0 || !ids.every((id) => ID_RE.test(id))) return null;
  return ids.join(",");
}

export function readStoredSelection(storage: StorageLike | null | undefined, studioId: string): string | null {
  try {
    return sanitizeStoredSelection(storage?.getItem(SELECTION_STORAGE_PREFIX + studioId));
  } catch {
    return null;
  }
}

/** `param` is the serialised selection (undefined = everyone). */
export function writeStoredSelection(
  storage: StorageLike | null | undefined,
  studioId: string,
  param: string | undefined,
): void {
  try {
    storage?.setItem(SELECTION_STORAGE_PREFIX + studioId, param ?? ALL);
  } catch {
    // storage unavailable (private window, blocked): the URL alone carries the selection.
  }
}

/** The param to restore from a stored preference, or null when nothing should change. */
export function restoreParam(stored: string | null): string | null {
  return stored === null || stored === ALL ? null : stored;
}

// ---- mini calendar ------------------------------------------------------------------------

/** Where picking `date` in the mini calendar takes the CURRENT view. Selection is carried on top. */
export function miniCalendarHref(view: "day" | "week" | "month", date: string): string {
  if (view === "day") return `/calendar?view=day&day=${date}`;
  if (view === "month") return `/calendar?view=month&month=${date.slice(0, 7)}-01`;
  return `/calendar?view=week&day=${date}`;
}
