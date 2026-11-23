import { createClient } from "@/lib/supabase/server";
import { requireReceptionistWithStudio } from "@/lib/desk/guard";
import { DESK_NAME_ON_FILE, DeskScheduleIncompleteError, readDeskSchedule, type DeskRpc, type DeskScheduleRow } from "@/lib/desk/read";
import { formatStudioDateTime, formatStudioTime } from "@/lib/desk/time";
import { ClockFallbackNotice } from "./ClockFallbackNotice";

// The desk schedule, read only: when, which service, which practitioner, and for every client the words "Name on
// file". No client name of any kind is shown. No notes, prices, payment state, status reasons, intake, consent or contact.
// Nothing links anywhere and nothing here writes. This shows less than the database could return; it is a display
// rule, not a privacy control (see lib/desk/read.ts).
//
// The window is the next seven days from now and the last twelve hours, in the STUDIO's clock.

export const dynamic = "force-dynamic";

const BACK_HOURS = 12;
const AHEAD_DAYS = 7;

export default async function DeskSchedulePage() {
  // The layout's guard does not stop this page from running: it resolves identity itself.
  const identity = await requireReceptionistWithStudio();
  const now = Date.now();
  let rows: DeskScheduleRow[] | null = null;
  let incomplete = false;
  try {
    const supabase = (await createClient()) as unknown as DeskRpc;
    rows = await readDeskSchedule(supabase, identity.studioId, new Date(now - BACK_HOURS * 3_600_000).toISOString(), new Date(now + AHEAD_DAYS * 86_400_000).toISOString());
  } catch (e) {
    rows = null;
    incomplete = e instanceof DeskScheduleIncompleteError;
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Schedule</h1>
        <p className="mt-1 text-sm text-neutral-500">The next seven days. Client names are not shown on this desk yet; every client reads &ldquo;{DESK_NAME_ON_FILE}&rdquo;.</p>
      </div>
      {rows !== null && <ClockFallbackNotice timezones={rows.map((r) => r.studioTimezone)} />}
      {incomplete ? (
        <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-6 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Schedule incomplete &mdash; too many appointments to show here.
        </p>
      ) : rows === null ? (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-6 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          The schedule is unavailable right now. Try again in a moment.
        </p>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700">No appointments in this window.</p>
      ) : (
        <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {rows.map((r, i) => (
            <li key={i} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="font-medium">{r.clientName}</div>
                <div className="text-xs text-neutral-600 dark:text-neutral-400">
                  {r.serviceName}
                  {r.durationMinutes ? ` (${r.durationMinutes} min)` : ""} · {r.practitionerName}
                </div>
              </div>
              <div className="text-xs text-neutral-600 dark:text-neutral-400">
                {formatStudioDateTime(r.startsAt, r.studioTimezone)} – {formatStudioTime(r.endsAt, r.studioTimezone)}
                {r.status !== "confirmed" && <span className="ml-2 uppercase tracking-wider text-neutral-500">{r.status.replace("_", " ")}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
