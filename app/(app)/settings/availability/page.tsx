import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  getAvailabilityDefaults,
  getBlockouts,
  getOverridesForRange,
  getRecurringBreakRules,
  getUpcomingTimedBlocks,
} from "@/lib/booking/queries";
import { addDays, todayInTz, resolveTimeFormat } from "@/lib/booking/tz";
import { AvailabilityClient } from "./AvailabilityClient";
import { RecurringBreaksSection } from "./RecurringBreaksSection";
import { TimedBlocksSection } from "./TimedBlocksSection";
import { getRequiredAppOrigin } from "@/lib/app-origin";

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
  const nowIso = new Date().toISOString();

  // Availability is now the single home for every scheduling rule: weekly
  // hours + overrides + whole-day blockouts (AvailabilityClient), repeating
  // breaks, and one-off timed blocks. The breaks/blocks sections previously
  // lived on a separate "Breaks & blocks" (/settings/calendar) tab; that tab
  // is consolidated here and the route redirects to this page.
  const [defaults, overrides, blockouts, recurringRules, timedBlocks] =
    await Promise.all([
      getAvailabilityDefaults(studio.id),
      getOverridesForRange(studio.id, today, ninetyDaysOut),
      getBlockouts(studio.id),
      getRecurringBreakRules(studio.id),
      getUpcomingTimedBlocks(studio.id, nowIso),
    ]);

  return (
    <section className="flex flex-col gap-10">
      <div>
        <h2 className="text-xl font-medium">Availability</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Everything that decides when clients can book, in one place:
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-neutral-500">
          <li>
            <span className="font-medium text-neutral-700 dark:text-neutral-300">
              Weekly opening hours
            </span>{" "}
            and one-off date overrides.
          </li>
          <li>
            <span className="font-medium text-neutral-700 dark:text-neutral-300">
              Whole-day blocked dates
            </span>{" "}
            — vacations and full days off (date ranges).
          </li>
          <li>
            <span className="font-medium text-neutral-700 dark:text-neutral-300">
              Repeating breaks
            </span>{" "}
            — a regular daily lunch, dinner, or admin window.
          </li>
          <li>
            <span className="font-medium text-neutral-700 dark:text-neutral-300">
              One-off timed blocks
            </span>{" "}
            — a single appointment, meeting, or part-day interruption.
          </li>
        </ul>
        <p className="mt-2 text-sm text-neutral-500">
          All of these make time unavailable for public booking; labels and
          notes stay private to your studio.
        </p>
      </div>
      <AvailabilityClient
        studioSlug={studio.slug}
        appOrigin={getRequiredAppOrigin()}
        defaults={defaults}
        overrides={overrides}
        blockouts={blockouts}
      />
      {/* Repeating breaks before one-off timed blocks: first-time setup
          configures the standing weekly lunch/dinner/admin window before
          reaching for one-off blocks. Both use the same server actions in
          ./actions and the same owner/studio gates as the rest of the page. */}
      <RecurringBreaksSection rules={recurringRules} />
      <TimedBlocksSection
        studioTimezone={studio.timezone}
        timeFormat={resolveTimeFormat(studio)}
        todayLocal={today}
        blocks={timedBlocks}
      />
    </section>
  );
}
