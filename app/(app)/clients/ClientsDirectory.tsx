import type { ReactNode } from "react";
import Link from "next/link";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { PendingLink } from "@/components/pending-link";
import { UnarchiveRowControl } from "./UnarchiveRowControl";
import { OverviewFrame } from "./OverviewFrame";
import { formatStudioDate, formatStudioDateTime } from "@/lib/clients/last-visit";
import { NAME_ON_FILE_LABEL } from "@/lib/clients/directory-rules";
import {
  directoryHref,
  overviewRowLinkId,
  type DirectoryFilter,
  type DirectoryPage,
  type DirectoryRow,
  type DirectorySort,
  type IntakeState,
} from "@/lib/clients/directory-query";

// The clients directory (server component; the controls and the overview's focus
// handling are the two small client islands next to it). Search, filters, sort, page,
// view and the open overview all live in the URL: closing the overview or going back
// restores them, and no link carries a #fragment (HON-58: no anchor jumps). Nothing here filters or
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

/** `label` is the date in the studio timezone, formatted on the server (K3). */
export type LastVisitCell = { kind: "at"; iso: string; label?: string } | { kind: "none" } | { kind: "unavailable" };

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

export function DirectoryResults({
  state,
  data,
  lastVisits,
  selectedId,
  overview,
  timeZone,
}: {
  state: DirectoryState;
  data: DirectoryPage;
  lastVisits: ReadonlyMap<string, string> | null;
  selectedId: string | null;
  /** The open overview; shown INSIDE the selected row's item so nothing above it moves. */
  overview?: ReactNode;
  /** The studio timezone, so last visit is a server-rendered studio date. */
  timeZone?: string;
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
      {!archived && <IntakeLegend />}
      <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        <DirectoryHeader archived={archived} />
        {data.rows.map((row) => (
          <DirectoryRowView
            key={row.id}
            row={row}
            state={state}
            lastVisits={lastVisits}
            selected={row.id === selectedId}
            overview={row.id === selectedId ? overview : null}
            timeZone={timeZone}
          />
        ))}
      </ul>
      <Pagination state={state} data={data} />
    </div>
  );
}

// Visible column headings (reference: Client | Last visit | Next appointment | Intake |
// Actions). Desktop only: the headings are aria-hidden because every cell below carries
// its own label, visible on a phone and screen-reader-only beside the headings.
const GRID_ACTIVE =
  "md:grid-cols-[minmax(0,2.4fr)_minmax(0,1.1fr)_minmax(0,1.5fr)_minmax(0,1.1fr)_auto]";
const GRID_ARCHIVED = "md:grid-cols-[minmax(0,2.4fr)_minmax(0,2.6fr)_auto]";
const CELL_LABEL = "text-neutral-500 md:sr-only";

function DirectoryHeader({ archived }: { archived: boolean }) {
  const heading = "text-[11px] font-semibold uppercase tracking-wider text-neutral-500";
  return (
    <li
      aria-hidden="true"
      data-testid="directory-headings"
      className={`hidden bg-neutral-50 px-4 py-2 md:grid md:gap-4 dark:bg-neutral-900 ${archived ? GRID_ARCHIVED : GRID_ACTIVE}`}
    >
      <span className={heading}>Client</span>
      {archived ? (
        <span className={heading}>Archived</span>
      ) : (
        <>
          <span className={heading}>Last visit</span>
          <span className={heading}>Next appointment</span>
          <span className={heading}>Intake</span>
        </>
      )}
      <span className={`${heading} md:text-right`}>Actions</span>
    </li>
  );
}

function NextCell({ row, timeZone }: { row: DirectoryRow; timeZone?: string }) {
  if (row.next.state === "scheduled") {
    return timeZone ? (
      <time dateTime={row.next.startsAt}>{formatStudioDateTime(row.next.startsAt, timeZone)}</time>
    ) : (
      <FormattedDateTime iso={row.next.startsAt} />
    );
  }
  if (row.next.state === "none") return <span>No upcoming appointment</span>;
  return <span className="text-neutral-500">Unavailable</span>;
}

