"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { FOCUS_RING } from "@/components/ui/control-base";
import { useRouter } from "next/navigation";
import {
  directoryHref,
  type DirectoryFilter,
  type DirectorySort,
} from "@/lib/clients/directory-query";
import { MAX_DIRECTORY_QUERY_LENGTH } from "@/lib/clients/directory-search";
import {
  LAST_VISIT_FILTER_CHOICES,
  LAST_VISIT_FILTER_LABEL,
  type LastVisitFilter,
} from "@/lib/clients/last-visit-filter";

// The URL owns the displayed result set. Hydrated controls navigate without scrolling;
// without JavaScript, Search submits the same named fields as a GET form.
type View = "active" | "archived";

export type DirectoryControlsState = {
  view: View;
  q: string;
  filters: DirectoryFilter[];
  sort: DirectorySort;
  lastVisit: LastVisitFilter;
};

const FILTER_LABEL: Record<DirectoryFilter, string> = {
  intake_review: "Intake needs review",
  no_upcoming: "No upcoming appointment",
};

const SORT_LABEL: Record<DirectorySort, string> = {
  name: "Name A–Z",
  next: "Next appointment",
  lastvisit: "Last visit (longest ago first)",
  archived: "Recently archived",
};

const SORT_CHOICES: Record<View, DirectorySort[]> = {
  active: ["name", "next", "lastvisit"],
  archived: ["archived", "name"],
};

const CONTROL = "min-h-11 rounded-md border border-neutral-300 bg-white text-neutral-800 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100";
const SELECT = `${CONTROL} max-w-full cursor-pointer px-3 text-base pointer-fine:text-sm ${FOCUS_RING}`;

export function DirectoryControls({ state }: { state: DirectoryControlsState }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const archived = state.view === "archived";
  const [q, setQ] = useState(state.q);
  const [filters, setFilters] = useState<DirectoryFilter[]>(state.filters);
  const [sort, setSort] = useState<DirectorySort>(state.sort);
  const [lastVisit, setLastVisit] = useState<LastVisitFilter>(state.lastVisit);

  // The URL is the source of truth: Back, Forward, Clear and a link that opens the
  // directory with a state all arrive as new props, and the controls follow them.
  useEffect(() => setQ(state.q), [state.q, state.view]);
  const filtersKey = state.filters.join(",");
  useEffect(() => {
    setFilters(state.filters);
    setSort(state.sort);
    setLastVisit(state.lastVisit);
    // filtersKey stands in for the array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey, state.sort, state.lastVisit, state.view]);

  const go = (next: { q: string; filters: DirectoryFilter[]; sort: DirectorySort; lastVisit: LastVisitFilter }) => {
    startTransition(() => {
      router.push(directoryHref({ view: state.view, ...next }), { scroll: false });
    });
  };

  const activeParts: string[] = [];
  // The term itself is never repeated in text (Privacy S8): the input shows it.
  if (state.q) activeParts.push("search");
  for (const f of state.filters) activeParts.push(FILTER_LABEL[f]);
  if (state.lastVisit !== "any") activeParts.push(LAST_VISIT_FILTER_LABEL[state.lastVisit]);
  const hasActive = activeParts.length > 0;
  const defaultSort: DirectorySort = archived ? "archived" : "name";

  return (
    <form
      method="get"
      action="/clients"
      role="search"
      aria-label="Search and filter clients"
      aria-busy={pending}
      onSubmit={(e) => {
        e.preventDefault();
        go({ q: q.trim(), filters, sort, lastVisit });
      }}
      className="flex flex-col gap-2.5"
    >
      {archived && <input type="hidden" name="view" value="archived" />}

      <div className="flex flex-wrap items-center gap-2">
        <div className={`${CONTROL} flex w-full min-w-0 items-center focus-within:ring-2 focus-within:ring-focus-ring sm:w-auto sm:flex-1`}>
          <button
            type="submit"
            aria-label="Search"
            title="Search"
            className={`flex min-h-11 min-w-11 items-center justify-center rounded-md text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white ${FOCUS_RING}`}
          >
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <circle cx="10.5" cy="10.5" r="6.5" />
              <path d="m16 16 5 5" strokeLinecap="round" />
            </svg>
          </button>
          <input
            type="search"
            aria-label="Search clients"
            name="q"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            maxLength={MAX_DIRECTORY_QUERY_LENGTH}
            placeholder="Search by name, email or phone"
            autoComplete="off"
            className="min-h-11 min-w-0 flex-1 bg-transparent pr-3 text-base outline-hidden placeholder:text-neutral-500 pointer-fine:text-sm"
          />
        </div>
        <label className="flex min-w-0 max-w-full items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
          Sort by
          <select
            name="sort"
            aria-label="Sort by"
            className={SELECT}
            value={sort}
            onChange={(event) => {
              const next = event.target.value as DirectorySort;
              setSort(next);
              go({ q: q.trim(), filters, sort: next, lastVisit });
            }}
          >
            {SORT_CHOICES[state.view].map((value) => <option key={value} value={value}>{SORT_LABEL[value]}</option>)}
          </select>
        </label>
      </div>

      {!archived && (
        <fieldset className="flex min-w-0 flex-wrap items-center gap-2">
          <legend className="sr-only">Filters</legend>
          {(Object.keys(FILTER_LABEL) as DirectoryFilter[]).map((value) => (
            <label key={value} className="cursor-pointer">
              <input
                type="checkbox"
                name="filter"
                value={value}
                checked={filters.includes(value)}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...filters.filter((item) => item !== value), value]
                    : filters.filter((item) => item !== value);
                  setFilters(next);
                  go({ q: q.trim(), filters: next, sort, lastVisit });
                }}
                className="peer sr-only"
              />
              <span className={`${CONTROL} inline-flex items-center px-3 text-sm peer-checked:border-neutral-700 peer-checked:bg-neutral-100 peer-checked:font-semibold peer-checked:before:mr-1.5 peer-checked:before:content-['✓'] peer-focus-visible:ring-2 peer-focus-visible:ring-focus-ring peer-focus-visible:ring-offset-2 dark:peer-checked:border-neutral-300 dark:peer-checked:bg-neutral-800`}>
                {FILTER_LABEL[value]}
              </span>
            </label>
          ))}
          <select
            name="lastvisit"
            aria-label="Last visit"
            value={lastVisit}
            className={SELECT}
            onChange={(event) => {
              const next = event.target.value as LastVisitFilter;
              setLastVisit(next);
              go({ q: q.trim(), filters, sort, lastVisit: next });
            }}
          >
            <option value="any">Last visit: Any</option>
            {LAST_VISIT_FILTER_CHOICES.map((value) => <option key={value} value={value}>{LAST_VISIT_FILTER_LABEL[value]}</option>)}
          </select>
        </fieldset>
      )}

      {(hasActive || state.sort !== defaultSort) && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 text-sm text-neutral-600 dark:text-neutral-400">
          {hasActive && <p><span className="font-medium">Showing:</span> {activeParts.join(" · ")}</p>}
          <Link
            href={directoryHref({ view: state.view })}
            scroll={false}
            onNavigate={() => setQ("")}
            className={`inline-flex min-h-11 items-center underline underline-offset-4 ${FOCUS_RING}`}
          >
            Clear search and filters
          </Link>
        </div>
      )}
    </form>
  );
}
