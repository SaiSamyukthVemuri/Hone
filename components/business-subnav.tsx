"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  CONTROL_MIN_TOUCH,
  FOCUS_RING,
  UI_TRANSITION,
  cx,
} from "@/components/ui/control-base";

// ===========================================================================
// BUSINESS SUBNAV — the owner's three operating surfaces, in one row
// ===========================================================================
//
// WHY A COMPONENT AND NOT THREE LINKS PER PAGE. Three surfaces now render it
// (/business, /dashboard/capacity, /financials) and a fourth and fifth are
// already named in the roadmap (Demand, Trends). Spelled per page, the active
// rule drifts first and the touch floor second — that is the exact history
// components/ui/control-base.ts was extracted to end.
//
// THE ACTIVE ROUTE IS NEVER COLOUR ALONE. Three cues travel together and any
// one of them is sufficient:
//
//   * `aria-current="page"`, which is what a screen reader announces;
//   * a 2px underline, which is GEOMETRY and survives forced-colors mode,
//     where box-shadow and background are stripped;
//   * a heavier font weight.
//
// A colour-only tab bar is unreadable to roughly one man in twelve, and the
// underline is what makes this legible in Windows High Contrast — the same
// reasoning FOCUS_RING documents for its transparent outline.
//
// NO DIMMING ON PRESS. An earlier Hone tab bar dimmed the tab the owner had
// just tapped while the route resolved, so the destination read as disabled at
// exactly the moment it was chosen, and `aria-current` was left on the tab
// being LEFT. Both are avoided here: the active state is derived from the
// resolved pathname, and pressing a tab changes nothing about its appearance
// beyond the shared UI transition.
//
// EXACT MATCH, NOT PREFIX. `/business` must not light up while the owner is on
// `/business/anything-later`, and `/dashboard/capacity` must never be inferred
// from `/dashboard`. A `startsWith` here would make Overview permanently active
// once a future child route exists.
//
// OVERFLOW IS THE ROW'S PROBLEM, NEVER THE PAGE'S. `overflow-x-auto` on this
// container with `min-w-max` on the list keeps a narrow phone scrolling the
// TABS rather than the document; a page that scrolls sideways is the defect
// this avoids. Three items fit at 320px today, so the scroll is insurance for
// Demand and Trends rather than something an owner meets now.

export type BusinessSubnavItem = {
  readonly href: string;
  readonly label: string;
};

/**
 * The owner's Business surfaces, in the order they are worked.
 *
 * Overview first because it is the domain's front door; Capacity before
 * Financials because "do I have room" precedes "what did it earn" in the
 * question an owner actually asks.
 *
 * DESTINATIONS ARE THE ROUTES THAT EXIST TODAY. `/dashboard/capacity` is NOT
 * renamed to `/business/capacity` in this release: a redirect that exists only
 * to make a nav row tidy is churn, and every bookmark, every search-registry
 * row and every test that names the route would move with it for no owner
 * benefit. The label is the product; the path is an implementation detail.
 */
export const BUSINESS_SUBNAV_ITEMS: readonly BusinessSubnavItem[] = [
  { href: "/business", label: "Overview" },
  { href: "/dashboard/capacity", label: "Capacity" },
  { href: "/financials", label: "Financials" },
] as const;

export function BusinessSubnav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Business"
      // The row scrolls, not the page. See the header note.
      className="-mx-4 overflow-x-auto px-4 md:-mx-8 md:px-8"
    >
      <ul className="flex min-w-max items-stretch gap-1 border-b border-line">
        {BUSINESS_SUBNAV_ITEMS.map((item) => {
          const active = pathname === item.href;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  CONTROL_MIN_TOUCH,
                  FOCUS_RING,
                  UI_TRANSITION,
                  "relative whitespace-nowrap rounded-t-md px-3 text-sm",
                  // Geometry, not colour: a 2px underline sitting on the
                  // container's own border line. `-bottom-px` puts it OVER
                  // that border rather than under it, so the active tab reads
                  // as joined to the panel below.
                  active
                    ? "font-semibold text-fg after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:bg-fg"
                    : "font-medium text-fg-muted hover:text-fg",
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