export function LastVisitText({ cell }: { cell: LastVisitCell }) {
  if (cell.kind === "at") {
    return cell.label ? <time dateTime={cell.iso}>{cell.label}</time> : <FormattedDateTime iso={cell.iso} format="date" />;
  }
  // "in Hone": imported treatment history feeds neither source, so this is not "never seen" (K6).
  if (cell.kind === "none") return <span>No visit recorded in Hone</span>;
  return <span className="text-neutral-500">Unavailable</span>;
}

export function lastVisitCell(
  map: ReadonlyMap<string, string> | null,
  id: string,
  timeZone?: string,
): LastVisitCell {
  if (map === null) return { kind: "unavailable" };
  const at = map.get(id);
  if (!at) return { kind: "none" };
  return timeZone ? { kind: "at", iso: at, label: formatStudioDate(at, timeZone) } : { kind: "at", iso: at };
}

// What the status IS (traced, HON-58 1 Nov): the status of the client's NEWEST non-deleted
// intake form. "Reviewed" = a practitioner marked that form reviewed (the database stamps
// who and when; the directory shows neither). It is not a visit, a chart or a consent.
const INTAKE_MEANING: Record<IntakeState, string> = {
  not_submitted: "The newest intake form has not been submitted, or the client has none",
  awaiting_review: "The newest intake form was submitted and a practitioner has not reviewed it yet",
  reviewed: "A practitioner has reviewed the newest intake form",
  unavailable: "Intake status could not be loaded",
};

// Insurance T-1: the meaning is VISIBLE text (touch, keyboard and screen-reader users cannot
// hover), and each pill points at its own line with aria-describedby. No title attribute.
const meaningId = (state: IntakeState) => `directory-intake-meaning-${state}`;

function IntakeLegend() {
  return (
    <dl data-testid="directory-intake-legend" className="space-y-0.5 text-xs text-neutral-600 dark:text-neutral-400">
      {(["reviewed", "awaiting_review", "not_submitted", "unavailable"] as const).map((state) => (
        <div key={state} className="flex flex-wrap gap-x-1">
          <dt className="font-medium">{INTAKE_LABEL[state]}:</dt>
          <dd id={meaningId(state)}>{INTAKE_MEANING[state]}.</dd>
        </div>
      ))}
    </dl>
  );
}

