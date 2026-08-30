"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { PRESS_TRANSITION, cx } from "./ui/control-base";
import type { ProfileTab } from "./profile-tab";

// Tab order matches Chloe's mental model after the launch retest:
// Overview, Sessions, Treatment Plans, Health & Forms, Personal Notes.
// "Sessions" and "Treatment Plans" were split out of the previous
// combined tab; the new "sessions" URL value holds per-visit history
// and the existing "treatment" URL value now holds plans only. Old
// /clients/[id]?tab=treatment deep links still land on a valid tab
// (Treatment Plans). "Health & Forms" is a rename of the prior
// "Health" tab; URL value unchanged so deep links survive.
const TABS: ReadonlyArray<{ value: ProfileTab; label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "sessions", label: "Sessions" },
  { value: "treatment", label: "Treatment Plans" },
  { value: "messages", label: "Messages" },
  { value: "health", label: "Health & Forms" },
  // LABEL ONLY. The tab VALUE stays "consultation": it is the ?tab= query
  // parameter, and existing deep links (the appointment consultation CTA, the
  // Overview cards) plus their tests depend on it. Chloe could not tell that
  // skin/hair analysis lived behind a tab named only "Consultation".
  { value: "consultation", label: "Consultation & Skin/Hair" },
  { value: "personal", label: "Personal Notes" },
];

/**
 * The in-flight mark, and why this is a COPY rather than an import (UI-01D).
 *
 * components/pending-link.tsx spells this same vocabulary for the <Link> forms
 * and says it should be spelled once. It cannot be shared from there: that file
 * is closed by tests/components/pending-link.test.ts, which pins its export
 * surface at exactly two forms and asserts it contains no `useState`,
 * `useEffect` or `useTransition`. Widening it to serve a control that is NOT a
 * link — and that owns navigation state — would weaken a guard with a real
 * stated purpose. The tab bar keeps its own copy instead, and the two stay in
 * step because both are pinned by their own tests.
 *
 * A ring drawn in `border`, not a box-shadow: forced-colors mode (Windows High
 * Contrast) forces `box-shadow: none` and would erase a shadow-drawn mark,
 * while a border is repainted in a system colour. Reduced motion keeps the mark
 * and drops only the rotation, so the state change survives as a shape rather
 * than as colour alone.
 */
const PENDING_MARK =
  "size-4 animate-spin rounded-full border-2 border-current border-t-transparent " +
  "motion-reduce:animate-none motion-reduce:border-t-current";

type Props = {
  active: ProfileTab;
};

