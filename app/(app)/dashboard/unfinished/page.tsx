import Link from "next/link";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { loadUnfinishedPage, parseUnfinishedPage, UNFINISHED_VIEW_ALL_HREF } from "@/lib/dashboard/unfinished-visits";
import { unfinishedTotalLabel } from "../unfinished-visits-note";

// HON-45: every charted visit that has ended but is not yet finished, newest first, paginated. Links to each visit's session page
// (where the explicit Finish appointment control lives). It reads only: it completes, sends and charges nothing.
export const dynamic = "force-dynamic";

function fmt(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

export default async function UnfinishedVisitsPage({ searchParams }: { searchParams: Promise<{ page?: string | string[] }> }) {
  const { studio } = await requirePractitionerWithStudio();
  const sp = await searchParams;
  const page = parseUnfinishedPage(sp.page);
  let result: Awaited<ReturnType<typeof loadUnfinishedPage>> | null = null;
  try {
    result = await loadUnfinishedPage(studio.id, new Date().toISOString(), page);
  } catch {
    result = null;
  }
  const href = (p: number) => `${UNFINISHED_VIEW_ALL_HREF}?page=${p}`;
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      <p className="text-sm"><Link href="/dashboard" className="underline underline-offset-2">Back to dashboard</Link></p>
      <h1 className="mt-2 text-xl font-semibold">Visits not finished</h1>
      {result === null ? (
        <p data-testid="unfinished-list-unavailable" className="mt-4 text-sm">Could not load the list. Nothing was changed. Reload to try again.</p>
      ) : result.total === 0 ? (
        <p data-testid="unfinished-list-empty" className="mt-4 text-sm">No visits are waiting to be finished.</p>
      ) : (
        <>
          <p data-testid="unfinished-list-total" className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">
            {unfinishedTotalLabel(result.total)}. Page {result.page} of {result.pageCount}. Opening a visit does not finish, send or charge anything.
          </p>
          <ul data-testid="unfinished-list" className="mt-4 divide-y divide-neutral-200 dark:divide-neutral-800">
            {result.rows.map((r) => (
              <li key={r.appointmentId} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div>
                  <p className="font-medium">{r.clientName}</p>
                  <p className="text-xs text-neutral-500">Ended {fmt(r.endsAt, studio.timezone)}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900">Not finished</span>
                  <Link href={`/clients/${r.clientId}/sessions/${r.sessionId}`} className="text-sm underline underline-offset-2">Finish visit</Link>
                </div>
              </li>
            ))}
          </ul>
          <nav aria-label="Pages" className="mt-4 flex gap-4 text-sm">
            {result.page > 1 && <Link data-testid="unfinished-prev" href={href(result.page - 1)} className="underline underline-offset-2">Previous</Link>}
            {result.page < result.pageCount && <Link data-testid="unfinished-next" href={href(result.page + 1)} className="underline underline-offset-2">Next</Link>}
          </nav>
        </>
      )}
    </main>
  );
}
