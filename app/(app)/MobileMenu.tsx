"use client";

import { useEffect, useState } from "react";
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
}: {
  admin: boolean;
  displayName: string;
  studioName: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div className="relative md:hidden">
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
          className="absolute right-0 z-40 mt-2 flex w-60 flex-col gap-0.5 rounded-lg border border-neutral-200 bg-white p-2 text-sm shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
        >
          {[
            { href: "/dashboard", label: "Dashboard" },
            { href: "/clients", label: "Clients" },
            { href: "/calendar", label: "Calendar" },
            { href: "/records", label: "Records" },
            { href: "/settings/profile", label: "Settings" },
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
          <div className="mt-1 border-t border-neutral-200 pt-2 dark:border-neutral-800">
            <p className="px-3 pb-1 text-xs text-neutral-500">
              {displayName} · {studioName}
            </p>
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
