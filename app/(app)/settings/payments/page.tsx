import { redirect } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { OwnerOnlyNotice } from "@/components/settings/view-heading";

// /settings/payments is only a doorway to Payment setup; the Stripe return and
// refresh routes under this path are unchanged.
export default async function PaymentsSettingsIndex() {
  const { practitioner } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return <OwnerOnlyNotice>Only the studio owner can manage payments.</OwnerOnlyNotice>;
  }
  redirect("/settings/payments/setup");
}
