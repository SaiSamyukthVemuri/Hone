"use client";

import { useActionState } from "react";
import {
  cancelFrontDeskAppointmentAction,
  moveFrontDeskAppointmentAction,
  type FrontDeskActionState,
} from "@/lib/receptionist/scheduling-actions";

// STUDIO-READY-02c (#824): move/reassign or cancel one appointment from the
// front-desk schedule. The expected start/end travel with the form so a change
// made in another window is refused ("stale"), never silently overwritten.

const INPUT =
  "rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950";

function Status({ state }: { state: FrontDeskActionState }) {
  if (!state) return null;
  return (
    <p role="status" className={`text-xs ${state.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>
      {state.message}
    </p>
  );
}

export function FrontDeskAppointmentChange({
  appointment,
  practitioners,
  localDate,
  localTime,
  clientName,
}: {
  appointment: { id: string; startsAt: string; endsAt: string; practitionerId: string | null };
  practitioners: Array<{ id: string; name: string }>;
  localDate: string;
  localTime: string;
  clientName: string;
}) {
  const [moveState, moveAction, moving] = useActionState<FrontDeskActionState, FormData>(moveFrontDeskAppointmentAction, null);
  const [cancelState, cancelAction, cancelling] = useActionState<FrontDeskActionState, FormData>(
    cancelFrontDeskAppointmentAction,
    null,
  );

  return (
    <details className="w-full text-sm">
      <summary className="cursor-pointer select-none text-xs text-neutral-600 underline-offset-4 hover:underline dark:text-neutral-400">
        Change
      </summary>
      <div className="mt-2 flex flex-col gap-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
        <form action={moveAction} className="flex flex-wrap items-end gap-2" aria-label={`Move ${clientName}'s appointment`}>
          <input type="hidden" name="appointment_id" value={appointment.id} />
          <input type="hidden" name="expected_starts_at" value={appointment.startsAt} />
          <input type="hidden" name="expected_ends_at" value={appointment.endsAt} />
          <label className="flex flex-col gap-1 text-xs">
            Date
            <input type="date" name="date" required defaultValue={localDate} className={INPUT} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            Time
            <input type="time" name="time" required step={900} defaultValue={localTime} className={INPUT} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            Practitioner
            <select name="practitioner_id" defaultValue="" className={INPUT}>
              <option value="">Keep current</option>
              {practitioners
                .filter((p) => p.id !== appointment.practitionerId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={moving}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            {moving ? "Moving…" : "Move"}
          </button>
          <Status state={moveState} />
        </form>
        <form action={cancelAction} className="flex flex-wrap items-end gap-2" aria-label={`Cancel ${clientName}'s appointment`}>
          <input type="hidden" name="appointment_id" value={appointment.id} />
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
            Reason (optional, shared with the client)
            <input type="text" name="reason" maxLength={500} className={INPUT} />
          </label>
          <button
            type="submit"
            disabled={cancelling}
            className="rounded-md border border-red-300 px-3 py-1.5 text-xs text-red-800 hover:bg-red-50 disabled:opacity-60 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950"
          >
            {cancelling ? "Cancelling…" : "Cancel appointment"}
          </button>
          <Status state={cancelState} />
        </form>
      </div>
    </details>
  );
}
