// MIGRATION-SKEW ERROR CLASSIFIER.
//
// Migration-first rollout means the new application can briefly run against a
// database that has not yet had the newest migration applied, and a rollback
// can briefly leave the reverse. During that window a read of the not-yet /
// no-longer existing table must be survivable rather than fatal.
//
// The DANGER is over-tolerance. "Any error means the table isn't there yet"
// silently converts permission denials, RLS refusals, network failures and
// pagination refusals into "there is no data" — which reads as an empty
// record to a UI (and can then be overwritten with blanks) or as a complete
// export that is quietly missing a file. This helper exists so exactly one
// narrowly-proven condition is tolerated and everything else stays fatal.
//
// The two forms below were reproduced against this repository's own local
// Supabase stack rather than assumed:
//
//   PGRST205  the table is not in PostgREST's schema cache at all — the
//             forward-skew case (new app, database without the migration):
//             "Could not find the table 'public.client_budget_context' in the
//              schema cache"
//
//   42P01     undefined_table from Postgres itself — the stale-cache case,
//             which is what a rollback looks like between the DROP and the
//             schema reload:
//             relation "public.client_budget_context" does not exist
//
// Both name the relation, which is what makes this narrow: a missing OTHER
// table is not tolerated, so a broken join or a genuinely broken deployment
// still fails loudly.
//
// Deliberately NOT matched (each reproduced or reasoned about explicitly):
//   42501     permission denied for table ...
//   PGRST301  JWT / auth failures
//   57014     statement timeout
//   PGRST103  range-not-satisfiable and other request errors
//   any error with no code at all (network / fetch failure / thrown Error)
//   the export paginator's own "exceeded N pages; refusing to return a
//   partial table" refusal, which carries no PostgREST code

const MISSING_RELATION_CODES = new Set(["PGRST205", "42P01"]);

type MaybePostgrestError = {
  code?: unknown;
  message?: unknown;
};

// `public.<relation>` not followed by another identifier character, so a
// missing `client_budget_context_archive` never reads as a missing
// `client_budget_context`.
function namesRelation(message: string, relation: string): boolean {
  const escaped = relation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\bpublic\\.${escaped}(?![A-Za-z0-9_])`).test(message);
}

/**
 * True ONLY for the proven "this specific relation does not exist" condition.
 *
 * Every caller must pass the relation it actually queried. A `true` here means
 * "the migration that creates this table has not been applied (or has been
 * rolled back)" and nothing else.
 */
export function isMissingRelationError(
  error: unknown,
  relation: string,
): boolean {
  if (error === null || typeof error !== "object") return false;
  const { code, message } = error as MaybePostgrestError;
  if (typeof code !== "string" || !MISSING_RELATION_CODES.has(code)) {
    return false;
  }
  if (typeof message !== "string" || message.length === 0) return false;
  return namesRelation(message, relation);
}
