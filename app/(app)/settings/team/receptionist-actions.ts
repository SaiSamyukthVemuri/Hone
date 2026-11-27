"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { failureCode } from "@/lib/logging/error-class";
import { ACTION_OK, actionFailed, type ActionResult } from "@/lib/actions/action-result";

// An owner deactivates or reactivates a receptionist.
//
// The owner is resolved on the SERVER (getCurrentPractitionerWithStudio, the
// action backstop), never taken from the form. Only the receptionist id and the
// desired state come from the browser. The 0216 command re-verifies the active
// owner in the database and refuses a receptionist of another studio
// ('not_found'), so a forged id cannot reach across studios. The command is
// service_role only, which is why the admin client calls it here, after this
// owner check.
// HON-124 item 20: refusals are RETURNED (production redacts a thrown message); the DB command and its checks are unchanged.
export async function setReceptionistActiveAction(formData: FormData): Promise<ActionResult> {
  const id = formData.get("id");
  const active = formData.get("active");
  if (typeof id !== "string" || !id) return actionFailed("Reload the page and try again.");
  if (active !== "true" && active !== "false") return actionFailed("Reload the page and try again.");

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return actionFailed("Only the studio owner can manage the team.");
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("set_studio_receptionist_active", {
    p_studio_id: studio.id,
    p_owner_practitioner_id: practitioner.id,
    p_receptionist_id: id,
    p_active: active === "true",
  });
  if (error || (data !== "updated" && data !== "no_change")) {
    console.error(
      `team_action_db_error:set_receptionist_active:${failureCode(error, data)}`,
    );
    if (data === "not_found") return actionFailed("That front-desk member could not be found. Reload the page and try again.");
    if (data === "not_authorized") return actionFailed("Only the studio owner can manage the team.");
    // The one-active-row-per-email index (a database rule) can refuse a reactivation.
    if (error?.code === "23505") {
      return actionFailed("Another active front-desk member already uses this email.");
    }
    return actionFailed("Could not update this front-desk member. Try again, and contact support if it keeps happening.");
  }
  revalidatePath("/settings/team");
  return ACTION_OK;
}
