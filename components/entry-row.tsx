import type { ElectrolysisEntry, LaserEntry } from "@/lib/types/database";
import { ELECTROLYSIS_MODES } from "@/lib/constants";

function modeLabel(value: ElectrolysisEntry["mode"]): string | null {
  if (!value) return null;
  return ELECTROLYSIS_MODES.find((m) => m.value === value)?.label ?? value;
}

export function ElectrolysisEntryRow({
  entry,
  density = "comfortable",
  action,
}: {
  entry: ElectrolysisEntry;
  density?: "comfortable" | "compact";
  action?: React.ReactNode;
}) {
  // Primary meta line: probe size · mode · modality · pulses · intensity · duration
  const meta: string[] = [];
  if (entry.probe_size) meta.push(entry.probe_size);
  const mLabel = modeLabel(entry.mode);
  if (mLabel) meta.push(mLabel);
  if (entry.apilus_modality) meta.push(entry.apilus_modality);
  if (entry.pulse_count != null) {
    meta.push(
      `${entry.pulse_count} ${entry.pulse_count === 1 ? "pulse" : "pulses"}`,
    );
  }
  if (entry.intensity != null) meta.push(`${entry.intensity}%`);
  if (entry.duration_seconds != null) meta.push(`${entry.duration_seconds}s`);

  // Secondary meta line: EL · probe type · machine frequency · minutes · hairs
  const sub: string[] = [];
  if (entry.energy_level != null) sub.push(`EL ${entry.energy_level}`);
  if (entry.probe_type) sub.push(entry.probe_type);
  if (entry.machine_frequency) sub.push(entry.machine_frequency);
  if (entry.minutes_performed != null) {
    sub.push(`${entry.minutes_performed} min`);
  }
  if (entry.hairs_treated != null) sub.push(`${entry.hairs_treated} hairs`);

  return (
    <div
      className={
        density === "compact"
          ? "flex flex-col gap-1 rounded-md border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-950 md:flex-row md:items-start md:justify-between"
          : "flex flex-col gap-2 rounded-md border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950 md:flex-row md:items-start md:justify-between"
      }
    >
      <div className="min-w-0 flex-1">
        <div className="font-medium">
          {entry.areas && entry.areas.length > 0
            ? entry.areas.join(" · ")
            : entry.area}
        </div>
        {meta.length > 0 && (
          <div className="text-xs text-neutral-500">{meta.join(" · ")}</div>
        )}
        {sub.length > 0 && (
          <div className="text-xs text-neutral-500">{sub.join(" · ")}</div>
        )}
        {entry.comments && (
          <div className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
            {entry.comments}
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
