// Explicit "this specific column does not exist yet" detector for migration-order
// safety. Used to fall back to a legacy select/write ONLY when the named column
// is genuinely absent (i.e. the app is running before its migration applied) — it
// is column-scoped, so unrelated database errors are NEVER swallowed.
//
// Covers both surfaces:
//   - SELECT of a missing column -> Postgres "42703" (undefined_column).
//   - INSERT/UPDATE of a missing column -> PostgREST "PGRST204" (schema-cache miss).
// In both cases the error message names the column, which we require, so this
// never matches a different column's error.
export function isMissingColumnError(
  error: { code?: string | null; message?: string | null } | null | undefined,
  column: string,
): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  const msg = String(error.message ?? "").toLowerCase();
  const col = column.toLowerCase();
  if (!msg.includes(col)) return false; // must be about THIS column
  return (
    code === "42703" ||
    code === "PGRST204" ||
    msg.includes("does not exist") ||
    msg.includes("could not find") ||
    msg.includes("schema cache")
  );
}
