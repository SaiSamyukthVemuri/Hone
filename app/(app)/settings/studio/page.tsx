import { redirect } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { OwnerOnlyNotice } from "@/components/settings/view-heading";

// /settings/studio is only a doorway to its first view; each Studio view is its
// own route. Old section hashes are forwarded by lib/settings/redirects.ts.
export default async function StudioSettingsIndex() {
  const { practitioner } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return <OwnerOnlyNotice>Only studio owners can change studio settings.</OwnerOnlyNotice>;
  }
  redirect("/settings/studio/details");
}
