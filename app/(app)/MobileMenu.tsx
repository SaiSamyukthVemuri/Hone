"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOut } from "./dashboard/actions";
import { SignOutMenuItem } from "./SignOutMenuItem";
import { useSignOutInFlight } from "./signout-flight";
import { SignOutFlightReporter } from "./SignOutFlightReporter";
import { cx, PRESS_TRANSITION } from "@/components/ui/control-base";
import { spinnerClasses } from "@/components/ui/spinner";

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
  canSwitchStudio,
}: {
  admin: boolean;
  displayName: string;
  studioName: string;
  role: string;
  canSwitchStudio: boolean;
}) {
  const [open, setOpen] = useState(false);
  // SIGNOUT-02c. The in-flight flag is NOT owned here any more. Both shells are
  // rendered on every page and hidden with CSS, so a per-shell `useState` made
  // this per-shell rather than per-practitioner: crossing the `lg` breakpoint
  // mid-logout revealed the other menu with its own flag still false, and a
  // fresh enabled Sign out with it. One authority, read by both.
  const signingOut = useSignOutInFlight();
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
        close();
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);

  // ---- NAV-ACK-01 · DESIGN.md contract 2d -----------------------------------
  //
  // WHY NOT `PendingLink` HERE. `useLinkStatus` must run inside the <Link> that
  // owns the navigation (components/pending-link.tsx). The panel above is
  // `{open && ...}` and every link closes it, so that subtree is unmounted by
  // the same click that starts the navigation: contract 2c can paint nothing at
  // all here, and would do so SILENTLY — it compiles and ships.
  //
  // So the acknowledgement is hosted on the trigger, which lives OUTSIDE the
  // `open` guard and therefore survives. The panel still closes exactly as it
  // did (the PR #229 contract above, including the current-page link).
  //
  // Deliberately spelled out here and in GlobalSearch rather than lifted into a
  // shared primitive: a product-wide navigation vocabulary is UX-03, which is
  // NOT adopted. Two named surfaces, two local copies, by decision.
  const router = useRouter();
  const [navPending, startNav] = useTransition();
  const [navLabel, setNavLabel] = useState<string | null>(null);
  const navLockRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // The lock is released on the pending EDGE, never by a timer. React settles a
  // transition on success, on failure and on a same-route no-op alike, so there
  // is no path that leaves the acknowledgement armed — which is what makes the
  // current-page tap safe without predicting whether a route change will occur.
  useEffect(() => {
    if (!navPending) navLockRef.current = false;
  }, [navPending]);

  function navigate(
    e: React.MouseEvent<HTMLAnchorElement>,
    href: string,
    label: string,
  ) {
    // Ordinary link semantics belong to the browser. Anything that is not a
    // plain primary-button press — open in new tab/window, download, context
    // menu — must reach the real `href` untouched. That is why these stay
    // <Link>s with a real href and an intercepted click, and not buttons.
    if (
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    ) {
      return;
    }
    // One navigation per activation. The panel unmounts on the first press, so
    // the only way to press twice is a double-tap delivering two clicks before
    // React commits — which `navPending` cannot catch, because it does not turn
    // true until the next render. A ref can.
    if (navLockRef.current) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    setNavLabel(label);
    close();
    // Focus moves BEFORE the panel unmounts, so it is never left on a detached
    // node and never falls to <body>. The trigger is always mounted.
    triggerRef.current?.focus();
    // THE CURRENT-PAGE TAP. React holds a transition pending until it COMMITS,
    // and a push to the URL we are already on never produces one — measured:
    // the mark stayed up for a full 30s timeout. That is exactly how a
    // permanent busy state happens, so the no-op is detected by comparing the
    // resolved target with the current location, which is exact rather than a
    // guess about router behaviour.
    //
    // The panel still closes (the PR #229 contract), focus has already moved,
    // and nothing is armed: there is no navigation to acknowledge, and painting
    // progress for a navigation that is not happening is the thing PERF-UX-01
    // forbids.
    const target = new URL(href, window.location.href);
    const samePage =
      target.pathname === window.location.pathname &&
      target.search === window.location.search;
    // A HASH-ONLY CHANGE IS STILL A NAVIGATION. The navigation registry ships
    // 34 anchored destinations (`/settings/booking#buffer`,
    // `/settings/profile#calendar-feed`, …), so "already on this page" and
    // "nothing to do" are NOT the same question. Comparing only pathname +
    // search treats an anchor jump from the page it targets as a no-op and
    // returns here — after preventDefault() — which closes the panel, never
    // scrolls to the control and never updates the URL. The press would then
    // do nothing at all, which is a worse LAW 4 failure than the silent
    // acknowledgement this ticket exists to repair.
    //
    // It is pushed, but deliberately NOT armed: an in-page anchor jump commits
    // synchronously, so there is no pending interval to acknowledge, and
    // painting progress for it is exactly what PERF-UX-01 forbids. Arming it
    // would also risk the permanent busy state described above, since a
    // hash-only push need not produce a transition commit.
    if (samePage && target.hash !== window.location.hash) {
      router.push(href);
      return;
    }
    if (samePage) {
      return;
    }
    navLockRef.current = true;
    startNav(() => {
      router.push(href);
    });
  }

  return (
    // `lg:hidden`, matching the three header-mode classes in layout.tsx: the
    // compact shell owns every width below 1024px, where five primary items
    // plus search/bell/account could not fit on one line.
    <div ref={rootRef} className="relative lg:hidden">
      {/* SIGNOUT-02c · THE FORM LIVES OUT HERE, not in the sheet.
          `useFormStatus` reports only for the form it runs inside, so the
          observer has to be in the form — and a form inside `{open && …}` is
          taken down by the very dismissals this slice had to survive. Hoisted
          to the persistent root it cannot be unmounted by closing the sheet or
          crossing the breakpoint.

          `action={signOut}` is UNCHANGED, deliberately. Wrapping it in a client
          function to own the promise was tried twice and measured wrong: Next
          stops routing the action's redirect and the soft navigation to /login
          becomes a hard browser one, tearing down in-flight prefetches and
          reddening five SIGNOUT-01 cases whose logouts were otherwise perfect. */}
      <form action={signOut} id="signout-mobile" className="hidden">
        <SignOutFlightReporter />
      </form>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Open navigation menu"
        aria-expanded={open}
        // Opens freely; closing goes through the one dismissal rule, which
        // defers while a logout is in flight. Never refuses to OPEN, or a
        // stuck flag would leave the menu unreachable.
        onClick={() => (open ? close() : setOpen(true))}
        // `relative` is owned here: the mark is absolutely positioned so the
        // trigger cannot change width mid-navigation.
        className="relative flex min-h-[44px] cursor-pointer select-none items-center gap-2 rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium dark:border-neutral-700"
      >
        {/* `opacity-0`, not `hidden`: the box is kept so the control cannot
            resize, and the accessible name is `aria-label` above, so it does
            not depend on this text either way. */}
        <span className={cx(PRESS_TRANSITION, navPending && "opacity-0")}>
          Menu
        </span>
        {navPending && (
          <span
            data-nav-pending="true"
            aria-hidden="true"
            className={cx(
              "pointer-events-none absolute inset-0 m-auto",
              spinnerClasses("sm"),
            )}
          />
        )}
      </button>
      {/* MOUNTED AT ALL TIMES, empty at rest; only the TEXT changes. A
          role="status" inserted already containing its message is not reliably
          announced. The mark above is aria-hidden, so this is the ONE voice —
          no double announcement. */}
      <span role="status" className="sr-only">
        {navPending && navLabel ? `Opening ${navLabel}…` : ""}
      </span>
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
            // OWNER-CAP follow-up: the owner's permanent Business entry, the
            // phone half of the desktop tab in layout.tsx. It belongs HERE, in
            // the working-surface section, and not below the divider with
            // Settings / Getting Started / Admin: Business is somewhere the
            // owner works, not an account preference.
            //
            // Gated on the `role` this component is ALREADY given — no second
            // authority query, and nothing rendered-but-disabled for a
            // practitioner, who simply has no such item. The presentation gate
            // is not the boundary: /dashboard/capacity keeps its own
            // server-side owner check.
            ...(role === "owner"
              ? [{ href: "/dashboard/capacity", label: "Business" }]
              : []),
          ].map((item) => (
            isHeld() ? (
              <span
                key={item.href}
                aria-disabled="true"
                className="flex min-h-[44px] cursor-not-allowed items-center rounded-md px-3 py-2 opacity-50"
              >
                {item.label}
              </span>
            ) : (
              <Link
                key={item.href}
                href={item.href}
                onClick={(e) => navigate(e, item.href, item.label)}
                className="flex min-h-[44px] items-center rounded-md px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-900"
              >
                {item.label}
              </Link>
            )
          ))}
          <div className="mt-0.5 flex flex-col gap-0.5 border-t border-neutral-200 pt-1 dark:border-neutral-800">
            {[
              { href: "/settings/profile", label: "Settings" },
              { href: "/getting-started", label: "Getting Started" },
              ...(canSwitchStudio
                ? [
                    {
                      href: "/no-access?reason=multiple-studios",
                      label: "Switch studio",
                    },
                  ]
                : []),
              ...(admin ? [{ href: "/admin", label: "Admin" }] : []),
            ].map((item) => (
              isHeld() ? (
                <span
                  key={item.href}
                  aria-disabled="true"
                  className="flex min-h-[44px] cursor-not-allowed items-center rounded-md px-3 py-2 opacity-50"
                >
                  {item.label}
                </span>
              ) : (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={(e) => navigate(e, item.href, item.label)}
                  className="flex min-h-[44px] items-center rounded-md px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-900"
                >
                  {item.label}
                </Link>
              )
            ))}
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

                The ordinary links above still dismiss the panel themselves,
                because they navigate WITHIN the authenticated shell, which
                persists. Since NAV-ACK-01 they do that inside navigate(),
                which calls close() — but only AFTER preventDefault() has taken
                the activation away from the browser, so the push is issued
                programmatically and no longer depends on the <Link>'s own DOM
                node surviving the click. That is precisely why unmounting a
                link mid-click is safe here while unmounting this <form> was
                not: a submit button's activation behaviour DOES depend on its
                node still being connected. Do not "simplify" the two into one
                rule.

                Proved by e2e/signout-session-destruction.spec.ts on both
                surfaces, pointer and keyboard; pinned in
                tests/app/mobile-ux.test.ts. */}
            {/* SIGNOUT-02. Same leaf, same mechanism, the phone's own 44px
                row. The press step matters MORE here than on the desktop: a
                touch device never fires :hover, so before this the tap painted
                literally nothing for the ~530ms until the shell was replaced. */}
              <SignOutMenuItem
                formId="signout-mobile"
                minHeight="min-h-[44px]"
                busy={signingOut}
              />
          </div>
        </nav>
      )}
    </div>
  );
}
