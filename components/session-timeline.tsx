import Link from "next/link";
import type { SessionWithEntries } from "@/lib/supabase/queries";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function entryCount(s: SessionWithEntries): number {
  return s.modality === "electrolysis"
    ? s.electrolysis_entries.length
    : s.laser_entries.length;
}

export function SessionTimeline({
  clientId,
  sessions,
}: {
  clientId: string;
  sessions: SessionWithEntries[];
}) {
  if (sessions.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-5 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
        No sessions yet.
      </div>
    );
  }

  return (
    <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
      {sessions.map((s) => (
        <li key={s.id}>
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-900">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  {formatDate(s.started_at)}
                </div>
                <div className="text-xs text-neutral-500">
                  {s.modality} · {entryCount(s)}{" "}
                  {entryCount(s) === 1 ? "entry" : "entries"}
                </div>
              </div>
              <span className="text-xs text-neutral-400 transition-transform group-open:rotate-90">
                ›
              </span>
            </summary>
            <div className="border-t border-neutral-200 bg-neutral-50/50 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900/40">
              {s.modality === "electrolysis" ? (
                <ElectrolysisEntryList entries={s.electrolysis_entries} />
              ) : (
                <LaserEntryList entries={s.laser_entries} />
              )}
              <div className="mt-3">
                <Link
                  href={`/clients/${clientId}/sessions/${s.id}`}
                  className="text-xs font-medium text-neutral-700 hover:underline dark:text-neutral-300"
                >
                  Open session →
                </Link>
              </div>
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}

export function ElectrolysisEntryList({
  entries,
}: {
  entries: SessionWithEntries["electrolysis_entries"];
}) {
  if (entries.length === 0) {
    return <p className="text-xs text-neutral-500">No entries.</p>;
  }
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {entries.map((e) => (
        <li
          key={e.id}
          className="rounded-md border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-950"
        >
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-medium">{e.area}</span>
            {e.probe_size && (
              <span className="text-xs text-neutral-500">probe {e.probe_size}</span>
            )}
            {e.mode && (
              <span className="text-xs text-neutral-500">{e.mode}</span>
            )}
            {e.intensity != null && (
              <span className="text-xs text-neutral-500">int {e.intensity}</span>
            )}
            {e.duration_seconds != null && (
              <span className="text-xs text-neutral-500">
                {e.duration_seconds}s
              </span>
            )}
          </div>
          {e.comments && (
            <div className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
              {e.comments}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function LaserEntryList({
  entries,
}: {
  entries: SessionWithEntries["laser_entries"];
}) {
  if (entries.length === 0) {
    return <p className="text-xs text-neutral-500">No entries.</p>;
  }
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {entries.map((e) => {
        const params = (e.equipment_params ?? {}) as Record<string, unknown>;
        return (
          <li
            key={e.id}
            className="rounded-md border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-950"
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-medium">{e.zone}</span>
              {e.session_number != null && (
                <span className="text-xs text-neutral-500">
                  #{e.session_number}
                </span>
              )}
              {typeof params.fluence === "string" && params.fluence && (
                <span className="text-xs text-neutral-500">
                  fluence {params.fluence}
                </span>
              )}
              {typeof params.pulse_width === "string" && params.pulse_width && (
                <span className="text-xs text-neutral-500">
                  pw {params.pulse_width}
                </span>
              )}
              {typeof params.spot_size === "string" && params.spot_size && (
                <span className="text-xs text-neutral-500">
                  spot {params.spot_size}
                </span>
              )}
            </div>
            {e.observation_notes && (
              <div className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
                {e.observation_notes}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