function IntakePill({ state }: { state: IntakeState }) {
  return (
    <span
      aria-describedby={meaningId(state)}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${INTAKE_TONE[state]}`}
    >
      {INTAKE_LABEL[state]}
    </span>
  );
}

function DirectoryRowView({
  row,
  state,
  lastVisits,
  selected,
  overview,
  timeZone,
}: {
  row: DirectoryRow;
  state: DirectoryState;
  lastVisits: ReadonlyMap<string, string> | null;
  selected: boolean;
  overview: ReactNode;
  timeZone?: string;
}) {
  const archived = state.view === "archived";
  // Privacy ruling (FIDELITY-Q1): subline = pronouns · email, each omitted when absent; the
  // "Name on file" label leads it wherever the shown name is the stored name (never hidden).
  // The phone keeps its own line: it is searchable, so it must stay shown, and is not repeated.
  const subline = [row.nameOnFile ? NAME_ON_FILE_LABEL : null, row.pronouns, row.email].filter((v): v is string => Boolean(v));
  return (
    <li
      id={`client-${row.id}`}
      className={`px-4 py-3 ${selected ? "border-l-4 border-neutral-900 bg-neutral-50 pl-3 dark:border-white dark:bg-neutral-900" : ""}`}
    >
      <div className={`flex flex-col gap-2 md:grid md:items-center md:gap-4 ${archived ? GRID_ARCHIVED : GRID_ACTIVE}`}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <Link
              id={overviewRowLinkId(row.id)}
              href={href(state, { client: row.id })}
              scroll={false}
              className="inline-flex min-h-11 min-w-0 items-center break-words font-medium hover:underline md:min-h-0"
              aria-current={selected ? "true" : undefined}
            >
              {row.displayName}
            </Link>
            {archived && (
              <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                Archived
              </span>
            )}
          </div>
          {subline.length > 0 && (
            <div className="min-w-0 break-words text-xs text-neutral-600 dark:text-neutral-400">{subline.join(" · ")}</div>
          )}
          {row.phone && <div className="min-w-0 break-words text-xs text-neutral-600 dark:text-neutral-400">{row.phone}</div>}
          {subline.length === 0 && !row.phone && <div className="text-xs text-neutral-500">No contact on file</div>}
        </div>
        {archived ? (
          <div className="text-xs text-neutral-500">
            <span className={CELL_LABEL}>Archived: </span>
            {row.archivedAt ? <FormattedDateTime iso={row.archivedAt} /> : null}
          </div>
        ) : (
          <>
            <div className="text-xs text-neutral-600 dark:text-neutral-400">
              <span className={CELL_LABEL}>Last visit: </span>
              <LastVisitText cell={lastVisitCell(lastVisits, row.id, timeZone)} />
            </div>
            <div className="text-xs text-neutral-600 dark:text-neutral-400">
              <span className={CELL_LABEL}>Next appointment: </span>
              <NextCell row={row} timeZone={timeZone} />
            </div>
            <div className="text-xs text-neutral-600 dark:text-neutral-400">
              <span className={CELL_LABEL}>Intake: </span>
              <IntakePill state={row.intake} />
            </div>
          </>
        )}
        <div className="flex items-center gap-2 md:justify-end">
          <PendingLink
            href={`/clients/${row.id}`}
            pendingLabel="Opening client…"
            className="inline-flex min-h-11 items-center rounded-md border border-neutral-300 px-3 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Open
          </PendingLink>
          {archived && (
            <UnarchiveRowControl client={{ id: row.id }} />
          )}
        </div>
      </div>
      {overview}
    </li>
  );
}

function Pagination({ state, data }: { state: DirectoryState; data: DirectoryPage }) {
  if (data.pageCount <= 1) return null;
  return (
    <nav aria-label="Client list pages" className="flex items-center justify-between text-sm">
      {data.page > 1 ? (
        <PendingLink href={href(state, { page: data.page - 1 })} pendingLabel="Loading clients…" className="inline-flex min-h-11 items-center rounded-md border border-neutral-300 px-3 dark:border-neutral-700">
          Previous
        </PendingLink>
      ) : (
        <span />
      )}
      <span className="text-neutral-500">
        Page {data.page} of {data.pageCount}
      </span>
      {data.page < data.pageCount ? (
        <PendingLink href={href(state, { page: data.page + 1 })} pendingLabel="Loading clients…" className="inline-flex min-h-11 items-center rounded-md border border-neutral-300 px-3 dark:border-neutral-700">
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
// history stay on the full profile. It is rendered under its row (OverviewFrame owns
// focus). Closing returns to the same URL state with ?client= removed: no #anchor.
export function ClientOverview({
  state,
  row,
  lastVisit,
  page,
  timeZone,
}: {
  state: DirectoryState;
  row: DirectoryRow;
  lastVisit: LastVisitCell;
  page: number;
  timeZone?: string;
}) {
  const archived = state.view === "archived";
  return (
    <OverviewFrame
      clientId={row.id}
      title={row.displayName}
      closeHref={href(state, { page })}
      meta={
        <>
          {row.pronouns && <p className="text-xs text-neutral-500">{row.pronouns}</p>}
          {row.nameOnFile && <p className="text-[11px] text-neutral-500">{NAME_ON_FILE_LABEL}</p>}
        </>
      }
    >
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
              <dd><NextCell row={row} timeZone={timeZone} /></dd>
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
        <PendingLink href={`/clients/${row.id}`} pendingLabel="Opening client…" className="inline-flex min-h-11 items-center rounded-md bg-neutral-900 px-4 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200">
          Open full profile
        </PendingLink>
        {!archived && (
          <PendingLink href={`/clients/${row.id}?book=1`} pendingLabel="Opening booking…" className="inline-flex min-h-11 items-center rounded-md border border-neutral-300 px-4 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900">
            Book appointment
          </PendingLink>
        )}
      </div>
      <p className="mt-3 text-[11px] text-neutral-500">Before-today notes and treatment history are on the full profile.</p>
    </OverviewFrame>
  );
}
