import Link from "next/link";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { PendingLink } from "@/components/pending-link";
import { UnarchiveRowControl } from "./UnarchiveRowControl";
import { NAME_ON_FILE_LABEL } from "@/lib/clients/directory-rules";
import {
  directoryHref,
  type DirectoryFilter,
  type DirectoryPage,
  type DirectoryRow,
  type DirectorySort,
  type IntakeState,
} from "@/lib/clients/directory-query";
import { MAX_DIRECTORY_QUERY_LENGTH } from "@/lib/clients/directory-search";

// The clients directory (server component). Every control is a plain GET form or
// link, so search, filters, sort, page, view and the open overview all live in the
// URL: closing the overview or going back restores them. Nothing here filters or
// counts: the page is handed ONE page of rows and the count of the set that
// produced it (lib/clients/directory-query.ts, server-side, whole authorized set).
//
// What is searched (Privacy S8): the names shown, email and phone. No search term
// is ever echoed in a message; the input shows it from the URL.

type View = "active" | "archived";

export type DirectoryState = {
  view: View;
  q: string;
  filters: DirectoryFilter[];
  sort: DirectorySort;
  /** The results page being shown, so a link that opens the overview keeps it (Codex P2 on 4a7e9e8f). */
  page: number;
};

export type LastVisitCell = { kind: "at"; iso: string } | { kind: "none" } | { kind: "unavailable" };

const INTAKE_LABEL: Record<IntakeState, string> = {
  not_submitted: "Not submitted",
  awaiting_review: "Awaiting review",
  reviewed: "Reviewed",
  unavailable: "Unavailable",
};

const INTAKE_TONE: Record<IntakeState, string> = {
  not_submitted: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  awaiting_review: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  reviewed: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  unavailable: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
};

function href(state: DirectoryState, over: { page?: number; client?: string } = {}): string {
  return directoryHref({ ...state, ...over });
}

export function DirectoryControls({ state }: { state: DirectoryState }) {
  const archived = state.view === "archived";
  return (
    <form method="get" action="/clients" className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      {archived && <input type="hidden" name="view" value="archived" />}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-400">
          Search clients
          <input
            type="search"
            name="q"
            defaultValue={state.q}
            maxLength={MAX_DIRECTORY_QUERY_LENGTH}
            placeholder="Name, email or phone"
            autoComplete="off"
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-normal text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-400">
          Sort by
          <select
            name="sort"
            defaultValue={state.sort}
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-normal text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          >
            {archived ? (
              <>
                <option value="archived">Recently archived</option>
                <option value="name">Name</option>
              </>
            ) : (
              <>
                <option value="name">Name</option>
                <option value="next">Next appointment</option>
              </>
            )}
          </select>
        </label>
        <button
          type="submit"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          Apply
        </button>
        <Link href={archived ? "/clients?view=archived" : "/clients"} className="py-2 text-sm text-neutral-600 underline dark:text-neutral-400">
          Clear
        </Link>
      </div>
      {!archived && (
        <fieldset className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <legend className="sr-only">Filters</legend>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="filter" value="intake_review" defaultChecked={state.filters.includes("intake_review")} />
            Intake needs review
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="filter" value="no_upcoming" defaultChecked={state.filters.includes("no_upcoming")} />
            No upcoming appointment
          </label>
        </fieldset>
      )}
      <p className="text-xs text-neutral-500">Searches the names shown, email and phone.</p>
    </form>
  );
}

