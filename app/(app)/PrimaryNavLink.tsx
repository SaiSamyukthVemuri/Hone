"use client";

import { usePathname } from "next/navigation";
import { PendingLink } from "@/components/pending-link";
import { cx } from "@/components/ui/control-base";
import type { ReactNode } from "react";

// UX-01 QW2 · "you are here", on the existing primary navigation.
//
// THE DEFECT. The shell answered "your press registered" — NAV-ACK-02 routed
// every anchor through `PendingLink` — and never answered "where am I". There
// was no `aria-current` anywhere in `app/(app)/layout.tsx` and no active paint,
// on the one navigation present on every authenticated page. Acknowledgement
// and identity are different axes and #736 only supplied the first.
//
// WHAT THIS IS NOT. No navigation provider, no context, no global
// route-progress, no tab primitive, no shared state. It is the same five links
// the shell already rendered, each deriving its own active state from the
// pathname it can already see. UX-03 Navigation Identity — one tab/segment
// primitive, retiring the seven dialects — remains PROPOSED and NOT SCHEDULED,
// and nothing here reaches for it.
//
// WHY A CLIENT LEAF AT ALL. `layout.tsx` is a server component and the App
// Router gives a server component no pathname. The alternative was to have
// middleware stamp the path into a request header and read it with `headers()`
// — which keeps the anchors in the shell but puts a presentation concern in the
// authentication path, on every request. A client leaf that reads
// `usePathname` is the smaller blast radius, and these anchors already hydrate:
// `PendingLink` is itself a client component, so no new boundary is created
// here, only a smaller one moved.
//
// MATCHING IS EXPLICIT, because prefixes alone get it wrong. `/dashboard` and
// `/dashboard/capacity` are two DIFFERENT nav entries — Dashboard and Business
// — so a naive "pathname starts with href" marks both current on the capacity
// page. Dashboard therefore matches exactly while every other section matches
// its subtree, which is what makes `/clients/<id>` keep Clients lit.

export type NavMatch = "exact" | "section";

/**
 * Is `href` the current section for `pathname`?
 *
 * `"section"` deliberately requires a `/` boundary rather than a bare
 * `startsWith`: without it `/records` would also claim `/records-archive`, a
 * sibling route that merely shares a prefix.
 */
export function isCurrentSection(
  pathname: string | null,
  href: string,
  match: NavMatch,
): boolean {
  if (!pathname) return false;
  if (pathname === href) return true;
  if (match === "exact") return false;
  return pathname.startsWith(`${href}/`);
}

/** The resting shell-nav anchor, unchanged from what the shell already used. */
const NAV_LINK_BASE = "rounded-md px-3 py-2";

/**
 * The section you are IN.
 *
 * Marked by GROUND and INK, never by weight. The primary nav is a horizontal
 * row, so a `font-medium` active state changes that item's advance width and
 * shifts every sibling sideways the moment you change page. Fill and colour
 * carry the same meaning and reflow nothing.
 *
 * `text-neutral-900` on `bg-neutral-100` measures ≈16.4:1 — the state is a
 * contrast INCREASE, which is the opposite of the day-nav inversion QW1
 * repaired, and it is a shape change rather than colour alone because the fill
 * appears.
 */
const NAV_LINK_CURRENT = "bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100";
const NAV_LINK_IDLE = "hover:bg-neutral-100 dark:hover:bg-neutral-900";

export function PrimaryNavLink({
  href,
  match = "section",
  pendingLabel,
  testId,
  children,
}: {
  href: string;
  match?: NavMatch;
  pendingLabel: string;
  testId: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const current = isCurrentSection(pathname, href, match);
  return (
    <PendingLink
      href={href}
      data-testid={testId}
      pendingLabel={pendingLabel}
      // `aria-current="page"` is the whole semantic payload. It is set ONLY on
      // the current section, never on the others, so exactly one anchor in this
      // nav ever claims it.
      aria-current={current ? "page" : undefined}
      className={cx(NAV_LINK_BASE, current ? NAV_LINK_CURRENT : NAV_LINK_IDLE)}
    >
      {children}
    </PendingLink>
  );
}
