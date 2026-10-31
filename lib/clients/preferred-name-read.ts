// HON-58 — reading `clients.preferred_name` safely before migration 0258 exists.
//
// A surface that adds `preferred_name` to a select would FAIL (Postgres 42703)
// on a database that does not have the column yet, which is exactly the window
// between deploying the app and applying 0258. This helper runs the read with
// the column and, only when the database says THAT column is missing, runs it
// once more without it, so the surface behaves exactly as it did before (it
// simply shows the stored name). Every other error is returned untouched, so a
// real failure is never swallowed and never retried: the caller keeps its own
// fail-closed handling.
//
// Pure of side effects and logs nothing.

import { isMissingColumnError } from "@/lib/db/missing-column";

export const PREFERRED_NAME_COLUMN = "preferred_name";

type ReadResult = { error: { code?: string | null; message?: string | null } | null };

/**
 * `attempt(true)` builds the read WITH preferred_name; `attempt(false)` builds
 * the pre-0258 read. The second only runs on a missing-preferred_name error.
 */
export async function readWithPreferredName<T extends ReadResult>(
  attempt: (includePreferred: boolean) => PromiseLike<T>,
): Promise<T> {
  const first = await attempt(true);
  if (isMissingColumnError(first.error, PREFERRED_NAME_COLUMN)) return attempt(false);
  return first;
}

/** The select fragment for the joined or direct client read. */
export function preferredNameColumn(includePreferred: boolean): string {
  return includePreferred ? `${PREFERRED_NAME_COLUMN}, ` : "";
}
