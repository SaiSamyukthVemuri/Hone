import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  getRecurringBreakRules,
  getUpcomingTimedBlocks,
} from "@/lib/booking/queries";
import { todayInTz } from "@/lib/booking/tz";
import { TimedBlocksSection } from "./TimedBlocksSection";
import { RecurringBreaksSection } from "./RecurringBreaksSection";

export default async function CalendarSettingsPage() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return (
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-6 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        Only studio owners can change calendar settings.
      </div>
    );
  }

  const today = todayInTz(studio.timezone);
  const nowIso = new Date().toISOString();

  const [timedBlocks, recurringRules] = await Promise.all([
    getUpcomingTimedBlocks(studio.id, nowIso),
    getRecurringBreakRules(studio.id),
  ]);

  return (
    <section className="flex flex-col gap-10">
      <div>
        <h2 className="text-xl font-medium">Calendar</h2>
        <p className="mt-1 text-sm text-neutral-500">
          One-off blocks and repeating breaks. Block details and notes are
          private; clients only see the slot as unavailable.
        </p>
      </div>
      <TimedBlocksSection
        studioTimezone={studio.timezone}
        todayLocal={today}
        blocks={timedBlocks}
      />
      <RecurringBreaksSection rules={recurringRules} />
    </section>
  );
}
