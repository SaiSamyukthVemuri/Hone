import { createClient } from "@/lib/supabase/server";
import { requireReceptionistWithStudio } from "@/lib/desk/guard";
import { readDeskSchedule, type DeskRpc, type DeskScheduleRow } from "@/lib/desk/read";
import { FormattedDateTime } from "@/components/formatted-date-time";

// The desk schedule: booking information only (Privacy R1, R8). The client is shown by the display
// rule (preferred name, else the stored name labelled "Name on file"); the service name is shown
// (Sam's decision R8, recommended: yes). No notes, prices, payment state, status reasons, intake or
// consent. Nothing here links anywhere (R6): an appointment is plain text.
//
// The window is the next seven days from now (and the last twelve hours). A receptionist cannot read
// the studio row, so the studio's timezone is not available here: times render in this device's
// clock (recorded limitation; a follow-up can return the timezone from the schedule function).

const BACK_HOURS = 12;
const AHEAD_DAYS = 7;

export default async function DeskSchedulePage() {
  // The layout's guard does not stop this page from running: it resolves identity itself.
  const identity = await requireReceptionistWithStudio();
  const now = Date.now();
  let rows: DeskScheduleRow[] | null = null;
  try {
    const supabase = (await createClient()) as unknown as DeskRpc;
    rows = await readDeskSchedule(
      supabase,
      identity.studioId,
      new Date(now - BACK_HOURS * 3_600_000).toISOString(),
      new Date(now + AHEAD_DAYS * 86_400_000).toISOString(),
    );
  } catch {
    rows = null;
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Schedule</h1>
        <p className="mt-1 text-sm text-neutral-500">The next seven days.</p>
      </div>
      {rows === null ? (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-6 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          The schedule is unavailable right now. Try again in a moment.
        </p>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No appointments in this window.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {rows.map((r) => (
            <li key={r.appointmentId} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="font-medium">
                  {r.displayName}
                  {r.nameOnFile && <span className="ml-2 text-[11px] font-normal text-neutral-500">Name on file</span>}
                </div>
                <div className="text-xs text-neutral-600 dark:text-neutral-400">
                  {r.serviceName} · {r.practitionerName}
                </div>
              </div>
              <div className="text-xs text-neutral-600 dark:text-neutral-400">
                <FormattedDateTime iso={r.startsAt} /> – <FormattedDateTime iso={r.endsAt} format="time" />
                {r.status !== "confirmed" && <span className="ml-2 uppercase tracking-wider text-neutral-500">{r.status}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
