"use client";

import Link from "next/link";
import { useEffect, useRef, type ReactNode } from "react";

// The shell of the open client overview: focus on open, focus back on close.
//
// HON-58 shared UI lesson. The overview opens INSIDE the list, under the row that was
// activated, so nothing above it moves. When it opens, keyboard focus moves to its
// heading (and it is scrolled into view only if it is not already visible). When it
// closes (the Close link or Escape) focus returns to the row's own link, the URL is
// the same one without ?client= (so search, filters, sort and page are exactly as
// they were), and there is no #anchor, so the page is never scrolled to a fragment.
//
// Leaf island: the content is server-rendered and passed in as children; this only
// owns focus. It needs no router (a Link does the navigation), so it renders the same
// without one.

export function overviewRowLinkId(clientId: string): string {
  return `client-open-${clientId}`;
}

export function OverviewFrame({
  clientId,
  title,
  meta,
  closeHref,
  children,
}: {
  clientId: string;
  title: string;
  meta?: ReactNode;
  closeHref: string;
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const closeLink = useRef<HTMLAnchorElement>(null);
  const closing = useRef(false);

  useEffect(() => {
    const el = heading.current;
    if (el) {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: "nearest" });
    }
    return () => {
      // Unmounting because the overview was CLOSED (not because another page was
      // opened): hand focus back to the row that opened it.
      if (closing.current) {
        document.getElementById(overviewRowLinkId(clientId))?.focus({ preventScroll: true });
      }
    };
  }, [clientId]);

  return (
    <aside
      aria-labelledby={`client-overview-title-${clientId}`}
      className="mt-3 rounded-lg border border-neutral-300 p-4 dark:border-neutral-700"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          closing.current = true;
          closeLink.current?.click();
        }
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2
            ref={heading}
            id={`client-overview-title-${clientId}`}
            tabIndex={-1}
            className="text-lg font-semibold outline-none"
          >
            {title}
          </h2>
          {meta}
        </div>
        <Link
          ref={closeLink}
          href={closeHref}
          scroll={false}
          onClick={() => {
            closing.current = true;
          }}
          aria-label={`Close overview for ${title}`}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-neutral-300 px-3 text-xs font-medium dark:border-neutral-700"
        >
          Close
        </Link>
      </div>
      {children}
    </aside>
  );
}
