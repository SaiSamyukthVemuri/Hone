"use client";

import Link from "next/link";
import { PendingLink } from "@/components/pending-link";
import { usePathname, useRouter } from "next/navigation";

// Settings navigation that renders correctly on phone screens.
//
// The previous layout used a single horizontal `<nav>` with
// overflow-x-auto and whitespace-nowrap, which forced side-scroll on
// mobile once the tab count grew past ~5. With Launch + Intake &
// Postcare + the owner-only tabs there are 11 items, well past the
// fit-on-phone budget.
//
// This component renders two surfaces from the same data:
//   - md: horizontal tab bar with bottom-border active state.
//   - <md: native <select> jumping straight to the selected tab.
//
// Routes are unchanged. No new behavior. The component is a thin
// `<Link>` / native-select wrapper; no state, no fetching, no
// mutation.

export type SettingsNavItem = {
  href: string;
  label: string;
};

type Props = {
  items: ReadonlyArray<SettingsNavItem>;
};

export function SettingsNav({ items }: Props) {
  const pathname = usePathname() ?? "";
  const router = useRouter();

  // Active match: prefer an exact match, then fall back to longest
  // prefix so /settings/payments/return is considered "Payments".
  const active =
    items.find((i) => i.href === pathname)?.href ??
    items
      .filter((i) => pathname.startsWith(`${i.href}/`))
      .sort((a, b) => b.href.length - a.href.length)[0]?.href ??
    items[0]?.href;

  return (
    <div className="mt-6 border-b border-neutral-200 dark:border-neutral-800">
      {/* Mobile: native select. Same items, same hrefs. */}
      <div className="px-5 pb-3 md:hidden">
        <label htmlFor="settings-nav-select" className="sr-only">
          Settings section
        </label>
        <select
          id="settings-nav-select"
          value={active ?? ""}
          onChange={(e) => router.push(e.target.value)}
          className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-800 focus:border-neutral-900 focus:outline-none dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200"
        >
          {items.map((i) => (
            <option key={i.href} value={i.href}>
              {i.label}
            </option>
          ))}
        </select>
      </div>

      {/* Desktop / tablet: horizontal tab bar with active state. */}
      <nav
        aria-label="Settings sections"
        className="hidden md:flex md:flex-wrap md:items-center md:gap-x-1"
      >
        {items.map((i) => {
          const isActive = i.href === active;
          return (
            <PendingLink
              key={i.href}
              href={i.href}
              pendingLabel="Loading settings…"
              aria-current={isActive ? "page" : undefined}
              className={`-mb-px whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium transition ${
                isActive
                  ? "border-neutral-900 text-neutral-900 dark:border-neutral-100 dark:text-neutral-100"
                  : "border-transparent text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
              }`}
            >
              {i.label}
            </PendingLink>
          );
        })}
      </nav>
    </div>
  );
}
