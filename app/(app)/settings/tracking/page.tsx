import { redirect } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";

// Old route: Marketing & analytics is now Integrations > Marketing & analytics.
export default async function LegacyTrackingSettings() {
  await requirePractitionerWithStudio();
  redirect("/settings/integrations/marketing");
}
