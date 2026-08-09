"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
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

type Props = {
  active: ProfileTab;
};

export function ProfileTabBar({ active }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

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
        className="mt-2 inline-block text-sm font-medium text-neutral-600 underline md:hidden dark:text-neutral-300"
      >
        Treatment Photos →
      </Link>
      {/* md+: the underlined tab row, unchanged from PR #233 (it fits
          in one row on tablet/desktop and never scrolls there). */}
      <div className="hidden gap-x-5 overflow-x-auto whitespace-nowrap [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:flex md:gap-x-6">
        {TABS.map((tab) => {
          const isActive = tab.value === active;
          return (
            <button
              key={tab.value}
              type="button"
              onClick={() => pick(tab.value)}
              disabled={pending && !isActive}
              aria-current={isActive ? "page" : undefined}
              className={`relative min-h-[44px] px-1 pb-3 pt-2 text-sm font-medium transition disabled:opacity-60 ${
                isActive
                  ? "text-neutral-900 dark:text-neutral-100"
                  : "text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
              }`}
            >
              {tab.label}
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
    </nav>
  );
}
