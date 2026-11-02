import { redirect } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";

// /settings/studio is only a doorway to its first view; each Studio view is its
// own route. Old section hashes are forwarded by lib/settings/redirects.ts.
export default async function StudioSettingsIndex() {
  await requirePractitionerWithStudio();
  redirect("/settings/studio/details");
}
