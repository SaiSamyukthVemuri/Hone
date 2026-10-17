import Link from "next/link";
import { PendingContainerLink } from "@/components/pending-link";
import { resolvePractitionerColor } from "@/lib/practitioner-colors";
import type { ScopePractitioner } from "@/lib/booking/practitioner-availability";

// Owner-only schedule scope selector (flag ON). Server-rendered links; the
// selected scope is re-validated on the server on every navigation, so a
// tampered ?practitioner= id simply falls back to Studio default.
export function ScopeSelector({
  practitioners,
  selected,
}: {
  practitioners: ScopePractitioner[];
  selected: string | null;
}) {
  const base = "/settings/availability";
  const chip = (active: boolean) =>
    [
      "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors",
      active
        ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
        : "border-neutral-300 text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800",
    ].join(" ");

  return (
    <nav aria-label="Schedule scope" className="flex flex-col gap-2">
      <p className="text-sm text-neutral-500">
        Set your studio&rsquo;s normal hours, then customize only the
        practitioners who work different schedules.
      </p>
      <div className="flex flex-wrap gap-2">
        <PendingContainerLink
          href={base}
          className={chip(selected === null)}
          pendingLabel="Loading schedule…"
          aria-current={selected === null ? "page" : undefined}
        >
          Studio default
        </PendingContainerLink>
        {practitioners.map((p) => {
          const active = selected === p.id;
          const color = resolvePractitionerColor(p.color);
          return (
            <PendingContainerLink
              key={p.id}
              href={`${base}?practitioner=${encodeURIComponent(p.id)}`}
              className={chip(active)}
              pendingLabel="Loading schedule…"
              aria-current={active ? "page" : undefined}
            >
              <span
                aria-hidden="true"
                className={`h-2.5 w-2.5 rounded-full ${color.bg}`}
              />
              {p.display_name}
            </PendingContainerLink>
          );
        })}
      </div>
    </nav>
  );
}
