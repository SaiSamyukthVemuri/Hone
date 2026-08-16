import "server-only";
import { createClient } from "@/lib/supabase/server";
import { isClientBudgetLevel, type ClientBudgetLevel } from "./levels";

// CURRENT client budget context read.
//
// One row per client (UNIQUE client_id in migration 0183), so "the client's
// budget" is a single unambiguous record — there is no per-plan value to
// choose between and no "latest plan wins" rule to get wrong.
//
// User-scoped Supabase client, NOT createAdminClient: RLS
// (is_studio_member(studio_id)) is the authority, so a client belonging to
// another studio simply returns no row.

export type ClientBudgetContext = {
  budgetLevel: ClientBudgetLevel | null;
  budgetNotes: string;
  updatedAt: string | null;
};

export const EMPTY_CLIENT_BUDGET_CONTEXT: ClientBudgetContext = {
  budgetLevel: null,
  budgetNotes: "",
  updatedAt: null,
};

export async function getClientBudgetContext(
  clientId: string,
): Promise<ClientBudgetContext> {
  const supabase = await createClient();
  try {
    const { data, error } = await supabase
      .from("client_budget_context")
      .select("budget_level, budget_notes, updated_at")
      .eq("client_id", clientId)
      .maybeSingle();
    // Fail soft to the empty state. This covers BOTH "no row yet" (the
    // normal case for every client until the first save) and the
    // migration-first skew window where the new application is running
    // against a database that has not yet had 0183 applied — the
    // Consultation tab must still render, not 500. Same posture as
    // getRecentPortalAccessEvents.
    if (error || !data) return EMPTY_CLIENT_BUDGET_CONTEXT;
    const level = data.budget_level;
    return {
      // An unrecognised stored value reads as "no level recorded" rather
      // than being surfaced as a fourth chip.
      budgetLevel: isClientBudgetLevel(level) ? level : null,
      budgetNotes: typeof data.budget_notes === "string" ? data.budget_notes : "",
      updatedAt:
        typeof data.updated_at === "string" ? data.updated_at : null,
    };
  } catch {
    return EMPTY_CLIENT_BUDGET_CONTEXT;
  }
}
