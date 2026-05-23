import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  getAvailabilityDefaults,
  getBlockouts,
  getOverridesForRange,
  getTimedBlocksForRange,
} from "@/lib/booking/queries";
import { addDays, todayInTz, utcInstantFromLocal } from "@/lib/booking/tz";
import { AvailabilityClient } from "./AvailabilityClient";
import { TimedBlocksSection } from "./TimedBlocksSection";

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

  // UTC bounds for the next 90 local days, used to load upcoming
  // timed blocks. We over-fetch by a day on each side so a block
  // straddling local midnight is included regardless of UTC offset.
  const timedBlocksStartUtc = utcInstantFromLocal(today, "00:00", studio.timezone);
  const timedBlocksEndUtc = utcInstantFromLocal(
    addDays(ninetyDaysOut, 1),
    "00:00",
    studio.timezone,
  );

  const [defaults, overrides, blockouts, timedBlocks] = await Promise.all([
    getAvailabilityDefaults(studio.id),
    getOverridesForRange(studio.id, today, ninetyDaysOut),
    getBlockouts(studio.id),
    getTimedBlocksForRange(
      studio.id,
      timedBlocksStartUtc.toISOString(),
      timedBlocksEndUtc.toISOString(),
    ),
  ]);

  return (
    <section className="flex flex-col gap-10">
      <div>
        <h2 className="text-xl font-medium">Availability</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Your weekly hours, one-off overrides, blockout dates, and time
          blocks for lunch, meetings, and other personal time. Booking
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
      <TimedBlocksSection
        studioTimezone={studio.timezone}
        todayLocal={today}
        ninetyDaysOut={ninetyDaysOut}
        blocks={timedBlocks}
      />
    </section>
  );
}
