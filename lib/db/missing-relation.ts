// Explicit "this specific table does not exist yet" detector, the table-level
// sibling of isMissingColumnError. Used so a read of a table that a not-yet-applied
// migration creates (HON-58: client_legal_identities, before 0258) degrades to
// "nothing there" instead of failing the whole surface, while any other database
// error is NEVER swallowed. Column-agnostic, table-scoped: the message must name
// the table.
//
//   - Postgres: 42P01 (undefined_table), message names the relation.
//   - PostgREST: PGRST205 ("Could not find the table ... in the schema cache").
export function isMissingRelationError(
  error: { code?: string | null; message?: string | null } | null | undefined,
  table: string,
): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  const msg = String(error.message ?? "").toLowerCase();
  if (!msg.includes(table.toLowerCase())) return false;
  return code === "42P01" || code === "PGRST205" || msg.includes("does not exist") || msg.includes("could not find the table");
}
