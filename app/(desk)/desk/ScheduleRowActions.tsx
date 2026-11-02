"use client";

import { useActionState, useState } from "react";
import { CANCEL_REASONS, type BookingPractitioner } from "@/lib/desk/book";
import { cancelAppointmentAction, moveAppointmentAction, type DeskActionState } from "./actions";

// Move and cancel one appointment, in place on its schedule row (Sam, 1 Nov). Date and time are
// the STUDIO's clock (prefilled by the server). The row carries only what the schedule already
// shows plus the ids and the appointment's current interval, which the move command uses as its
// stale check. Cancellation takes a reason from a closed list: no free text is stored.

const field = "min-h-11 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100";
const btn = "inline-flex min-h-11 items-center rounded-md border border-neutral-300 px-3 text-sm dark:border-neutral-700";

export function ScheduleRowActions({
  appointmentId,
  practitionerId,
  startsAt,
  endsAt,
  date,
  time,
  practitioners,
  timezone,
}: {
  appointmentId: string;
  practitionerId: string;
  startsAt: string;
  endsAt: string;
  date: string;
  time: string;
  practitioners: BookingPractitioner[];
  timezone: string;
}) {
  const [mode, setMode] = useState<"none" | "move" | "cancel">("none");
  const [moved, move, moving] = useActionState<DeskActionState, FormData>(moveAppointmentAction, { status: "idle" });
  const [cancelled, cancel, cancelling] = useActionState<DeskActionState, FormData>(cancelAppointmentAction, { status: "idle" });
  const done = moved.status === "ok" || cancelled.status === "ok";

  return (
    <div className="flex flex-col gap-2">
      {mode === "none" && !done && (
        <div className="flex gap-2">
          <button type="button" className={btn} onClick={() => setMode("move")}>Move</button>
          <button type="button" className={btn} onClick={() => setMode("cancel")}>Cancel</button>
        </div>
      )}
      {mode === "move" && !done && (
        <form action={move} aria-busy={moving} className="flex flex-col gap-2">
          <input type="hidden" name="appointmentId" value={appointmentId} />
          <input type="hidden" name="expectedStartsAt" value={startsAt} />
          <input type="hidden" name="expectedEndsAt" value={endsAt} />
          <div className="flex flex-wrap gap-2">
            <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
              Date
              <input type="date" name="date" defaultValue={date} required className={field} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
              Start time
              <input type="time" name="time" defaultValue={time} required step={300} className={field} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
              Practitioner
              <select name="practitionerId" defaultValue={practitionerId} className={field}>
                {practitioners.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs text-neutral-500">Studio clock ({timezone}).</p>
          <div className="flex gap-2">
            <button type="submit" disabled={moving} className="inline-flex min-h-11 items-center rounded-md bg-neutral-900 px-4 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900">
              {moving ? "Moving…" : "Move appointment"}
            </button>
            <button type="button" className={btn} onClick={() => setMode("none")}>Keep as is</button>
          </div>
        </form>
      )}
      {mode === "cancel" && !done && (
        <form action={cancel} aria-busy={cancelling} className="flex flex-col gap-2">
          <input type="hidden" name="appointmentId" value={appointmentId} />
          <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
            Reason
            <select name="reason" defaultValue="client_requested" className={field}>
              {Object.entries(CANCEL_REASONS).map(([value, text]) => (
                <option key={value} value={value}>{text}</option>
              ))}
            </select>
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={cancelling} className="inline-flex min-h-11 items-center rounded-md bg-red-700 px-4 text-sm font-medium text-white disabled:opacity-50">
              {cancelling ? "Cancelling…" : "Cancel appointment"}
            </button>
            <button type="button" className={btn} onClick={() => setMode("none")}>Keep appointment</button>
          </div>
        </form>
      )}
      {moved.status === "ok" && <p role="status" className="text-xs text-emerald-800 dark:text-emerald-300">{moved.message}</p>}
      {cancelled.status === "ok" && <p role="status" className="text-xs text-emerald-800 dark:text-emerald-300">{cancelled.message}</p>}
      {moved.status === "error" && <p role="alert" className="text-xs text-red-800 dark:text-red-200">{moved.message}</p>}
      {cancelled.status === "error" && <p role="alert" className="text-xs text-red-800 dark:text-red-200">{cancelled.message}</p>}
    </div>
  );
}
