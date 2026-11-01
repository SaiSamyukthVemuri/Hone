import { redirect } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";

// /settings/integrations is only a doorway to its first view; each integration
// is its own route. A non-owner is sent to Profile by the view itself.
export default async function IntegrationsSettingsIndex() {
  await requirePractitionerWithStudio();
  redirect("/settings/integrations/google-calendar");
}
