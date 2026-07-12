import type {
  ElectrolysisEntry,
  LaserEntry,
  SessionBlock,
} from "@/lib/types/database";
import type { TreatmentParams } from "@/lib/supabase/queries";
import { ELECTROLYSIS_MODES, apilusModalityLabel } from "@/lib/constants";
import { formatSeconds } from "@/lib/sessions/format-seconds";
import { resolveDisplayChips } from "@/lib/observation-chips";

function modeLabel(value: ElectrolysisEntry["mode"]): string | null {
  if (!value) return null;
  return ELECTROLYSIS_MODES.find((m) => m.value === value)?.label ?? value;
}

// Migration 0108 + chip-loading fix: structured treatment-observation chips
// render as their own pills (separate from free-text notes). For LEGACY rows
// (observation_chips = []) the chips are still in `comments`, so we hydrate them
// via resolveDisplayChips so pre-0108 / legacy-form observations still render as
// pills (the caller shows the chip-stripped free-text as the note — no
// double-display). normalizeChips() drops any unknown value; stored data is
// never mutated.
function ObservationChips({ chips }: { chips: string[] }) {
  if (chips.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {chips.map((c) => (
        <span
          key={c}
          className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
        >
          {c}
        </span>
      ))}
    </div>
  );
}

// Optional treatmentParams + block are computed upstream by SessionBlocksView
// and passed in. When omitted (legacy callers like SessionTimeline and the
// client cheat-sheet "last session" preview), the row falls back to reading
// entry-level fields directly. This keeps backwards compat without invoking
// the resolver inside the row.
export function ElectrolysisEntryRow({
  entry,
  treatmentParams,
  block,
  density = "comfortable",
  action,
  variant = "full",
  hideArea = false,
  label,
}: {
  entry: ElectrolysisEntry;
  treatmentParams?: TreatmentParams;
  block?: SessionBlock | null;
  density?: "comfortable" | "compact";
  action?: React.ReactNode;
  // "readings": compact render for entries shown INSIDE a treatment-area
  // card whose header already shows the area + machine/probe summary. It
  // shows only the per-pass readings + notes (no repeated area/mode/probe),
  // which flattens the saved view. "full" (default) keeps the standalone
  // render used by SessionTimeline and the client "last session" preview.
  variant?: "full" | "readings";
  // In "readings", suppress the area title when it duplicates the card
  // header's area (the one-page first entry). A pass with a different area
  // still shows it.
  hideArea?: boolean;
  // Optional small label for extra passes ("Pass 2").
  label?: string;
}) {
  const params: TreatmentParams = treatmentParams ?? {
    mode: entry.mode,
    apilus_modality: entry.apilus_modality,
    energy_level: entry.energy_level,
    minutes_performed: entry.minutes_performed,
    probe_type: entry.probe_type,
    probe_size: entry.probe_size,
    machine_frequency: entry.machine_frequency,
  };

  // Chip-loading fix: resolve the chips to show (structured column, else legacy
  // chips hydrated from comments) and the note (chip-stripped free-text) ONCE, so
  // pills + notes stay consistent and legacy chips reliably render. Display-only;
  // the stored row is never rewritten here.
  const display = resolveDisplayChips(entry.observation_chips, entry.comments);

  // Migration 0042: structured blend/galvanic readings. When any are
  // present, show grouped Galvanic / Thermolysis lines instead of the
  // legacy intensity/duration/pulse in the meta line (avoids duplication).
  // Legacy entries (no structured readings) keep the original display.
  const galvanicParts: string[] = [];
  if (entry.galvanic_ma != null) galvanicParts.push(`${entry.galvanic_ma} mA`);
  if (entry.galvanic_duration_seconds != null) {
    galvanicParts.push(`${entry.galvanic_duration_seconds}s`);
  }
  if (entry.galvanic_intensity_percent != null) {
    galvanicParts.push(`${entry.galvanic_intensity_percent}%`);
  }
  if (entry.units_of_lye != null) galvanicParts.push(`${entry.units_of_lye} UL`);

  const isThermoish = entry.mode === "thermo" || entry.mode === "blend";
  const thermoParts: string[] = [];
  if (entry.thermolysis_intensity_percent != null) {
    thermoParts.push(`${entry.thermolysis_intensity_percent}%`);
  }
  if (entry.thermolysis_duration_seconds != null) {
    // PR #165. Route through formatSeconds so fractional values
    // like 0.15 / 0.2 render as "0.15 seconds" / "0.2 seconds"
    // instead of being silently rounded down to "0s" by the prior
    // integer-truncating storage + bare template literal display.
    // Whole-second values render as "1 second" / "2 seconds" so
    // the practitioner-facing copy reads naturally.
    const label = formatSeconds(entry.thermolysis_duration_seconds);
    if (label) thermoParts.push(label);
  }
  // Pulse delay only reads when multiple pulses were done (pulse_count > 1) and
  // a value was recorded. numeric may arrive as string via PostgREST, so
  // coerce before formatting to 2 decimals.
  const pulseDelayLabel =
    entry.pulse_count != null &&
    entry.pulse_count > 1 &&
    entry.pulse_delay_seconds != null
      ? `${Number(entry.pulse_delay_seconds).toFixed(2)}s delay`
      : null;
  if (isThermoish && entry.pulse_count != null) {
    thermoParts.push(
      `${entry.pulse_count} ${entry.pulse_count === 1 ? "pulse" : "pulses"}`,
    );
    if (pulseDelayLabel) thermoParts.push(pulseDelayLabel);
  }

  const hasStructured = galvanicParts.length > 0 || thermoParts.length > 0;

  // Primary meta line: probe size · mode · modality · pulses · intensity · duration
  const meta: string[] = [];
  if (params.probe_size) meta.push(params.probe_size);
  const mLabel = modeLabel(params.mode);
  if (mLabel) meta.push(mLabel);
  if (params.apilus_modality) meta.push(apilusModalityLabel(params.apilus_modality));
  if (!hasStructured) {
    if (entry.pulse_count != null) {
      meta.push(
        `${entry.pulse_count} ${entry.pulse_count === 1 ? "pulse" : "pulses"}`,
      );
      if (pulseDelayLabel) meta.push(pulseDelayLabel);
    }
    if (entry.intensity != null) meta.push(`${entry.intensity}%`);
    if (entry.duration_seconds != null) meta.push(`${entry.duration_seconds}s`);
  }

  // Secondary meta line: EL · probe type · machine frequency · minutes · hairs
  const sub: string[] = [];
  if (params.energy_level != null) sub.push(`EL ${params.energy_level}`);
  if (params.probe_type) sub.push(params.probe_type);
  if (params.machine_frequency) sub.push(params.machine_frequency);
  if (params.minutes_performed != null) {
    sub.push(`${params.minutes_performed} min`);
  }
  // Hairs move to their own line for structured entries; legacy entries keep
  // it in the sub line.
  if (!hasStructured && entry.hairs_treated != null) {
    sub.push(`${entry.hairs_treated} hairs`);
  }

  // Override badge: the entry's own mode differs from its block's mode.
  // Only renders when BOTH are non-null. Backfilled blocks with null mode
  // and entries with null mode never trigger the badge.
  const isOverride = Boolean(
    block && block.mode && entry.mode && block.mode !== entry.mode,
  );

  // Flattened render for entries inside a treatment-area card: readings +
  // notes only, no repeated area/mode/modality/probe (the card header shows
  // those). Avoids the "section inside a section" duplication.
  if (variant === "readings") {
    const areaText =
      entry.areas && entry.areas.length > 0
        ? entry.areas.join(" · ")
        : entry.area;
    const legacyReadings: string[] = [];
    if (!hasStructured) {
      if (entry.pulse_count != null) {
        legacyReadings.push(
          `${entry.pulse_count} ${entry.pulse_count === 1 ? "pulse" : "pulses"}`,
        );
        if (pulseDelayLabel) legacyReadings.push(pulseDelayLabel);
      }
      if (entry.intensity != null) legacyReadings.push(`${entry.intensity}%`);
      if (entry.duration_seconds != null) {
        legacyReadings.push(`${entry.duration_seconds}s`);
      }
    }
    const showTop = Boolean(label) || (!hideArea && Boolean(areaText)) || isOverride;
    // Flattened: no bordered/gray wrapper. The readings sit directly inside
    // the treatment-area card (the card itself is the only box), which
    // removes the "section inside a section" nesting.
    return (
      <div className="flex flex-col gap-1 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          {showTop && (
            <div className="flex flex-wrap items-baseline gap-2">
              {label && (
                <span className="text-xs font-medium text-neutral-500">
                  {label}
                </span>
              )}
              {!hideArea && areaText && (
                <span className="font-medium">{areaText}</span>
              )}
              {isOverride && (
                <span
                  className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-950 dark:text-amber-200"
                  title="This entry's mode differs from its treatment area's mode."
                >
                  Override
                </span>
              )}
            </div>
          )}
          {!hasStructured && legacyReadings.length > 0 && (
            <div className="text-xs text-neutral-500">
              {legacyReadings.join(" · ")}
            </div>
          )}
          {!hasStructured && entry.hairs_treated != null && (
            <div className="text-xs text-neutral-500">
              Hairs treated: {entry.hairs_treated}
            </div>
          )}
          {galvanicParts.length > 0 && (
            <div className="text-xs text-neutral-500">
              <span className="font-medium text-neutral-600 dark:text-neutral-400">
                Galvanic:
              </span>{" "}
              {galvanicParts.join(" · ")}
            </div>
          )}
          {thermoParts.length > 0 && (
            <div className="text-xs text-neutral-500">
              <span className="font-medium text-neutral-600 dark:text-neutral-400">
                Thermolysis:
              </span>{" "}
              {thermoParts.join(" · ")}
            </div>
          )}
          {hasStructured && entry.hairs_treated != null && (
            <div className="text-xs text-neutral-500">
              Hairs treated: {entry.hairs_treated}
            </div>
          )}
          <ObservationChips chips={display.chips} />
          {display.note && (
            <div className="mt-1 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
              <span className="text-xs font-medium text-neutral-500">
                Notes:
              </span>{" "}
              <span className="whitespace-pre-wrap">{display.note}</span>
            </div>
          )}
          {!showTop &&
            !hasStructured &&
            legacyReadings.length === 0 &&
            entry.hairs_treated == null &&
            display.chips.length === 0 &&
            !display.note && (
              <div className="text-xs text-neutral-400">No readings recorded.</div>
            )}
        </div>
        {action}
      </div>
    );
  }

  return (
    <div
      className={
        density === "compact"
          ? "flex flex-col gap-1 rounded-md border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-950 md:flex-row md:items-start md:justify-between"
          : "flex flex-col gap-2 rounded-md border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950 md:flex-row md:items-start md:justify-between"
      }
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-medium">
            {entry.areas && entry.areas.length > 0
              ? entry.areas.join(" · ")
              : entry.area}
          </span>
          {isOverride && (
            <span
              className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-950 dark:text-amber-200"
              title="This entry's mode differs from its block's mode."
            >
              Override
            </span>
          )}
        </div>
        {meta.length > 0 && (
          <div className="text-xs text-neutral-500">{meta.join(" · ")}</div>
        )}
        {sub.length > 0 && (
          <div className="text-xs text-neutral-500">{sub.join(" · ")}</div>
        )}
        {galvanicParts.length > 0 && (
          <div className="text-xs text-neutral-500">
            <span className="font-medium text-neutral-600 dark:text-neutral-400">
              Galvanic:
            </span>{" "}
            {galvanicParts.join(" · ")}
          </div>
        )}
        {thermoParts.length > 0 && (
          <div className="text-xs text-neutral-500">
            <span className="font-medium text-neutral-600 dark:text-neutral-400">
              Thermolysis:
            </span>{" "}
            {thermoParts.join(" · ")}
          </div>
        )}
        {hasStructured && entry.hairs_treated != null && (
          <div className="text-xs text-neutral-500">
            Hairs treated: {entry.hairs_treated}
          </div>
        )}
        <ObservationChips chips={display.chips} />
        {display.note && (
          <div className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
            {display.note}
          </div>
        )}
      </div>
      {action}
    </div>
  );
}

