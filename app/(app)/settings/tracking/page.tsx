import { redirect } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { OwnerOnlyNotice } from "@/components/settings/view-heading";

// Old route: Marketing & analytics is now Integrations > Marketing & analytics.
export default async function LegacyTrackingSettings() {
  const { practitioner } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return <OwnerOnlyNotice>Only studio owners can manage marketing &amp; analytics tracking.</OwnerOnlyNotice>;
  }
  redirect("/settings/integrations/marketing");
}
