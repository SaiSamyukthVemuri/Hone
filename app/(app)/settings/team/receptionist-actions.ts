"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

// STUDIO-READY-02d (#824): an owner deactivates or reactivates a receptionist.
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
      `team_action_db_error:set_receptionist_active:${error?.code ?? (typeof data === "string" ? data : "unknown")}`,
    );
    if (data === "not_found") throw new Error("Receptionist not found in this studio.");
    if (data === "not_authorized") throw new Error("Only studio owners can manage the team.");
    throw new Error("Could not update the receptionist. Please try again.");
  }
  revalidatePath("/settings/team");
}