export function ProfileTabBar({ active }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  // WHICH tab was asked for. Recorded on the tap, never rendered directly.
  const [requested, setRequested] = useState<ProfileTab | null>(null);

  // The pending target is DERIVED, and that is the whole correctness argument.
  //
  // `requested` is only ever read through this gate, so React's own transition
  // lifecycle is the single source of truth for "is a navigation in flight".
  // Three properties fall out of that and need no cleanup code:
  //
  //   * a settled transition — committed, superseded, or failed into the route
  //     error boundary — flips `pending` to false, and the mark disappears with
  //     it. There is no timer, no listener and no abort bookkeeping to get
  //     wrong;
  //   * a second tap simply overwrites `requested`, so exactly one mark can
  //     ever be on screen and it is always the newest request;
  //   * a stale `requested` left over from a finished navigation is unreadable
  //     by construction, because `pending` is false.
  const pendingTab = pending ? requested : null;
  const pendingLabel =
    TABS.find((tab) => tab.value === pendingTab)?.label ?? null;

  function pick(next: ProfileTab) {
    if (next === active) return;
    const params = new URLSearchParams(searchParams.toString());
    if (next === "overview") {
      params.delete("tab");
    } else {
      params.set("tab", next);
    }
    const qs = params.toString();
    const url = qs ? `${pathname}?${qs}` : pathname;
    setRequested(next);
    startTransition(() => {
      router.push(url, { scroll: true });
    });
  }

  return (
    <nav
      aria-label="Client profile sections"
      className="border-b border-neutral-200 pb-3 dark:border-neutral-800 md:pb-0"
    >
      {/* PR #238 (Chloe pilot): on phones the one-row scroller from
          PR #233 still moved under the finger and felt unstable, so
          mobile gets a plain native select instead: the active
          section is always visible, nothing drags, and all six
          sections are one tap away. text-base keeps iOS from
          auto-zooming the focused control. Same pick() handler and
          URL behavior; no business logic change. */}
      <label className="flex flex-col gap-1 md:hidden">
        <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
          Section
        </span>
        <select
          value={active}
          disabled={pending}
          onChange={(e) => pick(e.target.value as ProfileTab)}
          className="min-h-[44px] w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-base font-medium outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        >
          {TABS.map((tab) => (
            <option key={tab.value} value={tab.value}>
              {tab.label}
            </option>
          ))}
        </select>
      </label>
      {/* PR #272: Treatment Photos lives on its own route
          (/clients/[id]/images). Surface it as a tab-level link instead of
          burying it under Health & Forms. Mobile: a link under the section
          select; md+: a tab-styled link at the end of the row. */}
      <Link
        href={`${pathname}/images`}
        className="mt-2 inline-flex items-center min-h-[44px] min-w-[44px] text-sm font-medium text-neutral-600 underline md:hidden dark:text-neutral-300"
      >
        Treatment Photos →
      </Link>
      {/* md+: the underlined tab row, unchanged from PR #233 (it fits
          in one row on tablet/desktop and never scrolls there). */}
      <div className="hidden gap-x-5 overflow-x-auto whitespace-nowrap [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:flex md:gap-x-6">
        {TABS.map((tab) => {
          const isActive = tab.value === active;
          const isPendingTarget = tab.value === pendingTab;
          return (
            <button
              key={tab.value}
              type="button"
              onClick={() => pick(tab.value)}
              // NOT disabled while a navigation is in flight (UI-01D).
              //
              // It used to be `disabled={pending && !isActive}`, which painted
              // the tab the practitioner had just TAPPED — and the five they
              // had not — in the disabled vocabulary, while the tab they were
              // LEAVING stayed lit. The only thing that changed on screen was
              // that every destination went grey.
              //
              // Disabling a control mid-flight is a double-submit guard, and it
              // buys nothing here: a tab change writes no clinical, payment or
              // booking state, so a second tap is free. It also cost a real
              // keyboard defect — a browser blurs an element the moment it
              // becomes disabled, so pressing Enter on a tab dropped focus to
              // <body> and Tab restarted from the top of the page.
              aria-current={isActive ? "page" : undefined}
              // The pending target says only that ITS request is in flight.
              // `aria-current` is untouched by it and still moves on commit, so
              // no tab is ever announced as current before it is.
              aria-busy={isPendingTarget || undefined}
              className={`relative min-h-[44px] px-1 pb-3 pt-2 text-sm font-medium transition ${
                isActive
                  ? "text-neutral-900 dark:text-neutral-100"
                  : "text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
              }`}
            >
              {/* `opacity-0`, never `invisible`/`hidden`: visibility:hidden
                  would pull the label out of the accessibility tree and the
                  button's accessible name would collapse to nothing mid-flight.
                  Opacity keeps both the box and the name, so the tab cannot
                  resize and never loses its meaning. */}
              <span
                className={cx(PRESS_TRANSITION, isPendingTarget && "opacity-0")}
              >
                {tab.label}
              </span>
              {/* Centred over the faded label, absolutely positioned, so the
                  tab's width and the row's scroll position do not move when a
                  navigation starts. Decorative — the sentence a screen reader
                  gets is the live region below, not this. */}
              {isPendingTarget && (
                <span
                  aria-hidden="true"
                  className={cx(
                    "pointer-events-none absolute inset-0 m-auto",
                    PENDING_MARK,
                  )}
                />
              )}
              <span
                aria-hidden
                className={`absolute -bottom-px left-0 right-0 h-0.5 ${
                  isActive ? "bg-neutral-900 dark:bg-neutral-100" : "bg-transparent"
                }`}
              />
            </button>
          );
        })}
        <Link
          href={`${pathname}/images`}
          className="relative min-h-[44px] px-1 pb-3 pt-2 text-sm font-medium text-neutral-500 transition hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          Treatment Photos
        </Link>
      </div>
      {/* MOUNTED AT ALL TIMES; only its TEXT changes.
          A polite live region has to exist before its content changes — a
          role="status" node inserted already holding its message is not
          reliably announced. Empty at rest, so it adds nothing to any control's
          accessible name until there is something to say. It describes the
          REQUEST and never the outcome ("Opening…", not "Opened"), and it is
          the only pending signal a screen-reader user gets, since the mark is
          aria-hidden. One region serves both controls: the desktop tab row and
          the mobile select run through the same pick(). `sr-only` is
          position:absolute, so it is out of flow. */}
      <span role="status" className="sr-only">
        {pendingLabel ? `Opening ${pendingLabel}…` : ""}
      </span>
    </nav>
  );
}
