"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  directoryHref,
  type DirectoryFilter,
  type DirectorySort,
} from "@/lib/clients/directory-query";
import { MAX_DIRECTORY_QUERY_LENGTH } from "@/lib/clients/directory-search";

// Search, sort and filters for the clients directory.
//
// HON-58 shared UI lesson: a control changes the RESULTS and nothing else. The URL is
// still the whole state (search, filters, sort, view), but a change is a client
// navigation with scroll:false, so the page does not jump, the control you used keeps
// keyboard focus and the typed search text is never thrown away. Everything is
// visible at once (no dropdown holds a control), every control is a 44px target, and
// what is applied is stated in words next to a single Clear. Without JavaScript the
// same markup is a plain GET form, so the directory still works.
//
// Changing search, filters or sort starts a new result set, so it drops the page and
// the open overview (directoryHref omits both). Nothing here counts or filters.

type View = "active" | "archived";

export type DirectoryControlsState = {
  view: View;
  q: string;
  filters: DirectoryFilter[];
  sort: DirectorySort;
};

const FILTER_LABEL: Record<DirectoryFilter, string> = {
  intake_review: "Intake needs review",
  no_upcoming: "No upcoming appointment",
};

const SORT_LABEL: Record<DirectorySort, string> = {
  name: "Name",
  next: "Next appointment",
  archived: "Recently archived",
};

const SORT_CHOICES: Record<View, DirectorySort[]> = {
  active: ["name", "next"],
  archived: ["archived", "name"],
};

const TARGET = "min-h-11";

export function DirectoryControls({ state }: { state: DirectoryControlsState }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const archived = state.view === "archived";
  const [q, setQ] = useState(state.q);
  const [filters, setFilters] = useState<DirectoryFilter[]>(state.filters);
  const [sort, setSort] = useState<DirectorySort>(state.sort);

  // The URL is the source of truth: Back, Forward, Clear and a link that opens the
  // directory with a state all arrive as new props, and the controls follow them.
  const filtersKey = state.filters.join(",");
  useEffect(() => {
    setQ(state.q);
    setFilters(state.filters);
    setSort(state.sort);
    // filtersKey stands in for the array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.q, filtersKey, state.sort]);

  const go = (next: { q: string; filters: DirectoryFilter[]; sort: DirectorySort }) => {
    startTransition(() => {
      router.push(directoryHref({ view: state.view, ...next }), { scroll: false });
    });
  };

  const activeParts: string[] = [];
  // The term itself is never repeated in text (Privacy S8): the input shows it.
  if (state.q) activeParts.push("search");
  for (const f of state.filters) activeParts.push(FILTER_LABEL[f]);
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
        go({ q: q.trim(), filters, sort });
      }}
      className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
    >
      {archived && <input type="hidden" name="view" value="archived" />}

      <div className="flex gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-400">
          Search clients
          <input
            type="search"
            name="q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            maxLength={MAX_DIRECTORY_QUERY_LENGTH}
            placeholder="Name, email or phone"
            autoComplete="off"
            className={`${TARGET} rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-normal text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100`}
          />
        </label>
        <button
          type="submit"
          className={`${TARGET} min-w-11 self-end rounded-md bg-neutral-900 px-4 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200`}
        >
          Search
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="sr-only">Sort by</legend>
          <span aria-hidden className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
            Sort by
          </span>
          <div className="flex rounded-lg border border-neutral-200 bg-neutral-50 p-1 text-sm dark:border-neutral-800 dark:bg-neutral-900">
            {SORT_CHOICES[state.view].map((value) => (
              <label key={value} className="cursor-pointer">
                <input
                  type="radio"
                  name="sort"
                  value={value}
                  checked={sort === value}
                  onChange={() => {
                    setSort(value);
                    go({ q: state.q, filters: state.filters, sort: value });
                  }}
                  className="peer sr-only"
                />
                <span
                  className={`${TARGET} flex items-center rounded-md px-3 text-neutral-600 peer-checked:bg-white peer-checked:font-medium peer-checked:text-neutral-900 peer-checked:shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-neutral-900 dark:text-neutral-400 dark:peer-checked:bg-neutral-950 dark:peer-checked:text-neutral-100 dark:peer-focus-visible:ring-white`}
                >
                  {SORT_LABEL[value]}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {!archived && (
          <fieldset className="flex flex-wrap items-center gap-2">
            <legend className="sr-only">Filters</legend>
            {(Object.keys(FILTER_LABEL) as DirectoryFilter[]).map((value) => (
              <label key={value} className="cursor-pointer">
                <input
                  type="checkbox"
                  name="filter"
                  value={value}
                  checked={filters.includes(value)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...filters.filter((f) => f !== value), value]
                      : filters.filter((f) => f !== value);
                    setFilters(next);
                    go({ q: state.q, filters: next, sort: state.sort });
                  }}
                  className="peer sr-only"
                />
                <span
                  className={`${TARGET} flex items-center rounded-full border border-neutral-300 px-4 text-sm text-neutral-700 peer-checked:border-neutral-900 peer-checked:bg-neutral-900 peer-checked:font-medium peer-checked:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-neutral-900 peer-focus-visible:ring-offset-2 dark:border-neutral-700 dark:text-neutral-300 dark:peer-checked:border-white dark:peer-checked:bg-white dark:peer-checked:text-neutral-900 dark:peer-focus-visible:ring-white`}
                >
                  {FILTER_LABEL[value]}
                </span>
              </label>
            ))}
          </fieldset>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500">
        <p>
          {hasActive ? (
            <>
              <span className="font-medium text-neutral-700 dark:text-neutral-300">Showing:</span> {activeParts.join(" · ")}
            </>
          ) : (
            "Searches the names shown, email and phone."
          )}
        </p>
        {(hasActive || state.sort !== defaultSort) && (
          <button
            type="button"
            onClick={() => {
              setQ("");
              setFilters([]);
              setSort(defaultSort);
              go({ q: "", filters: [], sort: defaultSort });
            }}
            className={`${TARGET} rounded-md px-3 text-sm text-neutral-700 underline dark:text-neutral-300`}
          >
            Clear search and filters
          </button>
        )}
      </div>
    </form>
  );
}
