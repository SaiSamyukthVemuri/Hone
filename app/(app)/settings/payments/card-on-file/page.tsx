import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { PaymentsView } from "../PaymentsView";

export const dynamic = "force-dynamic";

export default async function PaymentsSettings_card_on_file() {
  // Each page resolves identity itself: a layout's redirect never stops its page.
  await requirePractitionerWithStudio();
  return <PaymentsView view="card-on-file" />;
}
