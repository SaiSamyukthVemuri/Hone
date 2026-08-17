"use server";

// Practitioner-only CURRENT budget context for a client. One row per client
// in public.client_budget_context (migration 0183), created lazily on first
// save via an upsert keyed on client_id.
//
// WHY CLIENT-LEVEL, NOT PLAN-LEVEL: budget notes previously lived on
// treatment_plans.budget_notes, so a client with three plans had three
// budget answers and no rule saying which one was current. This action is
// the SINGLE writer of the client's current budget context; the treatment
// plan writer no longer touches budget at all.
//
// Authorization contract (this file is the only authenticated write surface
// for budget context):
//   * Runs server-side under the user-scoped Supabase client (RLS-enforced).
//     No createAdminClient.
//   * The browser supplies only the client pointer and the form values. The
//     acting practitioner and studio are derived from the session via
//     getCurrentPractitionerWithStudio(); neither is read from the form.
//   * The client is re-proven to belong to the session's studio before the
//     write, so a forged cross-studio client id is refused. The row's
//     studio_id is ALSO derived by the BEFORE INSERT/UPDATE trigger from the
//     parent clients row, so a tampered form cannot attach budget context to
//     a foreign studio even if this check were bypassed.
//   * budget_level is validated against the canonical vocabulary rather than
//     coerced, so a tampered value is rejected instead of reaching the CHECK
//     constraint.
//
// Privacy contract: this action does NOT send email or SMS, NOT touch
// intake, bookings, appointments, Stripe/payments, pricing or the client
// portal. It writes two columns plus updated_by_practitioner_id. Nothing
// under app/book, app/portal, lib/email, lib/sms, app/intake, app/cancel,
// app/reschedule, app/api/cron or app/api/stripe imports it.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  MAX_BUDGET_NOTE_LENGTH,
  parseClientBudgetLevel,
} from "@/lib/budget/levels";

export type BudgetContextActionResult =
  | { ok: true }
  | { ok: false; error: string };

function readText(value: FormDataEntryValue | null): string {
  // Do NOT trim: practitioners may structure notes with leading whitespace.
  // The length cap is the safeguard against runaway input. Same rule as
  // updateClientPersonalNotesAction.
  return typeof value === "string" ? value : "";
}

export async function updateClientBudgetContextAction(
  formData: FormData,
): Promise<BudgetContextActionResult> {
  const clientIdRaw = formData.get("client_id");
  const clientId = typeof clientIdRaw === "string" ? clientIdRaw.trim() : "";
  if (!clientId) return { ok: false, error: "Missing client id." };

  const budgetNotes = readText(formData.get("budget_notes"));
  if (budgetNotes.length > MAX_BUDGET_NOTE_LENGTH) {
    return {
      ok: false,
      error: `Budget notes must be ${MAX_BUDGET_NOTE_LENGTH} characters or fewer.`,
    };
  }

  // An absent/empty field clears the level to NULL ("no broad level
  // recorded"). A NON-EMPTY value that is not one of the three canonical
  // levels is a tampered form and is refused outright — it must never be
  // silently downgraded to NULL, because that would look like a successful
  // save while storing something the practitioner did not choose.
  const levelRaw = formData.get("budget_level");
  const levelProvided =
    typeof levelRaw === "string" && levelRaw.trim().length > 0;
  const budgetLevel = parseClientBudgetLevel(levelRaw);
  if (levelProvided && budgetLevel == null) {
    return { ok: false, error: "Unrecognised budget level." };
  }

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  const supabase = await createClient();

  // Re-prove client ownership against the SESSION's studio. RLS would refuse
  // the write anyway, but this turns an opaque RLS failure into a clean
  // error and is the explicit guard against a forged cross-studio client id.
  const { data: client, error: clientErr } = await supabase
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (clientErr) return { ok: false, error: clientErr.message };
  if (!client) return { ok: false, error: "Client not found." };

  // Upsert keyed on the unique(client_id) constraint from migration 0183.
  // studio_id is passed for documentation; the BEFORE trigger overwrites it
  // from the parent client row so callers cannot drift it.
  const { error } = await supabase.from("client_budget_context").upsert(
    {
      client_id: clientId,
      studio_id: studio.id,
      budget_level: budgetLevel,
      budget_notes: budgetNotes,
      updated_by_practitioner_id: practitioner.id,
    },
    { onConflict: "client_id" },
  );
  if (error) {
    return { ok: false, error: `Failed to save budget: ${error.message}` };
  }

  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}
