"use client";

import { useActionState } from "react";
import { bookFrontDeskAppointmentAction, type FrontDeskActionState } from "@/lib/receptionist/scheduling-actions";

// STUDIO-READY-02c (#824): the front desk's booking form. It only collects
// choices; the receptionist command decides (availability, conflicts, buffers,
// eligibility) and its answer is shown as returned.

type Option = { id: string; name: string };

const INPUT =
  "w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950";

export function FrontDeskBookingForm({
  clients,
  services,
  practitioners,
  defaultDate,
  timezone,
}: {
  clients: Array<Option & { phone: string | null }>;
  services: Array<Option & { durationMinutes: number }>;
  practitioners: Option[];
  defaultDate: string;
  timezone: string;
}) {
  const [state, action, pending] = useActionState<FrontDeskActionState, FormData>(bookFrontDeskAppointmentAction, null);

  return (
    <form action={action} className="flex flex-col gap-4" aria-label="Book an appointment">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Client</span>
        <select name="client_id" required className={INPUT} defaultValue="">
          <option value="" disabled>
            {clients.length === 0 ? "Search for a client above" : "Choose a client"}
          </option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.phone ? ` · ${c.phone}` : ""}
            </option>
          ))}
        </select>
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Service</span>
          <select name="service_id" required className={INPUT} defaultValue="">
            <option value="" disabled>
              Choose a service
            </option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.durationMinutes} min)
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Practitioner</span>
          <select name="practitioner_id" required className={INPUT} defaultValue="">
            <option value="" disabled>
              Choose a practitioner
            </option>
            {practitioners.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Date</span>
          <input type="date" name="date" required defaultValue={defaultDate} className={INPUT} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Time ({timezone})</span>
          <input type="time" name="time" required step={900} className={INPUT} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {pending ? "Booking…" : "Book appointment"}
        </button>
        {state && (
          <p role="status" className={`text-sm ${state.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>
            {state.message}
          </p>
        )}
      </div>
    </form>
  );
}
