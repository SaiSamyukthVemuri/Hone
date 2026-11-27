"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { failureCode } from "@/lib/logging/error-class";
import { FRONT_DESK_NOT_ENABLED, FRONT_DESK_SEAT_LIMIT } from "@/lib/team-seats/errors";

// An owner deactivates or reactivates a receptionist.
//
// The owner is resolved on the SERVER (getCurrentPractitionerWithStudio, the
// action backstop), never taken from the form. Only the receptionist id and the
// desired state come from the browser. The 0216 command re-verifies the active
// owner in the database and refuses a receptionist of another studio
// ('not_found'), so a forged id cannot reach across studios. The command is
// service_role only, which is why the admin client calls it here, after this
// owner check.
export async function setReceptionistActiveAction(formData: FormData): Promise<void> {
  const id = formData.get("id");
  const active = formData.get("active");
  if (typeof id !== "string" || !id) throw new Error("Missing receptionist id.");
  if (active !== "true" && active !== "false") throw new Error("Missing receptionist state.");

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    throw new Error("Only studio owners can manage the team.");
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
    if (data === "not_found") throw new Error("Receptionist not found in this studio.");
    if (data === "not_authorized") throw new Error("Only studio owners can manage the team.");
    // The database refuses a reactivation when the Front Desk is off for the studio or every seat is taken (0390). Next hides the message of a
    // thrown server-action error in production, so these two are not thrown: they send the owner back to the Team page with a fixed code the page
    // turns into a visible sentence (seatsNoticeMessage in lib/team-seats/errors).
    const message = error?.message ?? "";
    if (data === "front_desk_off" || message.includes(FRONT_DESK_NOT_ENABLED)) redirect("/settings/team?seats=off");
    if (data === "seat_limit" || message.includes(FRONT_DESK_SEAT_LIMIT)) redirect("/settings/team?seats=full");
    // The one-active-row-per-email index (a database rule) can refuse a reactivation.
    if (error?.code === "23505") {
      throw new Error("Another active front-desk member already uses this email.");
    }
    throw new Error("Could not update the receptionist. Please try again.");
  }
  revalidatePath("/settings/team");
}
