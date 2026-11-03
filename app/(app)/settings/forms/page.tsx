import { redirect } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";

// /settings/forms is only a doorway. An owner lands on Postcare; a practitioner,
// who can only read the intake form, on the preview.
export default async function FormsIndex() {
  const { practitioner } = await requirePractitionerWithStudio();
  redirect(
    practitioner.role === "owner"
      ? "/settings/forms/postcare"
      : "/settings/forms/intake-preview",
  );
}
