import { redirect } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";

// /settings/payments is only a doorway to Payment setup; the Stripe return and
// refresh routes under this path are unchanged.
export default async function PaymentsSettingsIndex() {
  await requirePractitionerWithStudio();
  redirect("/settings/payments/setup");
}
