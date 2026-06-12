"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { globalSearchAction } from "./global-search-actions";
import {
  groupResults,
  SEARCH_MIN_CHARS,
  type SearchResult,
} from "@/lib/search/global-search";

// Global Search V1 (PR #232). One client component, two variants:
//   desktop: inline input in the header with a dropdown under it
//   mobile:  a 44px search icon button; tapping it opens a panel
//            anchored to the header's right side
// Same dismissal model as the menus: closes on result click, on
// Escape, and on pointerdown outside the root. Debounced (250ms);
// queries under SEARCH_MIN_CHARS show page shortcuts instead of
// hitting the database.
export function GlobalSearch({ variant }: { variant: "desktop" | "mobile" }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Debounced search. The action itself answers sub-minimum queries
  // with page shortcuts, so the empty/short state is still useful.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      const response = await globalSearchAction(query).catch(() => null);
      if (cancelled) return;
      setLoading(false);
      setResults(response && response.ok ? response.results : []);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, open]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const groups = groupResults(results);
  const panel = open && (
    <div
      className={
        variant === "desktop"
          ? "absolute left-0 right-0 top-full z-40 mt-2 max-h-[70vh] overflow-y-auto rounded-lg border border-neutral-200 bg-white p-2 text-sm shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
          : // PR #234: a viewport-FIXED sheet under the header. The old
            // absolute right-0 panel was anchored to the search ICON,
            // which sits left of the bell and Menu, so a
            // calc(100vw-2rem) panel extended past the LEFT edge of
            // the screen and clipped the input. Fixed positioning is
            // relative to the viewport, so the sheet is always fully
            // on-screen regardless of where the trigger sits.
            "fixed inset-x-3 top-16 z-40 max-h-[75vh] overflow-y-auto rounded-lg border border-neutral-200 bg-white p-2 text-sm shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
      }
    >
      {variant === "mobile" && (
        <div className="mb-2 flex items-center gap-2">
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search clients, appointments, notes..."
            aria-label="Search Hone"
            className="min-h-[44px] w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:focus:border-neutral-100"
          />
          <button
            type="button"
            onClick={close}
            className="min-h-[44px] rounded-md px-2 text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            Close
          </button>
        </div>
      )}
      {loading && results.length === 0 ? (
        <p className="px-3 py-3 text-neutral-500">Searching…</p>
      ) : groups.length === 0 ? (
        <div className="px-3 py-3 text-neutral-500">
          <p>No results found.</p>
          <p className="mt-1 text-xs">
            Try a client name, phone, appointment, treatment area, or lot
            number.
          </p>
        </div>
      ) : (
        groups.map((group) => (
          <div key={group.label} className="mb-1">
            <p className="px-3 pb-0.5 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-neutral-500">
              {group.label}
            </p>
            {group.results.map((result) => (
              <Link
                key={result.id}
                href={result.href}
                onClick={close}
                className="flex min-h-[44px] flex-col justify-center rounded-md px-3 py-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-900"
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-medium">{result.title}</span>
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-neutral-500">
                    {result.badge && (
                      <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 capitalize dark:bg-neutral-900">
                        {result.badge.replace("_", " ")}
                      </span>
                    )}
                    {result.date}
                  </span>
                </span>
                {result.subtitle && (
                  <span className="truncate text-xs text-neutral-500">
                    {result.subtitle}
                  </span>
                )}
              </Link>
            ))}
          </div>
        ))
      )}
      {query.length > 0 && query.length < SEARCH_MIN_CHARS && (
        <p className="px-3 pb-1 text-xs text-neutral-400">
          Keep typing to search…
        </p>
      )}
    </div>
  );

  if (variant === "desktop") {
    return (
      <div ref={rootRef} className="relative w-36 lg:w-56">
        <input
          type="search"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          placeholder="Search clients, appointments, notes..."
          aria-label="Search Hone"
          className="min-h-[40px] w-full rounded-md border border-neutral-300 bg-transparent px-3 py-1.5 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:focus:border-neutral-100"
        />
        {panel}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="Search Hone"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          // Focus the input on open (next tick, after it mounts).
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
        className="relative flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-900"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          className="h-5 w-5"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      </button>
      {panel}
    </div>
  );
}
