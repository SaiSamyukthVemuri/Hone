import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import {
  getBlockouts,
  getRecurringBreakRules,
  getUpcomingTimedBlocks,
} from "@/lib/booking/queries";
import {
  getActivePractitioners,
  resolveScope,
  loadScopedAvailability,
  studioWideDefaults,
  studioWideOverrides,
} from "@/lib/booking/practitioner-availability";
import { addDays, todayInTz, resolveTimeFormat } from "@/lib/booking/tz";
import { AvailabilityClient } from "./AvailabilityClient";
import { RecurringBreaksSection } from "./RecurringBreaksSection";
import { TimedBlocksSection } from "./TimedBlocksSection";
import { ScopeSelector } from "./ScopeSelector";
import { PractitionerWeekEditor } from "./PractitionerWeekEditor";
import { getRequiredAppOrigin } from "@/lib/app-origin";

const Header = () => (
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
      All of these make time unavailable for public booking; labels and notes
      stay private to your studio.
    </p>
  </div>
);

export default async function AvailabilitySettingsPage({
  searchParams,
}: {
  searchParams?: Promise<{ practitioner?: string }>;
}) {
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
  const capacityOn = studio.practitioner_capacity_enabled === true;

  // ---- Flag OFF: byte-for-byte the existing studio-wide experience. This path
  // never queries practitioner_id / any 0135-only column (getAvailability* use
  // `select *` and no per-practitioner rows exist while the flag is off). ----
  if (!capacityOn) {
    // Rollback-safe: load ONLY studio-wide rows (practitioner_id IS NULL). A
    // studio that was enabled then disabled retains practitioner rows; those
    // must never leak into the studio-wide editor. The safe loader falls back
    // to the legacy query only if the 0135 column is genuinely absent.
    const supabase = await createClient();
    const [defaults, overrides, blockouts, recurringRules, timedBlocks] =
      await Promise.all([
        studioWideDefaults(supabase, studio.id),
        studioWideOverrides(supabase, studio.id, today, ninetyDaysOut),
        getBlockouts(studio.id),
        getRecurringBreakRules(studio.id),
        getUpcomingTimedBlocks(studio.id, nowIso),
      ]);
    return (
      <section className="flex flex-col gap-10">
        <Header />
        <AvailabilityClient
          studioSlug={studio.slug}
          appOrigin={getRequiredAppOrigin()}
          defaults={defaults}
          overrides={overrides}
          blockouts={blockouts}
        />
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

  // ---- Flag ON: owner-only scope selector (Studio default + each active
  // practitioner). Scope resolves SERVER-SIDE and never trusts the URL id. ----
  const supabase = await createClient();
  const sp = searchParams ? await searchParams : {};
  const practitioners = await getActivePractitioners(supabase, studio.id);
  const scope = resolveScope(sp.practitioner ?? null, practitioners);

  const scopeSelector = (
    <ScopeSelector
      practitioners={practitioners}
      selected={scope.kind === "practitioner" ? scope.practitionerId : null}
    />
  );

  if (scope.kind === "studio") {
    // Studio-default scope: the existing studio-wide editor, but loading ONLY
    // the studio-wide (practitioner_id IS NULL) rows so per-practitioner rows
    // never leak into the studio grid.
    const [defaults, overrides, blockouts, recurringRules, timedBlocks] =
      await Promise.all([
        studioWideDefaults(supabase, studio.id),
        studioWideOverrides(supabase, studio.id, today, ninetyDaysOut),
        getBlockouts(studio.id),
        getRecurringBreakRules(studio.id),
        getUpcomingTimedBlocks(studio.id, nowIso),
      ]);
    return (
      <section className="flex flex-col gap-10">
        <Header />
        {scopeSelector}
        <AvailabilityClient
          studioSlug={studio.slug}
          appOrigin={getRequiredAppOrigin()}
          defaults={defaults}
          overrides={overrides}
          blockouts={blockouts}
        />
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

  // Practitioner scope: per-practitioner week + date overrides. Whole-day
  // blockouts / breaks / one-off blocks remain studio-wide (managed under
  // Studio default) in this slice — per-practitioner blocks are Part 3.
  const { week, overrides } = await loadScopedAvailability(
    supabase,
    studio.id,
    scope,
    today,
    ninetyDaysOut,
  );
  const current = practitioners.find((p) => p.id === scope.practitionerId)!;
  return (
    <section className="flex flex-col gap-10">
      <Header />
      {scopeSelector}
      <PractitionerWeekEditor
        practitionerId={current.id}
        practitionerName={current.display_name}
        practitionerColor={current.color}
        timeFormat={resolveTimeFormat(studio)}
        week={week}
        overrides={overrides}
      />
    </section>
  );
}
