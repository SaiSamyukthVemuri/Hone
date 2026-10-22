"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fulfilAdminReturn } from "@/lib/auth/admin-return";
import { isOwnFrontDeskStudio } from "@/lib/receptionist/identity";
import { setSelectedStudioId } from "@/lib/supabase/selected-studio";

// STUDIO-READY-02d (#824): a receptionist in 2+ studios picks one. The cookie is
// set ONLY after the studio is verified against the caller's own active
// receptionist rows. Every reader re-validates it anyway, so a forged value
// grants nothing.
export async function selectFrontDeskStudioAction(formData: FormData): Promise<void> {
  const studioId = formData.get("studio_id");
  if (typeof studioId !== "string" || !studioId) redirect("/front-desk/select");
  if (!(await isOwnFrontDeskStudio(studioId))) redirect("/front-desk/select");
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  await setSelectedStudioId(studioId);
  // The required choice is verified and persisted before consuming the target.
  redirect((await fulfilAdminReturn(user.email)) ?? "/front-desk");
}
