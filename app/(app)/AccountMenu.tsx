"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  // SIGNOUT-02b. The logout's in-flight state is held HERE, on the persistent
  // shell, because the panel below is the thing that unmounts. Escape, an
  // outside pointerdown and the trigger could all dismiss the panel mid-logout,
  // taking the form and its `useFormStatus` with them; reopening then built a
  // fresh, enabled "Sign out" and a second logout went out on the wire.
  //
  // While this is true the panel REFUSES TO CLOSE, which keeps the form mounted
  // and the acknowledgement truthful. It is also handed back down as `busy`, so
  // a leaf that does somehow remount mid-flight still renders as busy rather
  // than inviting a second press.
  const [signingOut, setSigningOut] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // SIGNOUT-02b · ONE dismissal rule, and it is deferred rather than dropped.
  //
  // Every caller inherits it — Escape, the outside pointerdown, the trigger and
  // the panel's own links — because stating it once is what stops the next
  // editor from having to remember it. While a logout is in flight the panel
  // stays mounted, which is what keeps `useFormStatus` alive to report the
  // settlement; the dismissal the practitioner asked for is REMEMBERED and
  // applied the moment the flag clears, so the menu is never left stuck open.
  const deferredClose = useRef(false);
  const close = useCallback(() => {
    if (signingOut) {
      deferredClose.current = true;
      return;
    }
    setOpen(false);
  }, [signingOut]);
  useEffect(() => {
    if (signingOut || !deferredClose.current) return;
    deferredClose.current = false;
    setOpen(false);
  }, [signingOut]);

  // WHILE SIGNING OUT, NO MENU DESTINATION IS AN ANCHOR.
  //
  // Three versions of this were too narrow, each for a reason worth keeping.
  // First `aria-disabled` — advisory, and nothing more. Then `preventDefault`
  // on click — which covers the ordinary click and NOTHING else: a Ctrl/Cmd
  // click, a middle click and "Open link in new tab" all bypass it. Then a
  // hold on `/admin` and `/no-access` only, on the reasoning that those are the
  // links which leave `app/(app)/layout.tsx` and so drop the in-flight flag.
  // Right about CLIENT navigation, wrong about everything else: route-group
  // persistence holds only inside the current browsing context, so ANY link
  // opened into a FRESH DOCUMENT rebuilds the shell with `signingOut === false`
  // and offers another enabled Sign out while the first request is in flight.
  //
  // So the rule is the blunt one: while signing out the menu shows its
  // destinations and offers none of them. There is no href to middle-click, to
  // copy, or to open in a tab. It lasts the few hundred milliseconds the logout
  // takes, and the menu is in a terminal state for all of it.
  //
  // WHAT IT STILL DOES NOT CLOSE, said plainly: a practitioner can open a new
  // tab themselves and sign out there. That path never goes through this menu
  // and cannot be closed from these files — it needs state shared across
  // documents, which is a larger change than this repair is scoped for.
  const isHeld = () => signingOut;

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        close();
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);
  const firstName = displayName.trim().split(/\s+/)[0] || "Account";
  const roleLabel = role === "owner" ? "Owner" : "Practitioner";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="Open account menu"
        aria-expanded={open}
        // Opens freely; closing goes through the one dismissal rule, which
        // defers while a logout is in flight. Never refuses to OPEN, or a
        // stuck flag would leave the menu unreachable.
        onClick={() => (open ? close() : setOpen(true))}
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
            isHeld() ? (
              <span
                key={item.href}
                aria-disabled="true"
                className="flex min-h-[40px] cursor-not-allowed items-center rounded-md px-3 py-2 opacity-50"
              >
                {item.label}
              </span>
            ) : (
              <Link
                key={item.href}
                href={item.href}
                onClick={close}
                className="flex min-h-[40px] items-center rounded-md px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-900"
              >
                {item.label}
              </Link>
            )
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
              <SignOutMenuItem
                minHeight="min-h-[40px]"
                busy={signingOut}
                onPendingChange={setSigningOut}
              />
            </form>
          </div>
        </nav>
      )}
    </div>
  );
}
