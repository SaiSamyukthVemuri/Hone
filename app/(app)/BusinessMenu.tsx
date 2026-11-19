"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { PendingLink } from "@/components/pending-link";
import { cx } from "@/components/ui/control-base";
import { BUSINESS_MENU_ITEMS, BUSINESS_MENU_LABEL, isBusinessPath } from "@/lib/nav/business-menu";

// The owner's Business menu in the desktop primary navigation: one button, two destinations (Capacity, Statements).
//
// OWNER-ONLY PRESENTATION. The layout renders this only for the role it already resolved; the pages keep their own server-side owner
// check, so hiding it protects nothing and showing it grants nothing.
//
// KEYBOARD: Enter or Space opens (it is a button); Escape closes and returns focus to the button; Tab moving focus out of the menu
// closes it; the links are ordinary links in tab order. It follows the AccountMenu's pattern: a button with aria-expanded and a
// labelled panel, closed by a press outside. After choosing a page it stays open, showing the link's pending mark, until the
// navigation commits.
export function BusinessMenu() {
  // The menu is open only for the path it was opened on. Choosing another page keeps it (and the link's "Opening…" mark) mounted
  // until the navigation COMMITS and the pathname changes, so a slow page still shows its acknowledgement; no effect is needed.
  const [openedOn, setOpenedOn] = useState<string | null | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();
  const open = openedOn !== undefined && openedOn === pathname;
  const setOpen = (next: boolean) => setOpenedOn(next ? pathname : undefined);
  const current = isBusinessPath(pathname);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpenedOn(undefined);
        buttonRef.current?.focus();
      }
    }
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpenedOn(undefined);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="relative"
      onBlur={(e) => {
        // Focus left the whole menu (Tab past the last link, or Shift+Tab before the button): close it.
        if (open && e.relatedTarget && !rootRef.current?.contains(e.relatedTarget as Node)) setOpenedOn(undefined);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        data-testid="nav-business"
        aria-expanded={open}
        aria-controls="business-menu-panel"
        aria-current={current ? "page" : undefined}
        onClick={() => setOpen(!open)}
        className={cx(
          "flex items-center gap-1 rounded-md px-3 py-2",
          current
            ? "bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
            : "hover:bg-neutral-100 dark:hover:bg-neutral-900",
        )}
      >
        {BUSINESS_MENU_LABEL}
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          fill="currentColor"
          className={`h-4 w-4 text-neutral-500 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.06l3.71-3.83a.75.75 0 1 1 1.08 1.04l-4.25 4.39a.75.75 0 0 1-1.08 0L5.21 8.27a.75.75 0 0 1 .02-1.06Z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {open && (
        <div
          id="business-menu-panel"
          role="group"
          aria-label="Business"
          className="absolute left-0 z-40 mt-2 flex w-56 flex-col gap-0.5 rounded-lg border border-neutral-200 bg-white p-2 text-sm shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
        >
          {BUSINESS_MENU_ITEMS.map((item) => {
            const here = pathname === item.href || (pathname?.startsWith(`${item.href}/`) ?? false);
            return (
              <PendingLink
                key={item.href}
                href={item.href}
                data-testid={item.testId}
                pendingLabel={`Opening ${item.label}…`}
                aria-current={here ? "page" : undefined}
                // The page you are already on never changes the pathname, so nothing would ever close the menu: close it now.
                // Any other destination stays open (acknowledging) until the navigation commits.
                onClick={here ? () => setOpen(false) : undefined}
                className={cx(
                  "flex min-h-[40px] items-center rounded-md px-3 py-2",
                  here ? "bg-neutral-100 dark:bg-neutral-800" : "hover:bg-neutral-100 dark:hover:bg-neutral-900",
                )}
              >
                {item.label}
              </PendingLink>
            );
          })}
        </div>
      )}
    </div>
  );
}
