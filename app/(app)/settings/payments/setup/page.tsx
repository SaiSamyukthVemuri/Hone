import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { PaymentsView } from "../PaymentsView";

export const dynamic = "force-dynamic";

export default async function PaymentsSettings_setup() {
  // Each page resolves identity itself: a layout's redirect never stops its page.
  await requirePractitionerWithStudio();
  return <PaymentsView view="setup" />;
}
