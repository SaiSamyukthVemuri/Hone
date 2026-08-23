import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { localLongDate } from "@/lib/booking/tz";
import { removeWaitlistEntryAction } from "./actions";

// ===========================================================================
// NEW-CLIENT WAITLIST — OPERATOR QUEUE (WAIT-02)
// ===========================================================================
//
// THE JOB THIS DOES. Before WAIT-02 the studio's waitlist was an inbox, so
// "who is waiting, how long, and can I take someone off?" meant scrolling
// email. This page answers exactly those three questions against the durable
// record and stops there.
//
// WHAT IT IS NOT. No invite, no "next N", no queue position shown to anyone,
// no ranking, no capacity forecast, no appointment creation, no contact
// editing, no notes. Those are WAIT-03 / ADMIT-01..03 and none of them are
// reachable from here — the database refuses every transition except
// waiting -> removed, so this surface could not grow one by accident.
//
// PEOPLE HERE ARE NOT CLIENTS. Nothing on this page links into a client
// record, because no client record exists: joining a waitlist creates none.
// That is why it does not live under /clients.
//
// AUTHORITY IS OWNER, THREE TIMES OVER. The route checks the role, the RLS
// policy on the table is `is_studio_owner`, and the removal command re-derives
// membership AND role in the database from the authenticated user id. A member
// who reaches this URL sees the denial card, and would see nothing even if the
// card were removed.
//
// ORDERING IS A TOTAL ORDER. (joined_at, id). Two people who submit in the
// same millisecond still have one stable, repeatable position, so the list
// does not shuffle between renders — and the index backing it is declared in
// exactly that column order.
// ===========================================================================

/**
 * One bounded page of the active queue. This is a display bound, NOT the size
 * of the queue: `count` below is a separate authoritative count over the whole
 * filtered set, so a studio with more waiting people than this is told the real
 * number and told that the list is truncated. Reading `data.length` as the
 * queue size is exactly the lie this split exists to prevent.
 */
const QUEUE_PAGE_SIZE = 100;

type WaitlistRow = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  joined_at: string;
};

function DenialCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-6 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
      {children}
    </div>
  );
}

/** Whole days between joining and now, floored. "0 days" is a valid answer. */
function daysWaiting(joinedAtIso: string, now: number): number {
  const joined = new Date(joinedAtIso).getTime();
  if (!Number.isFinite(joined)) return 0;
  return Math.max(0, Math.floor((now - joined) / 86_400_000));
}

function ageLabel(days: number): string {
  if (days === 0) return "Today";
  return `${days} day${days === 1 ? "" : "s"}`;
}

export default async function WaitlistSettingsPage() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();

  if (practitioner.role !== "owner") {
    return <DenialCard>Only studio owners can see the new-client waitlist.</DenialCard>;
  }

  // RLS-scoped user client, NOT the service-role client: the read is genuinely
  // gated by `is_studio_owner` at the database rather than by this page having
  // remembered to filter. The explicit studio filter is defence in depth and
  // the leading column of the queue index.
  //
  // ONE query, bounded and ordered. No per-row follow-up read exists or could:
  // every column rendered below comes from this select.
  const supabase = await createClient();
  const { data, count, error } = await supabase
    .from("new_client_waitlist_entries")
    .select("id,name,email,phone,joined_at", { count: "exact" })
    .eq("studio_id", studio.id)
    .eq("status", "waiting")
    .order("joined_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(QUEUE_PAGE_SIZE);

  if (error) {
    // Say so plainly instead of rendering an empty queue, which would read as
    // "nobody is waiting" — the one wrong answer this page can give.
    console.error(
      JSON.stringify({
        event: "waitlist_queue_load_failed",
        studioId: studio.id,
        code: error.code ?? "unknown",
        timestamp: new Date().toISOString(),
      }),
    );
    return (
      <DenialCard>
        The waitlist could not be loaded. Please refresh; if this continues,
        contact support rather than assuming the list is empty.
      </DenialCard>
    );
  }

  const rows = (data ?? []) as WaitlistRow[];
  // The authoritative total, from the count query — never `rows.length`, which
  // is capped at QUEUE_PAGE_SIZE.
  const waiting = count ?? rows.length;
  const truncated = rows.length < waiting;
  const now = Date.now();

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="text-xl font-medium">Waitlist</h2>
        <p className="mt-1 text-sm text-neutral-500">
          New clients who asked to be contacted while new-client booking is by
          waitlist. They are not clients yet: nothing here has an appointment,
          an intake form or a record.
        </p>
      </section>

      <p className="text-sm font-medium" aria-live="polite">
        Waiting: <span className="tabular-nums">{waiting}</span>
      </p>

      {waiting === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-6 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
          Nobody is waiting right now. New-client requests from your booking
          page will appear here.
        </div>
      ) : (
        <>
          {truncated && (
            <p className="text-sm text-neutral-500">
              Showing the {rows.length} longest-waiting of {waiting}.
            </p>
          )}
          {/* One card per person, stacking naturally on a phone: no horizontal
              table to scroll at 390px, and every contact detail is selectable
              text so it can be copied straight into an email or a phone app. */}
          <ul className="flex flex-col gap-3">
            {rows.map((row) => {
              const days = daysWaiting(row.joined_at, now);
              return (
                <li
                  key={row.id}
                  className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="font-medium break-words">{row.name}</p>
                    <p className="text-sm break-all text-neutral-600 dark:text-neutral-400">
                      {row.email}
                    </p>
                    {row.phone && (
                      <p className="text-sm text-neutral-600 dark:text-neutral-400">
                        {row.phone}
                      </p>
                    )}
                    <p className="text-sm text-neutral-500">
                      Joined {localLongDate(new Date(row.joined_at), studio.timezone)}
                      {" · "}
                      <span className="tabular-nums">{ageLabel(days)}</span> waiting
                      {" · "}
                      Waiting
                    </p>
                  </div>

                  {/* Two-step removal with no client JavaScript: the confirm
                      button does not exist in the DOM until the disclosure is
                      opened, so a mis-tap on a phone cannot remove someone.
                      Removal is terminal — the row keeps its history, but it
                      does not come back to this queue. */}
                  <details className="shrink-0">
                    <summary className="min-h-[44px] cursor-pointer list-none rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-700 select-none hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900">
                      Remove
                    </summary>
                    <form action={removeWaitlistEntryAction} className="mt-2 flex flex-col gap-2">
                      <input type="hidden" name="entry_id" value={row.id} />
                      <p className="text-sm text-neutral-500">
                        Take {row.name} off the waitlist? This cannot be undone
                        from here.
                      </p>
                      <button
                        type="submit"
                        className="min-h-[44px] rounded-md border border-red-300 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-700/50 dark:text-red-300 dark:hover:bg-red-950/30"
                      >
                        Confirm removal
                      </button>
                    </form>
                  </details>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