export function LaserEntryRow({
  entry,
  density = "comfortable",
  action,
}: {
  entry: LaserEntry;
  density?: "comfortable" | "compact";
  action?: React.ReactNode;
}) {
  const params = (entry.equipment_params ?? {}) as Record<string, unknown>;
  const meta: string[] = [];
  if (entry.session_number != null) {
    meta.push(`Treatment #${entry.session_number}`);
  }
  if (typeof params.fluence === "string" && params.fluence) {
    meta.push(`Fluence ${params.fluence}`);
  }
  if (typeof params.pulse_width === "string" && params.pulse_width) {
    meta.push(`Pulse ${params.pulse_width}`);
  }
  if (typeof params.spot_size === "string" && params.spot_size) {
    meta.push(`Spot ${params.spot_size}`);
  }

  return (
    <div
      className={
        density === "compact"
          ? "flex flex-col gap-1 rounded-md border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-950 md:flex-row md:items-start md:justify-between"
          : "flex flex-col gap-2 rounded-md border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950 md:flex-row md:items-start md:justify-between"
      }
    >
      <div className="min-w-0 flex-1">
        <div className="font-medium">{entry.zone}</div>
        {meta.length > 0 && (
          <div className="text-xs text-neutral-500">{meta.join(" · ")}</div>
        )}
        {entry.observation_notes && (
          <div className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
            {entry.observation_notes}
          </div>
        )}
      </div>
      {action}
    </div>
  );
}
