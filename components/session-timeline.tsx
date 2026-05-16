import Link from "next/link";
import {
  sessionPerformerName,
  type SessionWithEntries,
} from "@/lib/supabase/queries";
import type { Practitioner } from "@/lib/types/database";
import { ElectrolysisEntryRow, LaserEntryRow } from "./entry-row";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function entryCount(s: SessionWithEntries): number {
  return s.modality === "electrolysis"
    ? s.electrolysis_entries.length
    : s.laser_entries.length;
}

export function SessionTimeline({
  clientId,
  sessions,
  practitioners,
}: {
  clientId: string;
  sessions: SessionWithEntries[];
  practitioners: Practitioner[];
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
      {sessions.map((s) => {
        const performer = sessionPerformerName(s, practitioners);
        return (
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
                    {performer && ` · ${performer}`}
                    {s.price_paid_cents != null &&
                      ` · ${formatPrice(s.price_paid_cents)} paid`}
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
        );
      })}
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
    <ul className="flex flex-col gap-2">
      {entries.map((e) => (
        <li key={e.id}>
          <ElectrolysisEntryRow entry={e} density="compact" />
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
    <ul className="flex flex-col gap-2">
      {entries.map((e) => (
        <li key={e.id}>
          <LaserEntryRow entry={e} density="compact" />
        </li>
      ))}
    </ul>
  );
}
