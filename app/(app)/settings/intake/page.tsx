import { redirect } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";

// Old route, kept as a doorway: Forms & policies became three focused views
// under /settings/forms. Hash links (#postcare, #policies, #intake-preview) are
// forwarded by the client redirect on the destination (lib/settings/redirects).
export default async function LegacyIntakeSettings() {
  const { practitioner } = await requirePractitionerWithStudio();
  redirect(practitioner.role === "owner" ? "/settings/forms/postcare" : "/settings/forms/intake-preview");
}
