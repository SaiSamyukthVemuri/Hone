"use client";

import { useActionState, useState } from "react";
import { FormattedDateTime } from "@/components/formatted-date-time";
import type { DeskClientRow, DeskDirectoryPage, DeskIntake } from "@/lib/desk/read";
import { DESK_MAX_QUERY_LENGTH, DESK_MIN_QUERY_FOR_PAGING } from "@/lib/desk/read";
import { searchDeskClientsAction, type DeskDirectoryState } from "./actions";

// The desk directory's interactive half. State lives HERE and in the action result, never in the URL
// (Privacy R5). Nothing links to a practitioner page (R6): the intake status is plain text, a client
// opens an overview in place, and the only anchors are mailto: and tel:.

const INTAKE_LABEL: Record<DeskIntake, string> = {
  not_submitted: "Intake not submitted",
  awaiting_review: "Intake awaiting review",
  reviewed: "Intake reviewed",
  unavailable: "Intake unavailable",
};

function ConsentText({ signed }: { signed: boolean | null }) {
  if (signed === null) return <>Consent unavailable</>;
  // Privacy F2: strict. Treatment-consent templates only; the label claims no more than that.
  return <>{signed ? "Consent on file" : "Consent needed"}</>;
}

export function DeskDirectory({ initial }: { initial: DeskDirectoryPage | null }) {
  const [state, action, pending] = useActionState<DeskDirectoryState, FormData>(
    searchDeskClientsAction,
    initial
      ? { status: "ok", input: { q: "", filters: [], sort: "name", page: 1 }, data: initial }
      : { status: "unavailable" },
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const data = state.status === "ok" ? state.data : null;
  const input =
    state.status === "ok" || state.status === "too_short"
      ? state.input
      : { q: "", filters: [], sort: "name" as const, page: 1 };
  const open = data?.rows.find((r) => r.id === openId) ?? null;
  const canPage = input.q.length >= DESK_MIN_QUERY_FOR_PAGING;

  return (
    <div className="flex flex-col gap-4">
      <form
        action={action}
        aria-busy={pending}
        className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
      >
        <div className="flex gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-400">
            Search clients
            <input
              type="search"
              name="q"
              defaultValue={input.q}
              maxLength={DESK_MAX_QUERY_LENGTH}
              placeholder="Name, email or phone"
              autoComplete="off"
              className="min-h-11 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-normal text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            />
          </label>
          {/* First submit button: Enter in the field searches from page 1. */}
          <button
            type="submit"
            name="page"
            value="1"
            className="min-h-11 min-w-11 self-end rounded-md bg-neutral-900 px-4 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
          >
            Search
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <fieldset className="flex flex-wrap items-center gap-3">
            <legend className="sr-only">Filters</legend>
            <label className="flex min-h-11 items-center gap-2">
              <input type="checkbox" name="filter" value="intake_review" defaultChecked={input.filters.includes("intake_review")} />
              Intake awaiting review
            </label>
            <label className="flex min-h-11 items-center gap-2">
              <input type="checkbox" name="filter" value="no_upcoming" defaultChecked={input.filters.includes("no_upcoming")} />
              No upcoming appointment
            </label>
          </fieldset>
          <fieldset className="flex items-center gap-3">
            <legend className="sr-only">Sort by</legend>
            <label className="flex min-h-11 items-center gap-2">
              <input type="radio" name="sort" value="name" defaultChecked={input.sort === "name"} />
              Name
            </label>
            <label className="flex min-h-11 items-center gap-2">
              <input type="radio" name="sort" value="next" defaultChecked={input.sort === "next"} />
              Next appointment
            </label>
          </fieldset>
        </div>
        <p className="text-xs text-neutral-500">Searches the names shown, email and phone. Type at least {DESK_MIN_QUERY_FOR_PAGING} characters to see more than the first page.</p>

        {state.status === "too_short" && (
          <p role="status" className="text-sm text-neutral-700 dark:text-neutral-300">
            Type at least {DESK_MIN_QUERY_FOR_PAGING} characters to search.
          </p>
        )}
        {state.status === "unavailable" && (
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            The client list is unavailable right now. Try again in a moment.
          </p>
        )}

        {data && (
          <>
            <p className="text-sm text-neutral-600 dark:text-neutral-400" aria-live="polite">
              {data.total} {data.total === 1 ? "match" : "matches"}
              {data.capped && " · showing the first results, refine the search to narrow them"}
            </p>
            {data.rows.length === 0 ? (
              <p className="rounded-lg border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
                No clients match.
              </p>
            ) : (
              <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
                {data.rows.map((r) => (
                  <li key={r.id} className={`px-4 py-3 ${r.id === openId ? "border-l-4 border-neutral-900 bg-neutral-50 pl-3 dark:border-white dark:bg-neutral-900" : ""}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <button
                          type="button"
                          onClick={() => setOpenId(r.id === openId ? null : r.id)}
                          aria-expanded={r.id === openId}
                          className="inline-flex min-h-11 items-center text-left font-medium hover:underline"
                        >
                          {r.displayName}
                        </button>
                        {r.nameOnFile && <div className="text-[11px] text-neutral-500">Name on file</div>}
                      </div>
                      <div className="text-xs text-neutral-600 dark:text-neutral-400">
                        {[r.email, r.phone].filter(Boolean).join(" · ") || "No contact on file"}
                      </div>
                    </div>
                    {r.id === openId && open && <Overview row={open} />}
                  </li>
                ))}
              </ul>
            )}
            {data.pageCount > 1 && canPage && (
              <nav aria-label="Client list pages" className="flex items-center justify-between text-sm">
                {data.page > 1 ? (
                  <button type="submit" name="page" value={data.page - 1} className="min-h-11 rounded-md border border-neutral-300 px-3 dark:border-neutral-700">
                    Previous
                  </button>
                ) : <span />}
                <span className="text-neutral-500">Page {data.page} of {data.pageCount}</span>
                {data.page < data.pageCount ? (
                  <button type="submit" name="page" value={data.page + 1} className="min-h-11 rounded-md border border-neutral-300 px-3 dark:border-neutral-700">
                    Next
                  </button>
                ) : <span />}
              </nav>
            )}
          </>
        )}
      </form>
    </div>
  );
}

function Overview({ row }: { row: DeskClientRow }) {
  return (
    <section aria-label={`Overview for ${row.displayName}`} className="mt-3 rounded-lg border border-neutral-300 p-4 dark:border-neutral-700">
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-neutral-500">Email</dt>
          <dd>{row.email ? <a className="underline" href={`mailto:${encodeURIComponent(row.email)}`}>{row.email}</a> : "None on file"}</dd>
        </div>
        <div>
          <dt className="text-xs text-neutral-500">Phone</dt>
          <dd>{row.phone ? <a className="underline" href={`tel:${row.phone.replace(/[^+\d]/g, "")}`}>{row.phone}</a> : "None on file"}</dd>
        </div>
        <div>
          <dt className="text-xs text-neutral-500">Next appointment</dt>
          <dd>{row.nextAppointmentAt ? <FormattedDateTime iso={row.nextAppointmentAt} /> : "No upcoming appointment"}</dd>
        </div>
        <div>
          <dt className="text-xs text-neutral-500">Last completed appointment</dt>
          <dd>
            {row.lastCompleted.state === "at"
              ? row.lastCompleted.on
              : row.lastCompleted.state === "none"
                ? "No completed appointment in Hone"
                : "Unavailable"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-neutral-500">Forms</dt>
          <dd>
            {INTAKE_LABEL[row.intake]} · <ConsentText signed={row.consentSigned} />
          </dd>
        </div>
      </dl>
    </section>
  );
}
