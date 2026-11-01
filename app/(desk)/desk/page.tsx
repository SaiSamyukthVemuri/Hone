import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireReceptionistWithStudio } from "@/lib/desk/guard";
import { readDeskSchedule, type DeskRpc, type DeskScheduleRow } from "@/lib/desk/read";
import { readBookingOptions, type BookingPractitioner } from "@/lib/desk/book";
import { formatStudioDateTime, formatStudioTime, localParts } from "@/lib/desk/time";
import { ScheduleRowActions } from "./ScheduleRowActions";

// The desk schedule: booking information only (Privacy R1, R8). The client is shown by the display
// rule (preferred name, else the stored name labelled "Name on file"); the service name is shown
// (Sam's decision R8, recommended: yes). No notes, prices, payment state, status reasons, intake or
// consent. Nothing here links anywhere (R6): an appointment is plain text.
//
// The window is the next seven days from now (and the last twelve hours). Times render in the
// STUDIO's clock (0274 returns the zone with each row), with the service's length beside its name.
// Move and cancel (Sam, 1 Nov) work through the 0220 commands only; a cancelled row is not offered
// them. Appointment identifiers reach the client only as hidden fields of those forms.

const BACK_HOURS = 12;
const AHEAD_DAYS = 7;

export default async function DeskSchedulePage() {
  // The layout's guard does not stop this page from running: it resolves identity itself.
  const identity = await requireReceptionistWithStudio();
  const now = Date.now();
  let rows: DeskScheduleRow[] | null = null;
  let practitioners: BookingPractitioner[] = [];
  try {
    const supabase = (await createClient()) as unknown as DeskRpc;
    rows = await readDeskSchedule(
      supabase,
      identity.studioId,
      new Date(now - BACK_HOURS * 3_600_000).toISOString(),
      new Date(now + AHEAD_DAYS * 86_400_000).toISOString(),
    );
    try {
      practitioners = (await readBookingOptions(supabase, identity.studioId)).practitioners;
    } catch {
      practitioners = [];
    }
  } catch {
    rows = null;
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Schedule</h1>
        <p className="mt-1 flex flex-wrap items-center gap-3 text-sm text-neutral-500">
          <span>The next seven days.</span>
          <Link href="/desk/book" className="inline-flex min-h-11 items-center rounded-md bg-neutral-900 px-4 text-sm font-medium text-white dark:bg-white dark:text-neutral-900">
            Book appointment
          </Link>
        </p>
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
          {rows.map((r) => {
            const tz = r.studioTimezone ?? "UTC";
            const local = localParts(r.startsAt, tz);
            const actionable = r.status === "confirmed" && practitioners.length > 0 && local !== null && r.practitionerId !== null;
            return (
              <li key={r.appointmentId} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="font-medium">
                      {r.displayName}
                      {r.nameOnFile && <span className="ml-2 text-[11px] font-normal text-neutral-500">Name on file</span>}
                    </div>
                    <div className="text-xs text-neutral-600 dark:text-neutral-400">
                      {r.serviceName}
                      {r.durationMinutes ? ` (${r.durationMinutes} min)` : ""} · {r.practitionerName}
                    </div>
                  </div>
                  <div className="text-xs text-neutral-600 dark:text-neutral-400">
                    {formatStudioDateTime(r.startsAt, tz)} – {formatStudioTime(r.endsAt, tz)}
                    {r.status !== "confirmed" && <span className="ml-2 uppercase tracking-wider text-neutral-500">{r.status}</span>}
                  </div>
                </div>
                {actionable && local && (
                  <ScheduleRowActions
                    appointmentId={r.appointmentId}
                    practitionerId={r.practitionerId ?? ""}
                    startsAt={r.startsAt}
                    endsAt={r.endsAt}
                    date={local.date}
                    time={local.time}
                    practitioners={practitioners}
                    timezone={tz}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
