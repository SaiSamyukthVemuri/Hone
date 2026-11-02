"use client";

import { useActionState, useState } from "react";
import type { BookingOptions } from "@/lib/desk/book";
import type { DeskClientRow } from "@/lib/desk/read";
import { DESK_MAX_QUERY_LENGTH, DESK_MIN_QUERY_FOR_PAGING } from "@/lib/desk/read";
import { searchDeskClientsAction, type DeskDirectoryState } from "@/app/(desk)/desk/clients/actions";
import { bookAppointmentAction, type DeskActionState } from "../actions";

// Book an appointment for a client (Sam, 1 Nov). Three steps on one screen, all state local and in
// server-action bodies, never in a URL (Privacy R5): find the client (the restricted directory
// search), choose service, practitioner and a date and time in the STUDIO's zone, confirm. The
// database decides availability and eligibility; this form only collects and reports. No price, no
// notes, no clinical field, no free text beyond the search term.

const field = "min-h-11 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-normal text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100";
const label = "flex flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-400";

export function BookForm({ options, timezone }: { options: BookingOptions; timezone: string }) {
  const [found, search, searching] = useActionState<DeskDirectoryState, FormData>(searchDeskClientsAction, { status: "idle" });
  const [result, book, booking] = useActionState<DeskActionState, FormData>(bookAppointmentAction, { status: "idle" });
  const [chosen, setChosen] = useState<DeskClientRow | null>(null);
  const rows = found.status === "ok" ? found.data.rows : [];
  const noOptions = options.services.length === 0 || options.practitioners.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="book-client" className="flex flex-col gap-3">
        <h2 id="book-client" className="text-base font-semibold">1. Client</h2>
        {chosen ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-300 px-4 py-3 dark:border-neutral-700">
            <div>
              <div className="font-medium">
                {chosen.displayName}
                {chosen.nameOnFile && <span className="ml-2 text-[11px] font-normal text-neutral-500">Name on file</span>}
              </div>
              <div className="text-xs text-neutral-600 dark:text-neutral-400">{[chosen.email, chosen.phone].filter(Boolean).join(" · ") || "No contact on file"}</div>
            </div>
            <button type="button" onClick={() => setChosen(null)} className="inline-flex min-h-11 items-center rounded-md border border-neutral-300 px-3 text-sm dark:border-neutral-700">
              Change client
            </button>
          </div>
        ) : (
          <>
            <form action={search} aria-busy={searching} className="flex gap-2">
              <label className={`${label} min-w-0 flex-1`}>
                Search clients
                <input type="search" name="q" maxLength={DESK_MAX_QUERY_LENGTH} placeholder="Name, email or phone" autoComplete="off" className={field} />
              </label>
              <input type="hidden" name="page" value="1" />
              <button type="submit" className="min-h-11 min-w-11 self-end rounded-md bg-neutral-900 px-4 text-sm font-medium text-white dark:bg-white dark:text-neutral-900">
                Search
              </button>
            </form>
            {found.status === "too_short" && <p role="status" className="text-sm">Type at least {DESK_MIN_QUERY_FOR_PAGING} characters to search.</p>}
            {found.status === "unavailable" && <p role="alert" className="text-sm text-red-800 dark:text-red-200">The client list is unavailable right now. Try again in a moment.</p>}
            {found.status === "ok" && rows.length === 0 && <p className="text-sm text-neutral-500">No clients match.</p>}
            {rows.length > 0 && (
              <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
                {rows.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2">
                    <div className="min-w-0 text-sm">
                      <div className="font-medium">
                        {r.displayName}
                        {r.nameOnFile && <span className="ml-2 text-[11px] font-normal text-neutral-500">Name on file</span>}
                      </div>
                      <div className="text-xs text-neutral-600 dark:text-neutral-400">{[r.email, r.phone].filter(Boolean).join(" · ") || "No contact on file"}</div>
                    </div>
                    <button type="button" onClick={() => setChosen(r)} className="inline-flex min-h-11 items-center rounded-md border border-neutral-300 px-3 text-sm dark:border-neutral-700">
                      Choose
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <form action={book} aria-busy={booking} className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">2. Service, practitioner and time</h2>
        <input type="hidden" name="clientId" value={chosen?.id ?? ""} />
        {noOptions && <p role="alert" className="text-sm text-red-800 dark:text-red-200">This studio has no bookable services or practitioners yet.</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={label}>
            Service
            <select name="serviceId" required defaultValue="" className={field}>
              <option value="" disabled>Choose a service</option>
              {options.services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}{s.durationMinutes ? ` (${s.durationMinutes} min)` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            Practitioner
            <select name="practitionerId" required defaultValue="" className={field}>
              <option value="" disabled>Choose a practitioner</option>
              {options.practitioners.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <label className={label}>
            Date
            <input type="date" name="date" required className={field} />
          </label>
          <label className={label}>
            Start time
            <input type="time" name="time" required step={300} className={field} />
          </label>
        </div>
        <p className="text-xs text-neutral-500">Times are in the studio&apos;s clock ({timezone}). The studio&apos;s own availability rules decide whether a time can be booked.</p>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={!chosen || booking || noOptions}
            className="inline-flex min-h-11 items-center rounded-md bg-neutral-900 px-5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {booking ? "Booking…" : "Book appointment"}
          </button>
          {!chosen && <span className="text-xs text-neutral-500">Choose a client first.</span>}
        </div>
        {result.status === "ok" && <p role="status" className="text-sm text-emerald-800 dark:text-emerald-300">{result.message} It is on the schedule.</p>}
        {result.status === "error" && <p role="alert" className="text-sm text-red-800 dark:text-red-200">{result.message}</p>}
      </form>
    </div>
  );
}
