"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { signOut } from "./dashboard/actions";

// PR #229: compact mobile menu, now a small client component instead
// of PR #228's <details>/<summary>. The authenticated layout
// persists across client-side navigations, so the no-JS details
// element stayed open after tapping a link; this component closes
// itself on every link tap (including the current page's link), on
// Escape, and when Sign out is submitted. Notifications is NOT in
// this list: the header bell (layout.tsx) owns that destination.
export function MobileMenu({
  admin,
  displayName,
  studioName,
  role,
}: {
  admin: boolean;
  displayName: string;
  studioName: string;
  role: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // PR #230: tapping OUTSIDE the menu dismisses it, like a native
  // dropdown. The listener exists only while the menu is open and
  // checks containment against the root (button + panel), so taps
  // inside the panel (links, Sign out) are untouched, and a tap on
  // the header bell both closes the menu and still navigates. Using
  // pointerdown (not click) so the menu is gone before any tapped
  // element acts, without preventing that element's own behavior.
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

  const close = () => setOpen(false);

  return (
    <div ref={rootRef} className="relative md:hidden">
      <button
        type="button"
        aria-label="Open navigation menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-[44px] cursor-pointer select-none items-center gap-2 rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium dark:border-neutral-700"
      >
        Menu
      </button>
      {open && (
        <nav
          aria-label="Mobile navigation"
          // PR #234: same viewport-fixed sheet treatment as mobile
          // search, so both panels share width, position, and feel.
          className="fixed inset-x-3 top-16 z-40 flex max-h-[75vh] flex-col gap-0.5 overflow-y-auto rounded-lg border border-neutral-200 bg-white p-2 text-sm shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
        >
          {/* PR #231: app-style account panel. Profile/studio block
              on top, then navigation, then account actions. */}
          {/* PR #234: compact identity block. A long email must never
              be the bold headline: when the display name looks like an
              email, lead with "My account" and demote the address to
              small secondary text. */}
          <div className="border-b border-neutral-200 px-3 pb-2 pt-1 dark:border-neutral-800">
            <p className="truncate text-sm font-medium">
              {displayName.includes("@") ? "My account" : displayName}
            </p>
            <p className="truncate text-xs text-neutral-500">
              {studioName} · {role === "owner" ? "Owner" : "Practitioner"}
            </p>
            {displayName.includes("@") && (
              <p className="truncate text-[11px] text-neutral-400">
                {displayName}
              </p>
            )}
          </div>
          {[
            { href: "/dashboard", label: "Dashboard" },
            { href: "/clients", label: "Clients" },
            { href: "/calendar", label: "Calendar" },
            { href: "/records", label: "Records" },
          ].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={close}
              className="flex min-h-[44px] items-center rounded-md px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-900"
            >
              {item.label}
            </Link>
          ))}
          <div className="mt-0.5 flex flex-col gap-0.5 border-t border-neutral-200 pt-1 dark:border-neutral-800">
            {[
              { href: "/settings/profile", label: "Settings" },
              { href: "/getting-started", label: "Getting Started" },
              ...(admin ? [{ href: "/admin", label: "Admin" }] : []),
            ].map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={close}
                className="flex min-h-[44px] items-center rounded-md px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-900"
              >
                {item.label}
              </Link>
            ))}
            <form action={signOut}>
              <button
                type="submit"
                onClick={close}
                className="flex min-h-[44px] w-full items-center rounded-md px-3 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900"
              >
                Sign out
              </button>
            </form>
          </div>
        </nav>
      )}
    </div>
  );
}
