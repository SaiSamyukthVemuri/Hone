"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { dbErrorCode } from "@/lib/logging/error-class";

// HON-58 Q1: the owner switch for receptionist access to client legal names. Owner only, and the
// database enforces that on its own: set_receptionist_legal_name_access (0266) is SECURITY DEFINER,
// resolves the caller from auth.uid(), refuses anyone who is not an active owner of the studio, and
// writes the append-only audit row itself. This action therefore uses the SIGNED-IN client only
// (never the service role, which has no execute grant). It never defaults to ON: anything but an
// explicit "on" with an explicit confirmation is OFF, and the form's initial state is whatever is stored.

export type LegalNameAccessResult = { ok: true; receptionistAccess: boolean; changed: boolean } | { ok: false; error: string };

const GENERIC = "Couldn't change this setting. Please try again.";
const OWNER_ONLY_LEGAL_NAME_MESSAGE = "Only studio owners can change this setting.";

export async function setReceptionistLegalNameAccessAction(formData: FormData): Promise<LegalNameAccessResult> {
  const requested = formData.get("enabled");
  if (requested !== "on" && requested !== "off") return { ok: false, error: GENERIC };
  const enabled = requested === "on";
  // Turning it ON widens who can see legal names, so it needs an explicit confirmation.
  if (enabled && formData.get("confirm") !== "yes") {
    return { ok: false, error: "Confirm that you want receptionists to see client legal names." };
  }

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") return { ok: false, error: OWNER_ONLY_LEGAL_NAME_MESSAGE };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("set_receptionist_legal_name_access", {
    p_studio_id: studio.id,
    p_enabled: enabled,
  });
  if (error) {
    console.error(JSON.stringify({ event: "legal_name_access_set_failed", code: dbErrorCode(error), timestamp: new Date().toISOString() }));
    return { ok: false, error: dbErrorCode(error) === "42501" ? OWNER_ONLY_LEGAL_NAME_MESSAGE : GENERIC };
  }

  revalidatePath("/settings/team");
  // The function returns true only when the value actually changed (a no-op writes no audit row).
  return { ok: true, receptionistAccess: enabled, changed: data === true };
}
