"use server";

import { redirect } from "next/navigation";
import { requireReceptionistChoice } from "@/lib/desk/guard";
import { setSelectedStudioId } from "@/lib/supabase/selected-studio";

// The desk's ONLY server action, and it writes nothing but the selected-studio cookie. The cookie is set only after the
// signed-in user's ACTIVE receptionist rows are read again, in this request, and one of them is the requested studio:
// a forged or stale studio id, an inactive row and a studio held only as a practitioner all fall back to the chooser
// with no cookie set. The cookie is a hint and is re-validated on every desk request anyway (lib/desk/membership.ts).
export async function chooseDeskStudioAction(formData: FormData): Promise<void> {
  const studioId = formData.get("studio_id");
  const rows = await requireReceptionistChoice();
  if (typeof studioId !== "string" || !rows.some((r) => r.studio_id === studioId)) redirect("/desk/choose");
  await setSelectedStudioId(studioId as string);
  redirect("/desk");
}
