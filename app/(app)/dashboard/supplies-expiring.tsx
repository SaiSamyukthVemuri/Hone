import Link from "next/link";
import { supplyExpiryState } from "@/lib/record-keeping/expiry";

// PR #316 (Chloe feedback): a small, studio-scoped dashboard attention card for
// sterile items / probe lots that are expired or expiring within 30 days.
// Presentational only — the items are fetched studio-scoped in the dashboard
// page. No email/SMS/push, no cron; just a calm on-dashboard reminder linking to
// Records. Renders nothing when there is nothing expiring (no clutter).

export type ExpiringSupply = {
  id: string;
  item_description: string;
  manufacturer_name: string;
  expiry_date: string | null;
};

function fmt(d: string | null): string {
  if (!d) return "";
  const parsed = new Date(`${d.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? d
    : parsed.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
}

export function SuppliesExpiringCard({
  items,
  today,
}: {
  items: ReadonlyArray<ExpiringSupply>;
  today: string;
}) {
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <div>
        <h2 className="text-lg font-medium">Supplies expiring</h2>
        <p className="text-sm text-neutral-500">
          Sterile items and probe lots expired or expiring within 30 days.
        </p>
      </div>
      <ul className="flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
        {items.map((it) => {
          const state = supplyExpiryState(it.expiry_date, today);
          const expired = state === "expired";
          return (
            <li
              key={it.id}
              className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <div className="min-w-0 flex-1 basis-64">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="break-words font-medium text-neutral-900 dark:text-neutral-100">
                    {it.item_description}
                  </span>
                  <span
                    className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                      expired
                        ? "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200"
                        : "bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200"
                    }`}
                  >
                    {expired ? "Expired" : "Expires soon"}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-neutral-600 dark:text-neutral-400">
                  {expired ? "Expired" : "Expires"} {fmt(it.expiry_date)}
                  {it.manufacturer_name ? ` · ${it.manufacturer_name}` : ""}
                </p>
              </div>
              <Link
                href="/records?section=sterile"
                className="self-center rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:border-neutral-900 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-100 dark:hover:bg-neutral-900"
              >
                Open records
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
