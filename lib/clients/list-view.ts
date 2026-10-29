// HON-14 (CLIENT-STATUS-01). Which clients the /clients list shows, as one pure
// decision so the page has no view logic of its own.
//
// TODAY there are two views: the only persisted lifecycle fact is
// clients.archived_at (see the HON-14 baseline test). Paused and Completed need a
// stored column (General lane HON14-DESIGN.md) and are deliberately NOT views
// yet: an unknown value is the active view, exactly as before, so a deep link
// never lands on an empty or unexpected list. When the schema exists the new
// views are added to CLIENT_LIST_VIEWS and nowhere else.

export type ClientListView = "active" | "archived";

export const CLIENT_LIST_VIEWS: ReadonlyArray<{
  value: ClientListView;
  label: string;
}> = [
  { value: "active", label: "Active clients" },
  { value: "archived", label: "Archived clients" },
];

export function parseClientListView(
  raw: string | string[] | undefined,
): ClientListView {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "archived" ? "archived" : "active";
}

export function clientListViewHref(view: ClientListView): string {
  return `/clients?view=${view}`;
}

export function clientListViewSummary(view: ClientListView, count: number): string {
  if (view === "active") {
    return count === 0 ? "No clients yet." : `${count} ${count === 1 ? "client" : "clients"}`;
  }
  return count === 0 ? "No archived clients." : `${count} archived`;
}
