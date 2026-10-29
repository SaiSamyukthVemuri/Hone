// HON-48 — five people edit one calendar. A timed block (lunch, cleaning,
// meeting, personal) used to be edited and deleted by id alone, so the second
// of two people editing the same block silently overwrote the first (the
// update even rewrote updated_at without ever comparing it). The block row
// already carries `updated_at`, so the fix needs no schema: the edit form
// sends back the `updated_at` it was LOADED with, and the write only applies
// when the row still has exactly that value.
//
// The version is an opaque string compared for equality, never parsed into a
// Date: PostgREST returns microsecond precision and a JavaScript Date would
// round it to milliseconds, which would make every comparison fail.
//
// A request with NO version (an older form, a script) is unchanged: it keeps
// the last-write-wins behaviour it always had, so nothing that exists breaks.
// A request with a MALFORMED version is refused rather than treated as absent.

export const STALE_BLOCK_MESSAGE =
  "This block was changed by someone else. The latest version is now shown; check it and try again.";

export type ExpectedBlockVersion =
  | { kind: "absent" }
  | { kind: "present"; value: string }
  | { kind: "invalid" };

const VERSION_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

export function readExpectedBlockVersion(
  raw: FormDataEntryValue | null | undefined,
): ExpectedBlockVersion {
  if (typeof raw !== "string") return { kind: "absent" };
  const value = raw.trim();
  if (value.length === 0) return { kind: "absent" };
  return VERSION_SHAPE.test(value) ? { kind: "present", value } : { kind: "invalid" };
}
