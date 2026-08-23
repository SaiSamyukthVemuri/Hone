"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

// ===========================================================================
// NEW-CLIENT WAITLIST — OPERATOR REMOVAL (WAIT-02)
// ===========================================================================
//
// THE ONLY MUTATION THIS SURFACE HAS, and it is not a write from here at all.
// `authenticated` holds SELECT and nothing else on new_client_waitlist_entries
// (migration 0185), so this action cannot issue DML even if it tried to; the
// transition is performed by `remove_new_client_waitlist_entry`, which
// re-derives studio membership AND owner role in the database from the
// authenticated user id.
//
// WHAT THE BROWSER SUPPLIES: one entry id. Nothing else. The studio and the
// actor are resolved server-side from the session, so a forged post can name
// an id but never a tenant, an actor or a role — and the command scopes the
// entry lookup by (id, studio_id), so an id from another studio is simply not
// found.
//
// NOT A DELETE. The row transitions to `removed` with its actor and timestamp
// recorded, and leaves the active queue. Waitlist history is operational
// evidence; physically purging it belongs to an offboarding/retention policy,
// not to a button.
//
// PII. Names, emails and phone numbers never reach a log line here.
// ===========================================================================

/** Refusals the command can return, mapped to copy an owner can act on. */
const REFUSAL_MESSAGES: Readonly<Record<string, string>> = {
  not_found: "That waitlist entry no longer exists.",
  already_removed: "That entry has already been removed.",
  not_waiting: "That entry is no longer waiting.",
  not_owner: "Only studio owners can change the waitlist.",
  not_a_member: "Only studio owners can change the waitlist.",
};

export async function removeWaitlistEntryAction(formData: FormData): Promise<void> {
  const entryId = formData.get("entry_id");
  if (typeof entryId !== "string" || !entryId) {
    throw new Error("Missing waitlist entry.");
  }

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  // Route-level authority. Deliberately NOT the only check: the command below
  // re-derives the same fact from the database, so this early refusal is a
  // clearer message, never the guarantee.
  if (practitioner.role !== "owner") {
    throw new Error("Only studio owners can change the waitlist.");
  }
  // `practitioners.user_id` is nullable in the schema (a row can exist for an
  // invited practitioner before they sign in). This one was resolved FROM a
  // session, so it is always present — narrowed explicitly rather than passed
  // through as null, which the command would refuse as `invalid_input` and
  // report as a generic failure.
  const actorUserId = practitioner.user_id;
  if (!actorUserId) {
    throw new Error("Could not identify the signed-in practitioner.");
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("remove_new_client_waitlist_entry", {
    p_studio_id: studio.id,
    p_entry_id: entryId,
    p_actor_user_id: actorUserId,
  });

  if (error || data !== "removed") {
    const outcome =
      error?.code ?? (typeof data === "string" ? data : "unknown");
    console.error(
      JSON.stringify({
        event: "waitlist_remove_failed",
        studioId: studio.id,
        outcome,
        timestamp: new Date().toISOString(),
      }),
    );
    const known = typeof data === "string" ? REFUSAL_MESSAGES[data] : undefined;
    throw new Error(known ?? "Could not remove that entry. Please try again.");
  }

  revalidatePath("/settings/waitlist");
}
