import type { ElectrolysisEntry, LaserEntry } from "@/lib/types/database";
import { ELECTROLYSIS_MODES } from "@/lib/constants";

const COMMENT_TRUNCATE = 60;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

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
  const meta: string[] = [];
  if (entry.probe_size) meta.push(entry.probe_size);
  const mLabel = modeLabel(entry.mode);
  if (mLabel) meta.push(mLabel);

  const stats: string[] = [];
  if (entry.intensity != null) stats.push(`${entry.intensity}`);
  if (entry.duration_seconds != null) stats.push(`${entry.duration_seconds}s`);
  if (entry.pulse_count != null) {
    stats.push(
      `${entry.pulse_count} ${entry.pulse_count === 1 ? "pulse" : "pulses"}`,
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
        <div className="font-medium">{entry.area}</div>
        {meta.length > 0 && (
          <div className="text-xs text-neutral-500">{meta.join(" · ")}</div>
        )}
        {stats.length > 0 && (
          <div className="text-xs text-neutral-500">{stats.join(" · ")}</div>
        )}
        {entry.comments && (
          <div className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">
            {truncate(entry.comments, COMMENT_TRUNCATE)}
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
  const equip: string[] = [];
  if (typeof params.fluence === "string" && params.fluence) {
    equip.push(`Fluence ${params.fluence}`);
  }
  if (typeof params.pulse_width === "string" && params.pulse_width) {
    equip.push(`Pulse ${params.pulse_width}`);
  }
  if (typeof params.spot_size === "string" && params.spot_size) {
    equip.push(`Spot ${params.spot_size}`);
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
        <div className="flex items-baseline gap-2">
          <span className="font-medium">{entry.zone}</span>
          {entry.session_number != null && (
            <span className="text-xs text-neutral-500">
              Treatment #{entry.session_number}
            </span>
          )}
        </div>
        {equip.length > 0 && (
          <div className="text-xs text-neutral-500">{equip.join(" · ")}</div>
        )}
        {entry.observation_notes && (
          <div className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">
            {truncate(entry.observation_notes, COMMENT_TRUNCATE)}
          </div>
        )}
      </div>
      {action}
    </div>
  );
}
