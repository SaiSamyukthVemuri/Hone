import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { getBlockouts } from "@/lib/booking/queries";
import {
  getActivePractitioners,
  resolveScope,
  loadScopedAvailability,
  studioWideDefaults,
  studioWideOverrides,
} from "@/lib/booking/practitioner-availability";
import {
  getScopedRecurringBreakRulesSafe,
  getScopedUpcomingTimedBlocksSafe,
  getPractitionerDirectory,
  type ScopeLoad,
  type PractitionerDirectory,
} from "@/lib/booking/scoped-unavailability";
import { addDays, todayInTz, resolveTimeFormat } from "@/lib/booking/tz";
import { AvailabilityClient } from "./AvailabilityClient";
import { RecurringBreaksSection } from "./RecurringBreaksSection";
import { TimedBlocksSection } from "./TimedBlocksSection";
import { ScopeSelector } from "./ScopeSelector";
import { PractitionerWeekEditor } from "./PractitionerWeekEditor";
import type {
  ScopeDirectory,
  ScopeSelectable,
  ViewScope,
} from "./ScopeField";
import { getRequiredAppOrigin } from "@/lib/app-origin";

// Flatten the loaded directory into the plain, RSC-serializable shapes the
// client scope controls take (an array of selectable actives + a lookup record
// for labelling existing sources, active OR inactive).
function toScopeProps(dir: PractitionerDirectory): {
  selectable: ScopeSelectable[];
  directory: ScopeDirectory;
} {
  const directory: ScopeDirectory = {};
  for (const p of dir.practitionerDirectory) {
    directory[p.id] = { display_name: p.display_name, active: p.active };
  }
  return {
    selectable: dir.selectablePractitioners.map((p) => ({
      id: p.id,
      display_name: p.display_name,
    })),
    directory,
  };
}

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
    const legacyScope: ScopeLoad = { mode: "legacy" };
    const [defaults, overrides, blockouts, recurringRules, timedBlocks] =
      await Promise.all([
        studioWideDefaults(supabase, studio.id),
        studioWideOverrides(supabase, studio.id, today, ninetyDaysOut),
        getBlockouts(studio.id),
        // Legacy shows studio-wide sources ONLY — a retained scoped rule/block
        // from a prior enable→disable cycle must stay hidden and dormant.
        getScopedRecurringBreakRulesSafe(supabase, studio.id, legacyScope),
        getScopedUpcomingTimedBlocksSafe(supabase, studio.id, nowIso, legacyScope),
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
        <RecurringBreaksSection
          rules={recurringRules}
          timeFormat={resolveTimeFormat(studio)}
        />
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
    // Studio-default scope: the WEEKLY-HOURS grid still loads only studio-wide
    // (practitioner_id IS NULL) rows so per-practitioner hours never leak into
    // the studio grid. Blocks + breaks, however, show EVERY source (studio-wide
    // + all practitioner-scoped, incl. inactive) each labelled with its scope,
    // so the owner has one place to see and manage them all.
    const studioScopeLoad: ScopeLoad = { mode: "studio-default" };
    const [defaults, overrides, blockouts, recurringRules, timedBlocks, dir] =
      await Promise.all([
        studioWideDefaults(supabase, studio.id),
        studioWideOverrides(supabase, studio.id, today, ninetyDaysOut),
        getBlockouts(studio.id),
        getScopedRecurringBreakRulesSafe(supabase, studio.id, studioScopeLoad),
        getScopedUpcomingTimedBlocksSafe(supabase, studio.id, nowIso, studioScopeLoad),
        getPractitionerDirectory(supabase, studio.id),
      ]);
    const scopeProps = toScopeProps(dir);
    const viewScope: ViewScope = { kind: "studio" };
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
        <RecurringBreaksSection
          rules={recurringRules}
          timeFormat={resolveTimeFormat(studio)}
          capacityOn
          viewScope={viewScope}
          selectable={scopeProps.selectable}
          directory={scopeProps.directory}
        />
        <TimedBlocksSection
          studioTimezone={studio.timezone}
          timeFormat={resolveTimeFormat(studio)}
          todayLocal={today}
          blocks={timedBlocks}
          capacityOn
          viewScope={viewScope}
          selectable={scopeProps.selectable}
          directory={scopeProps.directory}
        />
      </section>
    );
  }

  // Practitioner scope: per-practitioner week + date overrides, PLUS this
  // practitioner's repeating breaks and one-off blocks alongside the studio-wide
  // ones that also apply to them. New sources here default to this practitioner;
  // the owner can still choose "All practitioners". Whole-day blockouts stay
  // studio-wide (managed under Studio default).
  const practitionerScopeLoad: ScopeLoad = {
    mode: "practitioner",
    practitionerId: scope.practitionerId,
  };
  const [{ week, overrides }, recurringRules, timedBlocks, dir] =
    await Promise.all([
      loadScopedAvailability(supabase, studio.id, scope, today, ninetyDaysOut),
      getScopedRecurringBreakRulesSafe(supabase, studio.id, practitionerScopeLoad),
      getScopedUpcomingTimedBlocksSafe(supabase, studio.id, nowIso, practitionerScopeLoad),
      getPractitionerDirectory(supabase, studio.id),
    ]);
  const current = practitioners.find((p) => p.id === scope.practitionerId)!;
  const scopeProps = toScopeProps(dir);
  const viewScope: ViewScope = {
    kind: "practitioner",
    practitionerId: current.id,
  };
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
      <RecurringBreaksSection
        rules={recurringRules}
        timeFormat={resolveTimeFormat(studio)}
        capacityOn
        viewScope={viewScope}
        selectable={scopeProps.selectable}
        directory={scopeProps.directory}
      />
      <TimedBlocksSection
        studioTimezone={studio.timezone}
        timeFormat={resolveTimeFormat(studio)}
        todayLocal={today}
        blocks={timedBlocks}
        capacityOn
        viewScope={viewScope}
        selectable={scopeProps.selectable}
        directory={scopeProps.directory}
      />
    </section>
  );
}