export function DirectoryResults({
  state,
  data,
  lastVisits,
  selectedId,
}: {
  state: DirectoryState;
  data: DirectoryPage;
  lastVisits: ReadonlyMap<string, string> | null;
  selectedId: string | null;
}) {
  const archived = state.view === "archived";
  const filtered = state.q.length > 0 || state.filters.length > 0;

  if (data.blockedFilters.length > 0) {
    return (
      <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-5 py-8 text-center text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
        We couldn&apos;t check {data.blockedFilters.includes("intake_review") ? "intake status" : "upcoming appointments"} just now, so that
        filter can&apos;t be applied. Remove the filter or try again.
      </div>
    );
  }
  if (data.directoryEmpty) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-5 py-10 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
        {archived ? "No archived clients." : "No clients yet."}
      </div>
    );
  }
  if (data.total === 0) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-5 py-10 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
        No clients match.{" "}
        {filtered && (
          <Link href={archived ? "/clients?view=archived" : "/clients"} className="underline">
            Clear search and filters
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {(data.nextUnavailable || data.intakeUnavailable) && !archived && (
        <p role="status" className="text-xs text-amber-700 dark:text-amber-300">
          Some details couldn&apos;t be loaded and are marked Unavailable.
        </p>
      )}
      {data.sortDegraded && (
        <p role="status" className="text-xs text-amber-700 dark:text-amber-300">
          Next appointments are unavailable, so the list is sorted by name.
        </p>
      )}
      <p className="text-sm text-neutral-600 dark:text-neutral-400" aria-live="polite">
        {filtered ? `${data.total} ${data.total === 1 ? "match" : "matches"}` : `${data.total} ${data.total === 1 ? "client" : "clients"}`}
        {` · showing ${data.firstIndex}–${data.lastIndex}`}
      </p>
      <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {data.rows.map((row) => (
          <DirectoryRowView key={row.id} row={row} state={state} lastVisits={lastVisits} selected={row.id === selectedId} />
        ))}
      </ul>
      <Pagination state={state} data={data} />
    </div>
  );
}

function NextCell({ row }: { row: DirectoryRow }) {
  if (row.next.state === "scheduled") return <FormattedDateTime iso={row.next.startsAt} />;
  if (row.next.state === "none") return <span>No upcoming appointment</span>;
  return <span className="text-neutral-500">Unavailable</span>;
}

export function LastVisitText({ cell }: { cell: LastVisitCell }) {
  if (cell.kind === "at") return <FormattedDateTime iso={cell.iso} format="date" />;
  if (cell.kind === "none") return <span>No visit recorded</span>;
  return <span className="text-neutral-500">Unavailable</span>;
}

export function lastVisitCell(map: ReadonlyMap<string, string> | null, id: string): LastVisitCell {
  if (map === null) return { kind: "unavailable" };
  const at = map.get(id);
  return at ? { kind: "at", iso: at } : { kind: "none" };
}

