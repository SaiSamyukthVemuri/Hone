// HON-12 (RECORDS-01): the overdue-disinfectant notice opens the overdue record's
// OWN edit action on the Records page (the existing Edit form and update action,
// which records the replacement / date and writes the audit history). Pure helpers
// shared by the notice (link) and the Records page (anchor + open row), so the two
// cannot drift. No server-only imports: the page and the notice both use this.

export function disinfectantRecordAnchor(recordId: string): string {
  return `disinfectant-${recordId}`;
}

// Deep link from the Notification Centre. The record id is a URL parameter for the
// signed-in studio member's own record (tenancy is enforced by RLS and the studio
// filter); it is never rendered as copy.
export function disinfectantNoticeHref(recordId: string): string {
  return `/records?section=disinfectants&record=${encodeURIComponent(recordId)}#${disinfectantRecordAnchor(recordId)}`;
}

// Only a record that is actually in the listed (studio-scoped) rows can be
// focused; anything else (unknown, other studio, stale) is ignored, not echoed.
export function resolveFocusedDisinfectantId(
  requested: string | undefined,
  listedIds: ReadonlyArray<string>,
): string | null {
  if (!requested) return null;
  return listedIds.includes(requested) ? requested : null;
}
