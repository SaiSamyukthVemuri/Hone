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

/**
 * readWithPreferredName for a select whose column list is built at runtime: such
 * a string is not a literal, so supabase-js's compile-time parser cannot type the
 * result. The data comes back untyped, exactly like the existing
 * `as unknown as Row[]` reads, and the caller narrows it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readPreferredLoose<T = any>(
  attempt: (includePreferred: boolean) => PromiseLike<ReadResult & { data: unknown }>,
): Promise<{ data: T | null; error: ReadResult["error"] }> {
  const result = await readWithPreferredName(attempt);
  return result as unknown as { data: T | null; error: ReadResult["error"] };
}

// Once a probe has SEEN the column, it never disappears: later requests skip the probe.
// A missing column is never remembered, so the first request after 0258 applies sees it.
let preferredNameSeen = false;

/** Test seam: forget what a probe has seen. */
export function resetPreferredNameProbeForTests(): void {
  preferredNameSeen = false;
}

type ProbeClient = { from: (table: string) => unknown };
type ProbeTable = { select: (columns: string) => { limit: (n: number) => PromiseLike<{ error: { code?: string | null; message?: string | null } | null }> } };

/**
 * One cheap read that says whether clients.preferred_name exists yet, for a
 * surface that fans out many reads (global search) and would otherwise retry
 * each one. ONLY a missing-preferred_name error means "no": any other error
 * answers "yes", so the real reads run and fail loudly as they always did.
 */
export async function preferredNameAvailable(supabase: ProbeClient): Promise<boolean> {
  if (preferredNameSeen) return true;
  const { error } = await (supabase.from("clients") as ProbeTable).select(PREFERRED_NAME_COLUMN).limit(1);
  if (isMissingColumnError(error, PREFERRED_NAME_COLUMN)) return false;
  if (!error) preferredNameSeen = true;
  return true;
}

export const PREFERRED_NAME_UNAVAILABLE_MESSAGE =
  "Preferred names are not available yet. Remove the preferred name and save again.";

/**
 * A write that carries preferred_name. `preferred` is null when the caller did
 * not submit the field (it is then never written). When the database has no
 * preferred_name column (before 0258): an EMPTY preferred name is simply left
 * out and the write retried once, so every ordinary save keeps working; a name
 * the user actually typed is NEVER silently dropped: the first result is returned
 * with `preferredUnavailable: true` so the caller can say so. Any other error is
 * returned untouched.
 */
export async function writeWithPreferredName<T extends ReadResult>(
  preferred: { value: string | null } | null,
  attempt: (columns: { preferred_name?: string | null }) => PromiseLike<T>,
): Promise<{ result: T; preferredUnavailable: boolean }> {
  const first = await attempt(preferred ? { preferred_name: preferred.value } : {});
  if (!preferred || !isMissingColumnError(first.error, PREFERRED_NAME_COLUMN)) {
    return { result: first, preferredUnavailable: false };
  }
  if (preferred.value !== null) return { result: first, preferredUnavailable: true };
  return { result: await attempt({}), preferredUnavailable: false };
}
