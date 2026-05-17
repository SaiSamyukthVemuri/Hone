import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  getAvailabilityDefaults,
  getBlockouts,
  getOverridesForRange,
} from "@/lib/booking/queries";
import { addDays, todayInTz } from "@/lib/booking/tz";
import { AvailabilityClient } from "./AvailabilityClient";

const APP_ORIGIN = process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://hone.care";

export default async function AvailabilitySettingsPage() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return (
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-6 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        Only studio owners can change availability.
      </div>
    );
  }

  const today = todayInTz(studio.timezone);
  const ninetyDaysOut = addDays(today, 90);

  const [defaults, overrides, blockouts] = await Promise.all([
    getAvailabilityDefaults(studio.id),
    getOverridesForRange(studio.id, today, ninetyDaysOut),
    getBlockouts(studio.id),
  ]);

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-medium">Availability</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Your weekly hours, one-off overrides, and blockout dates. Booking
          preferences (slug, timezone, address) live in the Booking tab.
        </p>
      </div>
      <AvailabilityClient
        studioSlug={studio.slug}
        appOrigin={APP_ORIGIN}
        defaults={defaults}
        overrides={overrides}
        blockouts={blockouts}
      />
    </section>
  );
}
