import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  getAvailabilityDefaults,
  getBlockouts,
  getOverridesForRange,
  getUpcomingTimedBlocks,
} from "@/lib/booking/queries";
import { addDays, todayInTz } from "@/lib/booking/tz";
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

  // Timed blocks: load every current-and-future block across the
  // forward horizon, ordered soonest first. The 90-day public horizon
  // does NOT apply to owner-managed time; the owner can block a
  // meeting six months out and we must surface it here.
  const nowIso = new Date().toISOString();

  const [defaults, overrides, blockouts, timedBlocks] = await Promise.all([
    getAvailabilityDefaults(studio.id),
    getOverridesForRange(studio.id, today, ninetyDaysOut),
    getBlockouts(studio.id),
    getUpcomingTimedBlocks(studio.id, nowIso),
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
        blocks={timedBlocks}
      />
    </section>
  );
}
