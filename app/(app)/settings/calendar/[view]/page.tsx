import { notFound } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { SettingsViewHeading } from "@/components/settings/view-heading";
import { personalCalendarSlot } from "../personal-slot";

// One per-practitioner Calendar view from the slot (Willow's), at
// /settings/calendar/<slug>. `display` is its own static route and wins over
// this one. An unknown slug is a 404, not a placeholder.
export default async function CalendarSlotView({
  params,
}: {
  params: Promise<{ view: string }>;
}) {
  const { view } = await params;
  const { practitioner, studio } = await requirePractitionerWithStudio();
  const entry = personalCalendarSlot?.views.find((v) => v.slug === view);
  if (!entry) notFound();

  return (
    <section className="flex flex-col gap-8">
      <SettingsViewHeading title={entry.label} scope="Just you." />
      <entry.Content practitioner={practitioner} studio={studio} />
    </section>
  );
}