function IntakePill({ state }: { state: IntakeState }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${INTAKE_TONE[state]}`}>
      {INTAKE_LABEL[state]}
    </span>
  );
}

function DirectoryRowView({
  row,
  state,
  lastVisits,
  selected,
}: {
  row: DirectoryRow;
  state: DirectoryState;
  lastVisits: ReadonlyMap<string, string> | null;
  selected: boolean;
}) {
  const archived = state.view === "archived";
  const contact = [row.email, row.phone].filter((v): v is string => Boolean(v));
  return (
    <li id={`client-${row.id}`} className={`px-4 py-3 ${selected ? "bg-neutral-50 dark:bg-neutral-900" : ""}`}>
      <div className="flex flex-col gap-2 md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,1.5fr)_auto] md:items-center md:gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <Link
              href={href(state, { client: row.id })}
              className="truncate font-medium hover:underline"
              aria-current={selected ? "true" : undefined}
            >
              {row.displayName}
            </Link>
            {row.pronouns && <span className="text-xs text-neutral-500">{row.pronouns}</span>}
            {archived && (
              <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                Archived
              </span>
            )}
          </div>
          {row.nameOnFile && <div className="text-[11px] text-neutral-500">{NAME_ON_FILE_LABEL}</div>}
        </div>
        <div className="min-w-0 truncate text-xs text-neutral-600 dark:text-neutral-400">{contact.length > 0 ? contact.join(" · ") : "No contact on file"}</div>
        {archived ? (
          <div className="text-xs text-neutral-500 md:col-span-2">
            {row.archivedAt ? (
              <>
                Archived <FormattedDateTime iso={row.archivedAt} />
              </>
            ) : null}
          </div>
        ) : (
          <>
            <div className="text-xs text-neutral-600 dark:text-neutral-400">
              <span className="text-neutral-500 md:hidden">Last visit: </span>
              <LastVisitText cell={lastVisitCell(lastVisits, row.id)} />
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
              <span>
                <span className="text-neutral-500 md:hidden">Next: </span>
                <NextCell row={row} />
              </span>
              <IntakePill state={row.intake} />
            </div>
          </>
        )}
        <div className="flex items-center gap-2 md:justify-end">
          <PendingLink
            href={`/clients/${row.id}`}
            pendingLabel="Opening client…"
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Open
          </PendingLink>
          {archived && (
            <UnarchiveRowControl client={{ id: row.id }} />
          )}
        </div>
      </div>
    </li>
  );
}

function Pagination({ state, data }: { state: DirectoryState; data: DirectoryPage }) {
  if (data.pageCount <= 1) return null;
  return (
    <nav aria-label="Client list pages" className="flex items-center justify-between text-sm">
      {data.page > 1 ? (
        <PendingLink href={href(state, { page: data.page - 1 })} pendingLabel="Loading clients…" className="rounded-md border border-neutral-300 px-3 py-1.5 dark:border-neutral-700">
          Previous
        </PendingLink>
      ) : (
        <span />
      )}
      <span className="text-neutral-500">
        Page {data.page} of {data.pageCount}
      </span>
      {data.page < data.pageCount ? (
        <PendingLink href={href(state, { page: data.page + 1 })} pendingLabel="Loading clients…" className="rounded-md border border-neutral-300 px-3 py-1.5 dark:border-neutral-700">
          Next
        </PendingLink>
      ) : (
        <span />
      )}
    </nav>
  );
}

// The overview of the selected client: authorized contact, next appointment,
// intake STATUS, last visit and links. No treatment notes, payment details or
// legal identity (none is read for the directory). Before-today and treatment
// history stay on the full profile. Closing returns to the same URL state, with an
// anchor so the list scrolls back to the row.
export function ClientOverview({
  state,
  row,
  lastVisit,
  page,
}: {
  state: DirectoryState;
  row: DirectoryRow;
  lastVisit: LastVisitCell;
  page: number;
}) {
  const archived = state.view === "archived";
  return (
    <aside aria-label="Client overview" className="rounded-lg border border-neutral-300 p-4 dark:border-neutral-700">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{row.displayName}</h2>
          {row.pronouns && <p className="text-xs text-neutral-500">{row.pronouns}</p>}
          {row.nameOnFile && <p className="text-[11px] text-neutral-500">{NAME_ON_FILE_LABEL}</p>}
        </div>
        <Link href={`${href(state, { page })}#client-${row.id}`} className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium dark:border-neutral-700">
          Close
        </Link>
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-neutral-500">Email</dt>
          <dd>{row.email ? <a className="underline" href={`mailto:${row.email}`}>{row.email}</a> : "None on file"}</dd>
        </div>
        <div>
          <dt className="text-xs text-neutral-500">Phone</dt>
          <dd>{row.phone ? <a className="underline" href={`tel:${row.phone}`}>{row.phone}</a> : "None on file"}</dd>
        </div>
        {!archived && (
          <>
            <div>
              <dt className="text-xs text-neutral-500">Next appointment</dt>
              <dd><NextCell row={row} /></dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">Intake</dt>
              <dd><IntakePill state={row.intake} /></dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">Last visit</dt>
              <dd><LastVisitText cell={lastVisit} /></dd>
            </div>
          </>
        )}
      </dl>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <PendingLink href={`/clients/${row.id}`} pendingLabel="Opening client…" className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200">
          Open full profile
        </PendingLink>
        {!archived && (
          <PendingLink href={`/clients/${row.id}?book=1`} pendingLabel="Opening booking…" className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900">
            Book appointment
          </PendingLink>
        )}
      </div>
      <p className="mt-3 text-[11px] text-neutral-500">Before-today notes and treatment history are on the full profile.</p>
    </aside>
  );
}
