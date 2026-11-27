"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildSearchIndex, searchEntries } from "@/lib/marketing/search-index";
import { MK_FONT_DISPLAY } from "./tokens";

// Search the public site: a header button opening a dialog with one text box.
// PRIVATE BY CONSTRUCTION. The index is a constant in this bundle and matching
// runs in the browser; the query lives in component state only. It is never
// fetched, written to the URL, stored, or sent to analytics. (Pinned by
// tests/app/marketing-site-search.test.ts.)
//
// Keyboard: the button opens the dialog and focus lands in the box; Arrow Down
// and Arrow Up walk the results, Enter in the box follows the first result,
// Escape closes and returns focus to the button, Tab stays inside. Closed, the
// dialog is not rendered at all.
const RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-mineral)]";
const ROW =
  "block min-h-11 border-b border-[color:var(--color-hairline)] px-1 py-3 transition-colors duration-[var(--hone-duration-ui)] hover:bg-[color:var(--color-hairline)] active:bg-[color:var(--color-hairline-strong)] " +
  RING;

export function SiteSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const pathname = usePathname();
  const index = useMemo(() => buildSearchIndex(), []);
  const results = useMemo(() => searchEntries(index, query), [index, query]);
  // With nothing typed the box offers the pages themselves.
  const shown = query.trim() ? results : index.filter((e) => e.kind === "Page").slice(0, 6);

  function close() {
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  }
  // Following a result: the page changes (or scrolls to its hash), so focus is not sent back to the button.
  function leave() {
    setOpen(false);
    setQuery("");
  }

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Leaving the page by a result closes the dialog without taking focus back.
  useEffect(() => {
    setOpen(false);
    setQuery("");
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function onDialogKeyDown(e: React.KeyboardEvent) {
    const root = dialogRef.current;
    if (!root) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input"));
    if (items.length === 0) return;
    if (e.key === "Tab") {
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const links = Array.from(root.querySelectorAll<HTMLElement>("[data-search-result]"));
      const at = links.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      if (e.key === "ArrowDown") (links[at + 1] ?? links[0])?.focus();
      else if (at <= 0) inputRef.current?.focus();
      else links[at - 1]?.focus();
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`inline-flex min-h-11 items-center gap-1.5 px-2 text-[0.9375rem] font-medium text-ink transition-colors duration-[var(--hone-duration-ui)] hover:text-mineral active:text-mineral ${RING}`}
      >
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5 14 14" />
        </svg>
        Search
      </button>

      {open ? (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Search the site"
          onKeyDown={onDialogKeyDown}
          className="fixed inset-0 z-50 flex flex-col bg-paper"
        >
          <div className="flex items-center justify-between border-b border-[color:var(--color-hairline)] px-5 py-4">
            <span className="text-[1.25rem] font-bold text-ink" style={{ fontFamily: MK_FONT_DISPLAY }}>
              Search
            </span>
            <button type="button" onClick={close} className={`inline-flex min-h-11 items-center px-2 text-[0.9375rem] font-semibold text-ink hover:text-mineral ${RING}`}>
              Close
            </button>
          </div>
          <div className="mx-auto flex w-full max-w-[40rem] flex-1 flex-col overflow-y-auto px-5 py-6">
            <label htmlFor="site-search-input" className="sr-only">
              Search pages, guides and pricing questions
            </label>
            <input
              id="site-search-input"
              ref={inputRef}
              type="text"
              inputMode="search"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="go"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && shown[0]) {
                  e.preventDefault();
                  router.push(shown[0].href);
                  leave();
                }
              }}
              placeholder="Search pages, guides and pricing questions"
              className="min-h-12 w-full rounded-md border border-[color:var(--color-hairline-strong)] bg-paper px-4 text-[1rem] text-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-mineral)]"
            />
            <p role="status" className="mt-3 text-[0.875rem] text-muted">
              {query.trim() ? (results.length ? `${results.length} ${results.length === 1 ? "result" : "results"}` : "No matches. Try a shorter word.") : "Pages"}
            </p>
            <ul className="mt-2">
              {shown.map((e) => (
                <li key={e.href + e.title}>
                  <Link href={e.href} data-search-result className={ROW} onClick={leave}>
                    <span className="block text-[0.75rem] font-semibold uppercase tracking-wide text-muted">{e.kind}</span>
                    <span className="block text-[1rem] font-semibold text-ink">{e.title}</span>
                    {e.text ? <span className="mt-1 line-clamp-2 block text-[0.9375rem] leading-[1.5] text-muted">{e.text}</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
