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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only a well-formed id is ever sent to the database for the notice's record.
export function isRecordUuid(value: string): boolean {
  return UUID.test(value);
}

// The notice's record may be older than the listed (newest 200) rows. The page
// fetches that ONE record (studio-scoped, RLS client) and places it first; a null
// fetch (unknown id, another studio's id, failed read), a different id, a missing
// request or an already-listed record leaves the listed rows exactly as they were.
// The requested id is compared only; it is never rendered.
export function placeFocusedRecord<T extends { id: string }>(
  listed: ReadonlyArray<T>,
  requested: string | undefined,
  fetched: T | null,
): ReadonlyArray<T> {
  if (!requested || !fetched || fetched.id !== requested) return listed;
  if (listed.some((r) => r.id === fetched.id)) return listed;
  return [fetched, ...listed];
}
