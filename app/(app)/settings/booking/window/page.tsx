import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { BookingView } from "../BookingView";

export default async function Booking_windowPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Each page resolves identity itself: a layout's redirect never stops its page.
  await requirePractitionerWithStudio();
  return <BookingView view="window" searchParams={searchParams} />;
}
