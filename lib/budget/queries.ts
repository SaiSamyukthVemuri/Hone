import "server-only";
import { createClient } from "@/lib/supabase/server";
import { isMissingRelationError } from "@/lib/supabase/missing-relation";
import {
  CLIENT_BUDGET_CONTEXT_RELATION,
  isClientBudgetLevel,
  type ClientBudgetLevel,
} from "./levels";

// CURRENT client budget context read.
//
// One row per client (client_id is the PRIMARY KEY in migration 0183), so
// "the client's budget" is a single unambiguous record — there is no per-plan
// value to choose between and no "latest plan wins" rule to get wrong.
//
// User-scoped Supabase client, NOT createAdminClient: RLS
// (is_studio_member(studio_id)) is the authority, so a client belonging to
// another studio simply returns no row.
//
// THREE STATES, NOT TWO. An earlier version of this module collapsed every
// failure into the empty state, which was a data-loss defect rather than a
// resilience feature: an existing row plus one transient error rendered blank
// editable controls, and the next Save overwrote real notes with ''/NULL.
// "Could not read" and "there is nothing to read" are different facts and the
// UI must be able to tell them apart.

export type ClientBudgetContextState =
  // The table exists, the query succeeded, and a row was found.
  | { status: "available"; budgetLevel: ClientBudgetLevel | null; budgetNotes: string; updatedAt: string | null }
  // The table exists, the query succeeded, and this client has no row yet.
  // The normal state for every client until their first save.
  | { status: "empty" }
  // Migration-first skew ONLY: 0183 has not been applied (or was rolled
  // back). The feature is not installed; the rest of the page is unaffected.
  | { status: "not_installed" }
  // Anything else: permission, RLS, network, timeout, malformed response.
  // The truth is unknown, so the UI must NOT offer a blank editable form.
  | { status: "unavailable" };

export async function getClientBudgetContext(
  clientId: string,
): Promise<ClientBudgetContextState> {
  let supabase;
  try {
    supabase = await createClient();
  } catch {
    return { status: "unavailable" };
  }

  let data: Record<string, unknown> | null;
  let error: unknown;
  try {
    const res = await supabase
      .from(CLIENT_BUDGET_CONTEXT_RELATION)
      .select("budget_level, budget_notes, updated_at")
      .eq("client_id", clientId)
      .maybeSingle();
    data = res.data as Record<string, unknown> | null;
    error = res.error;
  } catch {
    // A thrown error (network / fetch failure) carries no PostgREST code and
    // is never the skew condition.
    return { status: "unavailable" };
  }

  if (error) {
    return isMissingRelationError(error, CLIENT_BUDGET_CONTEXT_RELATION)
      ? { status: "not_installed" }
      : { status: "unavailable" };
  }

  // Succeeded with no row: genuinely absent, which is editable.
  if (!data) return { status: "empty" };

  const level = data.budget_level;
  return {
    status: "available",
    // An unrecognised stored value reads as "no level recorded" rather than
    // being surfaced as a fourth chip.
    budgetLevel: isClientBudgetLevel(level) ? level : null,
    budgetNotes:
      typeof data.budget_notes === "string" ? data.budget_notes : "",
    updatedAt: typeof data.updated_at === "string" ? data.updated_at : null,
  };
}
