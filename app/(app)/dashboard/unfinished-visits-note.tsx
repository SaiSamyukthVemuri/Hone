import Link from "next/link";
import { countUnfinishedVisits, UNFINISHED_VIEW_ALL_HREF } from "@/lib/dashboard/unfinished-visits";

// HON-45: the dashboard's honest total for charted-but-unfinished visits. The attention list below is a short preview; this line
// says how many exist (an exact studio-scoped count, never capped) and links to the full paginated list. A failed read says so.
export function unfinishedTotalLabel(total: number): string {
  return `${total} ${total === 1 ? "visit" : "visits"} not finished`;
}

export async function UnfinishedVisitsNote({ studioId, nowIso }: { studioId: string; nowIso: string }) {
  let total: number;
  try {
    total = await countUnfinishedVisits(studioId, nowIso);
  } catch {
    return (
      <p data-testid="unfinished-total-unavailable" className="text-sm text-neutral-600 dark:text-neutral-300">
        Could not check for unfinished visits. Nothing was changed. Reload to try again.
      </p>
    );
  }
  if (total === 0) return null;
  return (
    <p data-testid="unfinished-total" className="rounded-md bg-neutral-50 px-3 py-2 text-sm text-neutral-700 dark:bg-neutral-900 dark:text-neutral-200">
      <span className="font-medium">{unfinishedTotalLabel(total)}</span>
      {" · "}
      <Link data-testid="unfinished-view-all" href={UNFINISHED_VIEW_ALL_HREF} className="underline underline-offset-2">
        View all
      </Link>
      <span className="ml-2 text-xs text-neutral-500">The list below shows the most recent only.</span>
    </p>
  );
}
