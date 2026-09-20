"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { signOut } from "./dashboard/actions";
import { SignOutMenuItem } from "./SignOutMenuItem";

// PR #231: desktop account dropdown (LinkedIn-style "Me" menu). The
// always-visible Sign out button and the Settings/Admin nav tabs
// move in here, so the primary nav stays Dashboard / Clients /
// Calendar / Records and the right side is bell + account. Same
// dismissal model as MobileMenu: closes on link/action click, on
// Escape, and on any pointerdown outside the root. No library, no
// focus trap (small menu), no new routes.
export function AccountMenu({
  displayName,
  studioName,
  role,
  admin,
  canSwitchStudio,
}: {
  displayName: string;
  studioName: string;
  role: string;
  admin: boolean;
  canSwitchStudio: boolean;
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
  const firstName = displayName.trim().split(/\s+/)[0] || "Account";
  const roleLabel = role === "owner" ? "Owner" : "Practitioner";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="Open account menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-[40px] items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
      >
        <span className="max-w-[12ch] truncate font-medium">{firstName}</span>
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
        <nav
          aria-label="Account menu"
          className="absolute right-0 z-40 mt-2 flex w-64 flex-col gap-0.5 rounded-lg border border-neutral-200 bg-white p-2 text-sm shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
        >
          <div className="border-b border-neutral-200 px-3 pb-2 pt-1 dark:border-neutral-800">
            <p className="font-medium">{displayName}</p>
            <p className="text-xs text-neutral-500">
              {studioName} · {roleLabel}
            </p>
          </div>
          {[
            { href: "/settings/profile", label: "Settings" },
            { href: "/getting-started", label: "Getting Started" },
            ...(canSwitchStudio
              ? [{ href: "/no-access?reason=multiple-studios", label: "Switch studio" }]
              : []),
            ...(admin ? [{ href: "/admin", label: "Admin" }] : []),
          ].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={close}
              className="flex min-h-[40px] items-center rounded-md px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-900"
            >
              {item.label}
            </Link>
          ))}
          <div className="mt-0.5 border-t border-neutral-200 pt-1 dark:border-neutral-800">
            {/* SIGNOUT-01. There is deliberately NO onClick={close} on this
                button, and its absence is load-bearing.

                React flushes a discrete click update synchronously, so closing
                the menu from this button's own handler detached the <form>
                while the click was still propagating — before the submit
                button's activation behaviour ran. The browser then cancelled
                the submission against a disconnected form ("Form submission
                canceled because the form is not connected"), so React's action
                interception never fired and the Server Action never dispatched.
                The panel vanished, which made the press LOOK like it worked,
                while the session, the refresh token and the auth cookie all
                stayed alive.

                Nothing needs to close this menu. signOut() ends the session
                server-side and redirects to /login, which replaces the whole
                authenticated shell — this component with it. Let the real
                logout remove the menu; do not race it.

                The ordinary links above keep onClick={close} because they
                navigate WITHIN the authenticated shell, which persists, so
                they must dismiss the panel themselves.

                Proved by e2e/signout-session-destruction.spec.ts on both
                surfaces, pointer and keyboard; pinned in
                tests/app/mobile-ux.test.ts. */}
            {/* SIGNOUT-02. The control now acknowledges the press: a CSS
                active step that paints before any JS, then `useFormStatus`
                pending -> disabled + aria-busy + "Signing out…" until the real
                action settles. The hook only reports for a form it runs
                INSIDE, which is why this is a leaf and not markup here. No
                onClick, above or below — see the note above. */}
            <form action={signOut}>
              <SignOutMenuItem minHeight="min-h-[40px]" />
            </form>
          </div>
        </nav>
      )}
    </div>
  );
}
