"use server";

import { redirect } from "next/navigation";
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
  await setSelectedStudioId(studioId);
  redirect("/front-desk");
}
